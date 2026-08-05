import { createReadStream } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import QRCode from "qrcode";
import { API_PREFIX, config } from "./config.js";
import { logger } from "./log.js";
import type { Session } from "./session.js";
import type { SessionManager } from "./sessions.js";
import type { MediaStore } from "./media.js";
import { NotFoundError, ValidationError, normaliseId } from "./sessionStore.js";
import {
    CloudRequestError,
    buildCloudError,
    buildCloudSendResponse,
    parseCloudSendRequest,
} from "./cloud.js";
import { toWaJid, toUserId } from "./jid.js";

/**
 * The REST surface.
 *
 * Two families live here, deliberately:
 *
 *   - `POST /<PHONE_NUMBER_ID>/messages` — WhatsApp Cloud API shaped, so a client
 *     written against Meta's API works after a base-URL change and nothing else.
 *   - the older per-verb routes below, kept because they cost nothing and some
 *     clients are written against that style.
 *
 * Everything is relative to the base URL a client is configured with. That base
 * carries an `/api` prefix, because the platform proxies only `/api/*` to the
 * container and answers everything else from the static bundle serving the
 * console. The paths *below* the base are what clients hardcode, so those are
 * the contract.
 *
 * Multi-number routing is by bearer token: a bot sends its own token and reaches
 * its own number, so adding a second bot on a second number needs no code change
 * on either side.
 *
 * The per-verb routes:
 *   GET  /groups/:id            -> { participants, participants_count, name }
 *   POST /messages/text         { to, body }
 *   POST /messages/image        { to, media, caption }
 *   POST /messages/poll         { to, poll: { name, options, allow_multiple_answers } }
 *   PUT  /messages/:id          { status: "read" }
 *   PUT  /messages/:id/reaction { emoji }
 *   PUT  /presences/:to         { presence, delay }
 */

/** The session resolved from the bearer token, attached by the auth middleware. */
type ApiRequest = Request & { session?: Session };

const bearerOf = (req: Request): string => {
    const hdr = req.get("authorization") || "";
    return hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
};

/**
 * A request this gateway refused, logged.
 *
 * Rejections used to be silent: the explicit 400s returned without a word, so a
 * client sending a shape we don't accept produced no trace anywhere. A bot that
 * quietly falls back — a poll degrading to a numbered list, say — then looks
 * like a bot bug, and the gateway looks fine. It cost a debugging session.
 *
 * `warn`, not `error`: it is the caller's mistake, not a fault here. The body is
 * deliberately not logged — it carries message content.
 */
const refused = (req: Request, reason: string) => {
    logger.warn({ method: req.method, path: req.path, reason }, "request refused");
};

const fail = (res: Response, e: unknown, code = 500) => {
    const message = e instanceof Error ? e.message : String(e);
    // Rejected input is the caller's problem and shouldn't read as a gateway
    // fault in the logs — or return a 5xx that makes a bot retry a bad request.
    if (e instanceof ValidationError) {
        res.status(400).json({ error: { message } });
        return;
    }
    if (e instanceof NotFoundError) {
        res.status(404).json({ error: { message } });
        return;
    }
    logger.error({ e }, "api error");
    res.status(code).json({ error: { message } });
};

