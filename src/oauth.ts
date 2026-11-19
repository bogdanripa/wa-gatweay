import { createHash, randomBytes } from "node:crypto";
import express, { Router, type Request, type Response } from "express";
import { API_PREFIX, config } from "./config.js";
import { logger } from "./log.js";
import type { OAuthGrantDoc, Stores } from "./store.js";
import type { SessionManager } from "./sessions.js";
import { NotFoundError, ValidationError } from "./sessionStore.js";
import { digitsOf } from "./jid.js";
import { isAllowedRedirectUri, pkceMatches, redirectWith } from "./oauthRules.js";

/**
 * OAuth 2.1 for `/api/mcp`, as the MCP authorization spec lays it out: this
 * gateway is both the protected resource and its own authorization server.
 *
 * The person approving is the operator, and the only credential the operator
 * has is the management key — so "signing in" is the management key, typed (or
 * already remembered by the console) on `/authorize.html`, a static page on
 * this same origin. That page talks to the management API, which is what
 * actually issues the code: the key never goes to the assistant, and the
 * assistant never sees anything but a token scoped to one number.
 *
 * Everything lives under `/api`, because Pironman routes nothing else to this
 * container. The two discovery hops survive that:
 *
 * - The resource metadata URL is handed to the client in the 401's
 *   `WWW-Authenticate` header, so its location is ours to choose.
 * - For an issuer with a path (`https://host/api`) the client's third
 *   fallback is OIDC-style `https://host/api/.well-known/openid-configuration`,
 *   which is why there is an OIDC-shaped document here at all — see
 *   `oidcMetadata`.
 *
 * A client that has to rediscover without a fresh 401 (a refresh in a new
 * process, say) starts from the ROOT well-known paths instead, which belong to
 * the static site. A platform redirect rule, `/.well-known/*` →
 * `/api/.well-known/:splat`, sends those here, and the routes below answer at
 * the mirrored paths (`…/oauth-protected-resource/api/mcp` and so on). Without
 * that rule such a client concludes the origin itself is the authorization
 * server, discards its registration, and fails. `dev/serve.mjs` mirrors it.
 *
 * Clients are public (no secret) and must use PKCE S256. Registration is open
 * (RFC 7591), because every MCP client registers itself on first connect; it
 * grants nothing until someone with the management key approves a request.
 */

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 90 * 24 * 3600;
const CODE_TTL_S = 300;
const REQUEST_TTL_S = 600;
const SCOPE = "whatsapp";

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const after = (seconds: number) => new Date(Date.now() + seconds * 1000);

/** The public origin, from config — the thing every URL in a discovery document is built from. */
function origin(req: Request): string {
    return config.publicUrl || `${req.protocol}://${req.get("host")}`;
}

export const issuerOf = (req: Request) => `${origin(req)}${API_PREFIX}`;
export const mcpResourceOf = (req: Request) => `${origin(req)}${API_PREFIX}/mcp`;
export const resourceMetadataUrlOf = (req: Request) => `${origin(req)}${API_PREFIX}/.well-known/oauth-protected-resource`;

class OAuthError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly status = 400
    ) {
        super(message);
    }
}

export class OAuthService {
    constructor(
        private stores: Stores,
        private manager: SessionManager
    ) {}

    // ------------------------------------------------------------ resource side

    /** The number an access token acts as, or null. A number whose MCP was switched off answers null too. */
    async sessionForAccessToken(token: string) {
        if (!token) return null;
        const grant = await this.stores.oauthGrants.findOne({ _id: hash(token), kind: "access" });
        if (!grant?.sessionId || grant.expiresAt.getTime() <= Date.now()) return null;
        const session = this.manager.byIdOrNull(grant.sessionId);
        return session?.mcpEnabled ? session : null;
    }

    /** Assistants currently connected to a number: one per approval, however often it has refreshed. */
    async connectedClients(sessionId: string) {
        const refresh = await this.stores.oauthGrants
            .find({ sessionId, kind: "refresh", expiresAt: { $gt: new Date() } })
            .sort({ approvedAt: 1 })
            .toArray();
        return refresh.map((g) => ({
            name: g.clientName || "Unnamed client",
            approvedAt: g.approvedAt,
            // Refresh rotates, so the newest refresh token's birth is the last time it came back.
            lastSeenAt: g.createdAt,
        }));
    }

    async disconnectAll(sessionId: string): Promise<number> {
        const r = await this.stores.oauthGrants.deleteMany({ sessionId });
        logger.warn({ session: sessionId, grants: r.deletedCount }, "MCP assistants disconnected");
        return r.deletedCount;
    }

    // ---------------------------------------------------------- registration

