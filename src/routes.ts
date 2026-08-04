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
import { toWaJid, toWhapiUserId } from "./jid.js";

/**
 * whapi.cloud-compatible REST surface.
 *
 * Every route here mirrors one gepetel already calls in its whapi.ts, with the
 * same path, the same request body and the same response shape — all relative to
 * the base URL the bot is configured with. That is the entire migration
 * strategy: point a bot's `WHAPI_BASE_URL` at this service and its WhatsApp code
 * is unchanged.
 *
 * The base URL now carries an `/api` prefix, because Pironman proxies only
 * `/api/*` to the container and answers everything else from the static bundle
 * that serves the management console. The paths *below* the base are untouched,
 * which is the part gepetel actually hardcodes.
 *
 * Multi-number works the same way whapi's does: the bearer token selects the
 * channel. A bot sends its own token and reaches its own number — so adding a
 * second bot on a second number needs no code change on either side.
 *
 * Endpoints implemented (all of gepetel's, nothing more):
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
    router.use(["/groups", "/messages", "/presences"], (req: ApiRequest, res: Response, next) => {
        const token = bearerOf(req);
        const session = token ? manager.byTokenOrNull(token) : null;
        if (!session) {
            res.status(401).json({ error: { message: "unauthorized" } });
            return;
        }
        req.session = session;
        next();
    });

    // Every handler below runs after the middleware, so the session is present.
    const sessionOf = (req: ApiRequest): Session => req.session!;

    // --- groups -------------------------------------------------------------

    router.get("/groups/:groupId", async (req: ApiRequest, res) => {
        try {
            const jid = toWaJid(req.params.groupId);
            const { meta, participants } = await sessionOf(req).groupInfo(jid);
            res.json({
                id: req.params.groupId,
                // gepetel reads `name` first, then falls back to `subject`.
                name: meta.subject || "",
                subject: meta.subject || "",
                participants: participants.map((p) => ({
                    id: toWhapiUserId(p.id),
                    name: p.name,
                })),
                participants_count: participants.length,
            });
        } catch (e) {
            // gepetel treats null from getGroupInfo as "couldn't read it" and falls
            // back to the roster in the event payload, so a 404 here is safe.
            fail(res, e, 404);
        }
    });

    // --- messages -----------------------------------------------------------

    router.post("/messages/text", async (req: ApiRequest, res) => {
        try {
            const { to, body } = req.body || {};
            if (!to || typeof body !== "string") {
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
                res.status(400).json({
                    error: { message: "to, poll.name and >=2 poll.options are required" },
                });
                return;
            }
            const sent = await sessionOf(req).sendPoll(
                String(to),
                String(name),
                options,
                !!poll?.allow_multiple_answers
            );
            // gepetel reads res.data.message.id (falling back to res.data.id).
            res.json({ sent: true, message: { id: sent.id }, id: sent.id });
        } catch (e) {
            // gepetel falls back to a text poll when this fails, so failing loudly
            // here degrades gracefully rather than losing the poll.
            fail(res, e, 502);
        }
    });

    // Registered before the bare /messages/:id route so the more specific path wins.
    router.put("/messages/:id/reaction", async (req: ApiRequest, res) => {
        try {
            const emoji = req.body?.emoji;
            if (typeof emoji !== "string") {
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
                res.status(400).json({ error: { message: "only { status: 'read' } is supported" } });
                return;
            }
            await sessionOf(req).markRead(req.params.id);
            res.json({ sent: true });
        } catch (e) {
            fail(res, e, 502);
        }
    });

    // --- presence -----------------------------------------------------------

    router.put("/presences/:to", async (req: ApiRequest, res) => {
        try {
            const presence = req.body?.presence || "typing";
            await sessionOf(req).sendPresence(req.params.to, presence);
            res.json({ sent: true });
        } catch (e) {
            // A failed typing indicator is cosmetic — gepetel ignores the result.
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