export function makeApiRouter(manager: SessionManager): Router {
    const router = Router();

    // Scoped to the real API prefixes rather than mounted at the root: a typo'd
    // path should 404, not 401. A 401 on an unknown route sends you hunting for a
    // credentials problem that isn't there.
    // `/:phoneNumberId/messages` can't be prefix-scoped like the others, so the
    // Cloud route authenticates through the same middleware by matching any
    // first segment followed by /messages.
    router.use(
        ["/groups", "/messages", "/presences", "/:phoneNumberId/messages"],
        (req: ApiRequest, res: Response, next) => {
            const token = bearerOf(req);
            const session = token ? manager.byTokenOrNull(token) : null;
            if (!session) {
                res.status(401).json({ error: { message: "unauthorized" } });
                return;
            }
            req.session = session;
            next();
        }
    );

    // Every handler below runs after the middleware, so the session is present.
    const sessionOf = (req: ApiRequest): Session => req.session!;

    // --- groups -------------------------------------------------------------

    router.get("/groups/:groupId", async (req: ApiRequest, res) => {
        try {
            const jid = toWaJid(req.params.groupId);
            const { meta, participants } = await sessionOf(req).groupInfo(jid);
            res.json({
                id: req.params.groupId,
                // Both spellings are emitted: clients differ on which they read.
                name: meta.subject || "",
                subject: meta.subject || "",
                participants: participants.map((p) => ({
                    id: toUserId(p.id),
                    name: p.name,
                })),
                participants_count: participants.length,
            });
        } catch (e) {
            // A 404 reads as "couldn't fetch it", which a client can fall back from
            // using the roster it already received in the group event.
            fail(res, e, 404);
        }
    });

    // --- messages -----------------------------------------------------------

    router.post("/messages/text", async (req: ApiRequest, res) => {
        try {
            const { to, body } = req.body || {};
            if (!to || typeof body !== "string") {
                refused(req, "to and body are required");
                res.status(400).json({ error: { message: "to and body are required" } });
                return;
            }
            const sent = await sessionOf(req).sendText(String(to), body);
            res.json({ sent: true, message: { id: sent.id } });
        } catch (e) {
            fail(res, e, 502);
        }
    });

    router.post("/messages/image", async (req: ApiRequest, res) => {
        try {
            const { to, media, caption } = req.body || {};
            if (!to || !media) {
                refused(req, "to and media are required");
                res.status(400).json({ error: { message: "to and media are required" } });
                return;
            }
            const sent = await sessionOf(req).sendImage(String(to), String(media), caption);
            res.json({ sent: true, message: { id: sent.id } });
        } catch (e) {
            fail(res, e, 502);
        }
    });

    router.post("/messages/poll", async (req: ApiRequest, res) => {
        try {
            const { to, poll } = req.body || {};
            const name = poll?.name;
            const options: string[] = (poll?.options || [])
                .map((o: any) => String(o ?? "").trim())
                .filter(Boolean);
            if (!to || !name || options.length < 2) {
                refused(req, "to, poll.name and >=2 poll.options are required");
                res.status(400).json({
                    error: { message: "to, poll.name and >=2 poll.options are required" },
                });
                return;
            }
            const sent = await sessionOf(req).sendPoll(
                String(to),
                String(name),
                options,
                // This route's boolean, mapped onto the count WhatsApp actually
                // takes: everything, or exactly one.
                poll?.allow_multiple_answers ? options.length : 1
            );
            // Both `message.id` and a bare `id` are returned: clients differ.
            res.json({ sent: true, message: { id: sent.id }, id: sent.id });
        } catch (e) {
            // Failing loudly lets a client fall back to a plain text poll rather
            // than silently losing it.
            fail(res, e, 502);
        }
    });

    // Registered before the bare /messages/:id route so the more specific path wins.
    router.put("/messages/:id/reaction", async (req: ApiRequest, res) => {
        try {
            const emoji = req.body?.emoji;
            if (typeof emoji !== "string") {
                refused(req, "emoji is required");
                res.status(400).json({ error: { message: "emoji is required" } });
                return;
            }
            await sessionOf(req).react(req.params.id, emoji);
            res.json({ sent: true });
        } catch (e) {
            fail(res, e, 502);
        }
    });

    router.put("/messages/:id", async (req: ApiRequest, res) => {
        try {
            if (req.body?.status !== "read") {
                refused(req, "only { status: 'read' } is supported");
                res.status(400).json({ error: { message: "only { status: 'read' } is supported" } });
                return;
            }
            await sessionOf(req).markRead(req.params.id);
            res.json({ sent: true });
        } catch (e) {
            fail(res, e, 502);
        }
    });

    // --- WhatsApp Cloud API compatible ---------------------------------------
    //
    // `POST /<PHONE_NUMBER_ID>/messages`, Meta's shape. The path segment is
    // accepted but not used for routing: the bearer token already identifies
    // exactly one number, which is what makes migrating a base-URL change and
    // nothing else — an existing client's URL keeps working verbatim.
    //
    // It is still *validated*, because a segment naming a DIFFERENT configured
    // number is a real misconfiguration worth catching rather than silently
    // sending from the wrong account.
    router.post("/:phoneNumberId/messages", async (req: ApiRequest, res) => {
        const session = sessionOf(req);
        try {
            const addressed = String(req.params.phoneNumberId || "");
            const other = manager.all().find(
                (s) => s.id !== session.id && s.matchesAddress(addressed)
            );
            if (other) {
                throw new CloudRequestError(
                    "(#100) Parameter phone_number_id does not match the access token",
                    100,
                    `The token authenticates "${session.id}", but the path addresses "${other.id}".`
                );
            }

            const request = parseCloudSendRequest(req.body);
            const { messageId, waId } = await session.sendCloud(request);
            res.json(buildCloudSendResponse(request.to || waId, waId, messageId));
        } catch (e) {
            if (e instanceof CloudRequestError) {
                refused(req, `${e.message}${e.details ? ` — ${e.details}` : ""}`);
                res.status(400).json(buildCloudError(e));
                return;
            }
            logger.error({ e }, "cloud send failed");
            res.status(502).json(buildCloudError(e instanceof Error ? e : new Error(String(e))));
        }
    });

    // --- presence -----------------------------------------------------------

    router.put("/presences/:to", async (req: ApiRequest, res) => {
        try {
            const presence = req.body?.presence || "typing";
            await sessionOf(req).sendPresence(req.params.to, presence);
            res.json({ sent: true });
        } catch (e) {
            // A failed typing indicator is cosmetic; the result is ignorable.
            fail(res, e, 502);
        }
    });

    return router;
}

