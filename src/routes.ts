import { createReadStream } from "node:fs";
import { Router, type Request, type Response } from "express";
import QRCode from "qrcode";
import { config } from "./config.js";
import { logger } from "./log.js";
import type { Session } from "./session.js";
import type { SessionManager } from "./sessions.js";
import type { MediaStore } from "./media.js";
import { toWaJid, toWhapiUserId } from "./jid.js";

/**
 * whapi.cloud-compatible REST surface.
 *
 * Every route here mirrors one gepetel already calls in its whapi.ts, with the
 * same path, the same request body and the same response shape. That is the
 * entire migration strategy: point a bot's base URL at this service and its
 * WhatsApp code is unchanged.
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

export function makeApiRouter(manager: SessionManager): Router {
    const router = Router();

    // Scoped to the real API prefixes rather than mounted at the root: a typo'd
    // path should 404, not 401. A 401 on an unknown route sends you hunting for a
    // credentials problem that isn't there.
    router.use(["/groups", "/messages", "/presences"], (req: ApiRequest, res: Response, next) => {
        const hdr = req.get("authorization") || "";
        const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
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

    const fail = (res: Response, e: unknown, code = 500) => {
        const message = e instanceof Error ? e.message : String(e);
        logger.error({ e }, "api error");
        res.status(code).json({ error: { message } });
    };

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

/** Pairing UI + health. Separate from the API so it has its own auth. */
export function makeAdminRouter(manager: SessionManager, media: MediaStore): Router {
    const router = Router();

    router.get("/health", (_req, res) => {
        const h = manager.health();
        // 200 only when every number can actually send. A partially-down gateway
        // reporting green is how a number sits unpaired for a week unnoticed.
        res.status(h.ok ? 200 : 503).json(h);
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

    const adminAuth = (req: Request, res: Response, next: () => void) => {
        const hdr = req.get("authorization") || "";
        if (hdr.startsWith("Basic ")) {
            const pass = Buffer.from(hdr.slice(6), "base64").toString().split(":")[1] || "";
            if (pass === config.adminPassword) return next();
        }
        res.set("WWW-Authenticate", 'Basic realm="wa-gateway"');
        res.status(401).send("Authentication required");
    };

    const esc = (s: unknown) =>
        String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    /** One card per number: status, QR or pairing code, and an unlink button. */
    async function renderSession(session: Session): Promise<string> {
        const s = session.describe();
        const badge =
            s.status === "connected" ? "#16a34a" : s.status === "awaiting-pairing" ? "#d97706" : "#dc2626";

        let pairing = "";
        if (session.qr) {
            const dataUrl = await QRCode.toDataURL(session.qr, { margin: 2, width: 280 });
            pairing = `<p>Scan in WhatsApp → <b>Settings → Linked devices → Link a device</b>:</p>
<img src="${dataUrl}" alt="pairing QR" width="280" height="280">
<p class="hint">The code rotates every ~20s; reload if it expires.</p>`;
        } else if (s.pairingCode) {
            pairing = `<p>Enter in WhatsApp → <b>Linked devices → Link with phone number</b>:</p>
<p class="code">${esc(s.pairingCode)}</p>`;
        }

        const conflict =
            s.status === "conflict"
                ? `<p class="err"><b>Another client is using these credentials.</b>
Check for a second gateway instance or a duplicate session id, then restart.</p>`
                : "";

        return `<section>
 <h2>${esc(s.id)} <span class="s" style="background:${badge}">${esc(s.status)}</span></h2>
 ${conflict}
 ${pairing}
 <dl>
  <dt>Account</dt><dd>${esc(s.me?.id || "—")}${s.me?.name ? ` (${esc(s.me.name)})` : ""}</dd>
  <dt>Webhook</dt><dd>${esc(s.webhookUrl)}</dd>
  <dt>Connected since</dt><dd>${s.connectedAt ? new Date(s.connectedAt).toISOString() : "—"}</dd>
  <dt>Webhook backlog</dt><dd>${s.webhookBacklog}</dd>
  <dt>Reconnect attempts</dt><dd>${s.reconnectAttempts}</dd>
  <dt>Last error</dt><dd>${esc(s.lastError || "—")}</dd>
 </dl>
 <form method="POST" action="/admin/${encodeURIComponent(s.id)}/logout"
       onsubmit="return confirm('Unlink ${esc(s.id)} and require a fresh pairing?')">
  <button type="submit">Unlink &amp; re-pair ${esc(s.id)}</button>
 </form>
</section>`;
    }

    router.get("/admin", adminAuth, async (_req, res) => {
        const h = manager.health();
        const cards = await Promise.all(manager.all().map(renderSession));

        res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><title>wa-gateway</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{font:15px/1.5 system-ui,sans-serif;max-width:680px;margin:2rem auto;padding:0 1rem;color:#111}
 section{border:1px solid #e4e4e7;border-radius:10px;padding:1rem 1.25rem;margin:1.25rem 0}
 h1{margin-bottom:.25rem} h2{margin:0 0 .75rem;font-size:1.1rem}
 .s{display:inline-block;padding:.15rem .55rem;border-radius:999px;color:#fff;font-size:12px;vertical-align:middle}
 dt{font-weight:600;margin-top:.5rem} dd{margin:0 0 0 1rem;font-family:ui-monospace,monospace;font-size:12px;word-break:break-all}
 .code{font-size:1.9rem;letter-spacing:.25em;font-family:ui-monospace,monospace;background:#f4f4f5;padding:.5rem 1rem;border-radius:8px;display:inline-block}
 button{padding:.45rem .9rem;border:1px solid #dc2626;background:#fff;color:#dc2626;border-radius:6px;cursor:pointer}
 .hint{color:#666;font-size:13px} .err{color:#dc2626}
 .sum{color:#666}
</style></head><body>
<h1>wa-gateway</h1>
<p class="sum">${h.connected} of ${h.total} number${h.total === 1 ? "" : "s"} connected</p>
${cards.join("\n")}
</body></html>`);
    });

    router.post("/admin/:id/logout", adminAuth, async (req, res) => {
        const session = manager.byIdOrNull(req.params.id);
        if (!session) {
            res.status(404).send("no such session");
            return;
        }
        await session.logout();
        res.redirect("/admin");
    });

    return router;
}