    async register(body: any) {
        const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.map(String) : [];
        if (!uris.length || uris.length > 10) {
            throw new OAuthError("invalid_redirect_uri", "redirect_uris must list 1-10 URIs");
        }
        const bad = uris.find((u: string) => !isAllowedRedirectUri(u));
        if (bad) {
            throw new OAuthError(
                "invalid_redirect_uri",
                `${bad} is not allowed: use https, or http on localhost/127.0.0.1`
            );
        }
        const clientName = body?.client_name ? String(body.client_name).slice(0, 100) : undefined;
        const clientId = secret();
        const now = new Date();
        await this.stores.oauthClients.insertOne({
            _id: clientId,
            clientName,
            redirectUris: uris,
            createdAt: now,
            lastUsedAt: now,
        });
        logger.info({ client: clientName }, "OAuth client registered");
        return {
            client_id: clientId,
            client_id_issued_at: Math.floor(now.getTime() / 1000),
            ...(clientName ? { client_name: clientName } : {}),
            redirect_uris: uris,
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            // Whatever was asked for: there are no secrets here, PKCE is the proof.
            token_endpoint_auth_method: "none",
        };
    }

    // ---------------------------------------------------------- authorization

    /**
     * Validate an authorization request and park it for the operator to
     * approve. Returns where to send the browser. Problems with the client or
     * redirect URI are thrown as `OAuthError` and shown, never redirected —
     * redirecting to an unverified URI is how open redirectors are made.
     */
    async beginAuthorization(q: Record<string, unknown>, req: Request): Promise<string> {
        const clientId = String(q.client_id || "");
        const client = clientId ? await this.stores.oauthClients.findOne({ _id: clientId }) : null;
        if (!client) throw new OAuthError("invalid_client", "unknown client_id — the assistant has to register again");

        let redirectUri = q.redirect_uri ? String(q.redirect_uri) : "";
        if (!redirectUri && client.redirectUris.length === 1) redirectUri = client.redirectUris[0];
        if (!client.redirectUris.includes(redirectUri)) {
            throw new OAuthError("invalid_request", "redirect_uri does not match the one this client registered");
        }

        // From here on errors go back to the client, as the spec has it.
        const state = q.state !== undefined ? String(q.state) : undefined;
        const back = (error: string, description: string) =>
            redirectWith(redirectUri, { error, error_description: description, state, iss: issuerOf(req) });

        if (q.response_type !== "code") return back("unsupported_response_type", "only response_type=code");
        const challenge = String(q.code_challenge || "");
        if (!challenge || q.code_challenge_method !== "S256") {
            return back("invalid_request", "PKCE with code_challenge_method=S256 is required");
        }
        if (q.resource !== undefined && String(q.resource).replace(/\/$/, "") !== mcpResourceOf(req)) {
            return back("invalid_target", `the only resource here is ${mcpResourceOf(req)}`);
        }

        const requestId = secret();
        await this.stores.oauthGrants.insertOne({
            _id: hash(requestId),
            kind: "request",
            clientId,
            clientName: client.clientName,
            redirectUri,
            codeChallenge: challenge,
            state,
            scope: SCOPE,
            expiresAt: after(REQUEST_TTL_S),
            createdAt: new Date(),
        });
        return `${origin(req)}/authorize.html?request=${encodeURIComponent(requestId)}`;
    }

    private async pendingRequest(requestId: string): Promise<OAuthGrantDoc> {
        const r = await this.stores.oauthGrants.findOne({ _id: hash(String(requestId || "")), kind: "request" });
        if (!r || r.expiresAt.getTime() <= Date.now()) {
            throw new NotFoundError("this sign-in request has expired or was already answered — start again from the assistant");
        }
        return r;
    }

    /** What the approval page shows: who is asking, where they go back to, and which numbers can be picked. */
    async describeRequest(requestId: string) {
        const r = await this.pendingRequest(requestId);
        return {
            client: { name: r.clientName || "An unnamed application", redirectHost: new URL(r.redirectUri).host },
            numbers: this.manager.all().map((s) => ({
                id: s.id,
                name: s.me?.name,
                phone: s.me?.id ? digitsOf(s.me.id) : undefined,
                status: s.status,
                mcpEnabled: s.mcpEnabled,
            })),
        };
    }

    async approve(requestId: string, sessionId: string, req: Request): Promise<string> {
        const r = await this.pendingRequest(requestId);
        const session = this.manager.byIdOrNull(String(sessionId || "").toLowerCase());
        if (!session) throw new ValidationError("pick a number");
        if (!session.mcpEnabled) {
            throw new ValidationError(`MCP access is off for "${session.id}" — turn it on in the console first`);
        }
        // Single use: whoever deletes it first answers it.
        const taken = await this.stores.oauthGrants.findOneAndDelete({ _id: r._id, kind: "request" });
        if (!taken) throw new NotFoundError("this sign-in request was already answered");

        const code = secret();
        await this.stores.oauthGrants.insertOne({
            _id: hash(code),
            kind: "code",
            clientId: r.clientId,
            clientName: r.clientName,
            sessionId: session.id,
            redirectUri: r.redirectUri,
            codeChallenge: r.codeChallenge,
            scope: r.scope,
            expiresAt: after(CODE_TTL_S),
            createdAt: new Date(),
        });
        logger.warn({ session: session.id, client: r.clientName }, "MCP assistant approved");
        return redirectWith(r.redirectUri, { code, state: r.state, iss: issuerOf(req) });
    }