/** Health and media: the two things that must work without any credential. */
export function makeGatewayRouter(manager: SessionManager, media: MediaStore): Router {
    const router = Router();

    /**
     * Liveness. Unauthenticated because Pironman's healthcheck and its deploy
     * gate request it that way, which is also why it must be 200 with zero
     * numbers configured — otherwise a fresh deployment could never go healthy
     * long enough for anyone to open the console and add the first one.
     *
     * Counts only. This endpoint used to return every session's full state,
     * pairing code included, to anyone on the internet.
     */
    router.get("/health", (_req, res) => {
        res.json(manager.health());
    });

    /** Readiness: 503 until every configured number can actually send. */
    router.get("/ready", (_req, res) => {
        const r = manager.ready();
        res.status(r.ok ? 200 : 503).json(r);
    });

    // Media is served on an unguessable path rather than behind a bearer token:
    // the bots hand these URLs to OpenAI, which fetches them without our headers.
    // Ids are 24 random bytes, so they're unambiguous across sessions.
    router.get("/media/:id", async (req, res) => {
        try {
            const doc = await media.get(req.params.id);
            if (!doc) {
                res.status(404).end();
                return;
            }
            res.setHeader("content-type", doc.mimetype);
            res.setHeader("cache-control", "private, max-age=3600");
            createReadStream(doc.path)
                .on("error", () => res.status(404).end())
                .pipe(res);
        } catch {
            res.status(404).end();
        }
    });

    return router;
}

/**
 * The management API behind the console.
 *
 * This is the most dangerous surface in the gateway: it adds WhatsApp numbers,
 * reads every bot's token and can unlink an account. It is also, unavoidably, on
 * the public internet — so the key is compared in constant time, repeated
 * failures from one address are throttled, and nothing here is reachable with a
 * session token (a compromised bot must not be able to enumerate the others).
 */