    async deny(requestId: string, req: Request): Promise<string> {
        const r = await this.pendingRequest(requestId);
        await this.stores.oauthGrants.deleteOne({ _id: r._id });
        logger.info({ client: r.clientName }, "MCP assistant denied");
        return redirectWith(r.redirectUri, {
            error: "access_denied",
            error_description: "the request was declined",
            state: r.state,
            iss: issuerOf(req),
        });
    }

    // ------------------------------------------------------------------ tokens

    async token(body: Record<string, unknown>) {
        const grantType = String(body.grant_type || "");
        const clientId = String(body.client_id || "");
        if (!clientId) throw new OAuthError("invalid_client", "client_id is required", 401);
        const client = await this.stores.oauthClients.findOne({ _id: clientId });
        if (!client) throw new OAuthError("invalid_client", "unknown client_id", 401);

        if (grantType === "authorization_code") {
            // Deleted on first presentation, valid or not: a code is single-use,
            // and a failed PKCE check is exactly the replay that rule exists for.
            const code = await this.stores.oauthGrants.findOneAndDelete({
                _id: hash(String(body.code || "")),
                kind: "code",
            });
            if (!code || code.expiresAt.getTime() <= Date.now() || code.clientId !== clientId) {
                throw new OAuthError("invalid_grant", "the authorization code is invalid, expired or already used");
            }
            if (String(body.redirect_uri || code.redirectUri) !== code.redirectUri) {
                throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request");
            }
            if (!pkceMatches(String(body.code_verifier || ""), code.codeChallenge || "")) {
                throw new OAuthError("invalid_grant", "code_verifier does not match the code_challenge");
            }
            return this.issue(code, secret(), new Date());
        }

        if (grantType === "refresh_token") {
            // Rotated: the old refresh token dies as the new one is issued.
            const old = await this.stores.oauthGrants.findOneAndDelete({
                _id: hash(String(body.refresh_token || "")),
                kind: "refresh",
            });
            if (!old || old.expiresAt.getTime() <= Date.now() || old.clientId !== clientId) {
                throw new OAuthError("invalid_grant", "the refresh token is invalid, expired or already used");
            }
            return this.issue(old, old.familyId || secret(), old.approvedAt || old.createdAt);
        }

        throw new OAuthError("unsupported_grant_type", "use authorization_code or refresh_token");
    }

    private async issue(from: OAuthGrantDoc, familyId: string, approvedAt: Date) {
        const session = from.sessionId ? this.manager.byIdOrNull(from.sessionId) : null;
        if (!session?.mcpEnabled) {
            throw new OAuthError("invalid_grant", "MCP access is no longer on for this number");
        }
        const access = secret();
        const refresh = secret();
        const base = {
            clientId: from.clientId,
            clientName: from.clientName,
            sessionId: session.id,
            redirectUri: from.redirectUri,
            scope: from.scope,
            familyId,
            approvedAt,
            createdAt: new Date(),
        };
        await this.stores.oauthGrants.insertMany([
            { _id: hash(access), kind: "access", ...base, expiresAt: after(ACCESS_TTL_S) },
            { _id: hash(refresh), kind: "refresh", ...base, expiresAt: after(REFRESH_TTL_S) },
        ]);
        await this.stores.oauthClients.updateOne({ _id: from.clientId }, { $set: { lastUsedAt: new Date() } });
        return {
            access_token: access,
            token_type: "Bearer",
            expires_in: ACCESS_TTL_S,
            refresh_token: refresh,
            scope: from.scope || SCOPE,
        };
    }

    /** RFC 7009. A refresh token takes its whole approval with it; unknown tokens are not an error. */
    async revoke(token: string) {
        const g = await this.stores.oauthGrants.findOne({ _id: hash(String(token || "")) });
        if (!g) return;
        if (g.familyId) await this.stores.oauthGrants.deleteMany({ familyId: g.familyId });
        else await this.stores.oauthGrants.deleteOne({ _id: g._id });
    }
}

// ----------------------------------------------------------------- documents

/** RFC 9728: where the MCP endpoint says its tokens come from. */
export function resourceMetadata(req: Request) {
    return {
        resource: mcpResourceOf(req),
        authorization_servers: [issuerOf(req)],
        bearer_methods_supported: ["header"],
        scopes_supported: [SCOPE],
        resource_name: "wa-gateway (WhatsApp)",
        resource_documentation: `${origin(req)}/docs.html#mcp`,
    };
}

/** RFC 8414: the authorization server's endpoints and what it supports. */
export function authorizationServerMetadata(req: Request) {
    const iss = issuerOf(req);
    return {
        issuer: iss,
        authorization_endpoint: `${iss}/oauth/authorize`,
        token_endpoint: `${iss}/oauth/token`,
        registration_endpoint: `${iss}/oauth/register`,
        revocation_endpoint: `${iss}/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [SCOPE],
        service_documentation: `${origin(req)}/docs.html#mcp`,
    };
}

/**
 * The same, under the OIDC discovery path — the only one of the client's
 * three guesses that lands under `/api`. OIDC's schema requires a few fields
 * an OAuth-only server has no use for (`jwks_uri`, subject types, an id_token
 * algorithm), so they are present and inert: `openid` is not an offered scope,
 * no id_token is ever issued, and the key set is empty.
 */
export function oidcMetadata(req: Request) {
    return {
        ...authorizationServerMetadata(req),
        jwks_uri: `${issuerOf(req)}/oauth/jwks`,
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
    };
}

// -------------------------------------------------------------------- routes

/** Discovery, registration, authorize, token, revoke. Public by nature: each step checks what it must. */
export function makeOAuthRouter(oauth: OAuthService): Router {
    const router = Router();
    // The token, register and revoke endpoints take form bodies (the spec's
    // default) as well as JSON.
    router.use("/oauth", express.urlencoded({ extended: false, limit: "16kb" }));

    const oauthFail = (res: Response, e: unknown) => {
        if (e instanceof OAuthError) {
            res.status(e.status).json({ error: e.code, error_description: e.message });
            return;
        }
        logger.error({ e }, "oauth endpoint failed");
        res.status(500).json({ error: "server_error", error_description: "internal error" });
    };

    // Each document at its own path and at the root-style path the platform's
    // `/.well-known/*` redirect turns into (`/.well-known/X/api/mcp` →
    // `/api/.well-known/X/api/mcp`).
    router.get(
        [
            "/.well-known/oauth-protected-resource",
            "/.well-known/oauth-protected-resource/mcp",
            "/.well-known/oauth-protected-resource/api/mcp",
        ],
        (req, res) => res.json(resourceMetadata(req))
    );
    router.get(["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/api"], (req, res) =>
        res.json(authorizationServerMetadata(req))
    );
    router.get(["/.well-known/openid-configuration", "/.well-known/openid-configuration/api"], (req, res) =>
        res.json(oidcMetadata(req))
    );
    router.get("/oauth/jwks", (_req, res) => res.json({ keys: [] }));

    /**
     * Registration is open, so it is throttled per address: enough for any real
     * client reconnecting, too little to fill Mongo with junk clients.
     */
    const registrations = new Map<string, { count: number; since: number }>();
    router.post("/oauth/register", async (req, res) => {
        const who = req.ip || "unknown";
        const now = Date.now();
        const r = registrations.get(who);
        if (r && now - r.since < 3600_000 && r.count >= 20) {
            res.status(429).json({ error: "too_many_requests", error_description: "too many registrations, try later" });
            return;
        }
        if (registrations.size > 10_000) registrations.clear();
        registrations.set(who, r && now - r.since < 3600_000 ? { count: r.count + 1, since: r.since } : { count: 1, since: now });
        try {
            res.status(201).json(await oauth.register(req.body));
        } catch (e) {
            oauthFail(res, e);
        }
    });

    router.get("/oauth/authorize", async (req, res) => {
        try {
            res.redirect(302, await oauth.beginAuthorization(req.query as Record<string, unknown>, req));
        } catch (e) {
            if (e instanceof OAuthError) {
                // Not redirected: the redirect URI is the thing that could not be trusted.
                res.status(400).type("text/plain").send(`Cannot start sign-in: ${e.message}`);
                return;
            }
            logger.error({ e }, "oauth authorize failed");
            res.status(500).type("text/plain").send("Cannot start sign-in: internal error");
        }
    });

    router.post("/oauth/token", async (req, res) => {
        try {
            res.json(await oauth.token(req.body || {}));
        } catch (e) {
            if (e instanceof OAuthError) {
                logger.warn({ error: e.code, reason: e.message }, "token request refused");
            }
            oauthFail(res, e);
        }
    });

    router.post("/oauth/revoke", async (req, res) => {
        try {
            await oauth.revoke(String(req.body?.token || ""));
            res.status(200).json({});
        } catch (e) {
            oauthFail(res, e);
        }
    });

    return router;
}