export function makeManagementRouter(manager: SessionManager): Router {
    const router = Router();

    // Fail closed when unconfigured. A gateway with no key must not be
    // administrable by anyone — including by an empty bearer token, which is
    // what a naive constant-time compare against "" would happily accept.
    if (!config.managementKey) {
        router.use((_req, res) => {
            res.status(503).json({
                error: {
                    message:
                        "the management API is not configured — set WA_MANAGEMENT_KEY and redeploy",
                },
            });
        });
        return router;
    }

    const expected = Buffer.from(config.managementKey);

    const keyMatches = (given: string): boolean => {
        const buf = Buffer.from(given);
        // timingSafeEqual throws on a length mismatch, and the lengths differing
        // is itself the common case, so compare lengths first and accept that
        // key *length* is observable. The bytes are not.
        if (buf.length !== expected.length) return false;
        return timingSafeEqual(buf, expected);
    };

    /**
     * Failed-attempt throttle, per source address. Not a substitute for a strong
     * key — it's what turns an online brute force from "slow" into "pointless"
     * while the operator still notices the log lines.
     */
    const failures = new Map<string, { count: number; lastFailAt: number; until: number }>();
    const LOCKOUT_AFTER = 10;
    const LOCKOUT_MS = 15 * 60_000;
    const MAX_TRACKED = 10_000;

    router.use((req, res, next) => {
        const who = req.ip || "unknown";
        const now = Date.now();
        const record = failures.get(who);

        if (record && record.until > now) {
            res.status(429).json({
                error: { message: "too many failed attempts, try again later" },
            });
            return;
        }

        // A lockout that has expired, or a quiet 15 minutes, wipes the slate —
        // otherwise one mistyped key would hold an operator out permanently.
        if (record && now - record.lastFailAt > LOCKOUT_MS) failures.delete(who);

        if (!keyMatches(bearerOf(req))) {
            // Bound the map: an attacker rotating source addresses would
            // otherwise turn this defence into a memory leak.
            if (failures.size >= MAX_TRACKED) {
                for (const [k, v] of failures) if (v.until <= now) failures.delete(k);
            }
            const count = (failures.get(who)?.count ?? 0) + 1;
            failures.set(who, {
                count,
                lastFailAt: now,
                until: count >= LOCKOUT_AFTER ? now + LOCKOUT_MS : 0,
            });
            logger.warn({ ip: who, count }, "management auth failed");
            res.status(401).json({ error: { message: "unauthorized" } });
            return;
        }

        failures.delete(who);
        next();
    });

    /**
     * One number, as the console renders it. The QR is turned into a data URL
     * here rather than in the browser so the console needs no bundled library —
     * it is a plain static page with no build step.
     */
    async function present(session: Session) {
        const s = session.describeForManagement();
        const { qr, ...rest } = s;
        return {
            ...rest,
            qrDataUrl: qr ? await QRCode.toDataURL(qr, { margin: 2, width: 320 }) : undefined,
        };
    }

    router.get("/numbers", async (_req, res) => {
        try {
            res.json({
                numbers: await Promise.all(manager.all().map(present)),
                // The base URL to give a bot, shown in the console so
                // nobody has to reconstruct the /api prefix from memory.
                apiBaseUrl: `${config.publicUrl}${API_PREFIX}`,
            });
        } catch (e) {
            fail(res, e);
        }
    });

    router.post("/numbers", async (req, res) => {
        try {
            const doc = await manager.create(req.body || {});
            const session = manager.byIdOrNull(doc._id);
            res.status(201).json({ number: session ? await present(session) : doc });
        } catch (e) {
            fail(res, e);
        }
    });

    router.patch("/numbers/:id", async (req, res) => {
        try {
            await manager.update(normaliseId(req.params.id), req.body || {});
            const session = manager.byIdOrNull(normaliseId(req.params.id));
            res.json({ number: session ? await present(session) : null });
        } catch (e) {
            fail(res, e);
        }
    });

    router.post("/numbers/:id/rotate-token", async (req, res) => {
        try {
            const doc = await manager.rotateToken(normaliseId(req.params.id));
            res.json({ token: doc.token });
        } catch (e) {
            fail(res, e);
        }
    });

    router.post("/numbers/:id/relink", async (req, res) => {
        try {
            await manager.relink(normaliseId(req.params.id));
            res.json({ ok: true });
        } catch (e) {
            fail(res, e);
        }
    });

    router.post("/numbers/:id/restart", async (req, res) => {
        try {
            await manager.restart(normaliseId(req.params.id));
            res.json({ ok: true });
        } catch (e) {
            fail(res, e);
        }
    });

    router.delete("/numbers/:id", async (req, res) => {
        try {
            await manager.remove(normaliseId(req.params.id));
            res.json({ ok: true });
        } catch (e) {
            fail(res, e);
        }
    });

    return router;
}
