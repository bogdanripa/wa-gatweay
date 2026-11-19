import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Router, type Request, type Response } from "express";
import { API_PREFIX, config } from "./config.js";
import { logger } from "./log.js";
import { resolveMime } from "./sniff.js";

/**
 * One-time upload links, so an MCP client can send a file without its bytes
 * passing through the model.
 *
 * A file sent as base64 inside a tool call is written out by the model token
 * by token: a 1 MB photo is over a million characters, far past what a model
 * can emit, so in practice only URLs worked. Instead `prepare_upload` hands
 * back a link; the client's shell PUTs the file there (`curl --data-binary`),
 * and `send_media` names the upload by id. The model only ever sees the id.
 *
 * The link is the credential — 32 random bytes, valid once, for a short
 * window, capped in size — which is how pre-signed upload URLs work anywhere.
 * Knowing an id is not enough to *send* it: an upload belongs to the number
 * whose MCP session created it, and is consumed by the first send.
 *
 * Deliberately in memory and on scratch disk, not in Mongo: an upload lives
 * minutes, and a restart in between costs the client one retry.
 *
 * This runs on a Pi, so nothing here may accumulate. Every upload is deleted
 * when it is sent, and every one that isn't is deleted when it expires, used or
 * not — and the directory itself is swept by file age as a backstop, so a file
 * that lost its record somehow still goes. On top of that, what can be pending
 * at once is capped: total bytes on disk, and open links per number.
 */

/**
 * Per file. Set by the deployment, not by WhatsApp: measured against the live
 * host, bodies up to 52 MB reached the container and 56 MB came back as a 502
 * from the edge (Cloudflare itself allows 100 MB, so the limit is in the hop
 * behind it). 48 MB stays clear of it, so an oversized file gets our own clear
 * 413 instead of an opaque proxy error. Raise it only after re-measuring.
 */
export const MAX_UPLOAD_BYTES = 48 * 1024 * 1024;
/** Everything waiting to be sent, across all numbers, may not exceed this on disk. */
export const MAX_PENDING_BYTES = 256 * 1024 * 1024;
/** Open links per number: enough for an album, too few to be a way to fill the disk. */
export const MAX_OPEN_PER_SESSION = 20;
/** From creating the link to sending the file. */
const UPLOAD_TTL_MS = 15 * 60_000;
/** The directory sweep's own limit, independent of the map: anything older is deleted, whatever it is. */
const ORPHAN_AGE_MS = UPLOAD_TTL_MS + 5 * 60_000;

interface Upload {
    sessionId: string;
    filename?: string;
    expiresAt: number;
    /** Set once the bytes have arrived. */
    received?: { path: string; bytes: number; mimetype: string };
}

/** Overridable so tests can exercise expiry and the caps without waiting or writing 256 MB. */
export interface UploadLimits {
    dir: string;
    ttlMs: number;
    orphanAgeMs: number;
    maxUploadBytes: number;
    maxPendingBytes: number;
    maxOpenPerSession: number;
}

export class UploadStore {
    private uploads = new Map<string, Upload>();
    private readonly lim: UploadLimits;
    /** Bytes on disk right now — received uploads plus ones still streaming in. */
    private pendingBytes = 0;

    constructor(limits: Partial<UploadLimits> = {}) {
        this.lim = {
            dir: join(config.mediaDir, "uploads"),
            ttlMs: UPLOAD_TTL_MS,
            orphanAgeMs: ORPHAN_AGE_MS,
            maxUploadBytes: MAX_UPLOAD_BYTES,
            maxPendingBytes: MAX_PENDING_BYTES,
            maxOpenPerSession: MAX_OPEN_PER_SESSION,
            ...limits,
        };
    }

    private get dir() {
        return this.lim.dir;
    }

    /** Bytes currently held on disk. For tests and the sweep's log line. */
    get heldBytes() {
        return this.pendingBytes;
    }

    async init(opts: { sweepEveryMs?: number } = {}) {
        await mkdir(this.dir, { recursive: true });
        // Whatever a previous container left is unreachable now: the map that
        // named it died with the process.
        for (const f of await readdir(this.dir).catch(() => [] as string[])) {
            await unlink(join(this.dir, f)).catch(() => {});
        }
        if (opts.sweepEveryMs !== 0) setInterval(() => void this.sweep(), opts.sweepEveryMs ?? 60_000).unref();
    }

    /** Expired uploads go, sent or not; then anything on disk older than any upload can live. */
    async sweep() {
        const now = Date.now();
        let removed = 0;
        for (const [id, u] of this.uploads) {
            if (u.expiresAt > now) continue;
            this.forget(id, u);
            if (u.received) {
                await unlink(u.received.path).catch(() => {});
                removed++;
            }
        }
        const live = new Set([...this.uploads.values()].map((u) => u.received?.path).filter(Boolean));
        for (const f of await readdir(this.dir).catch(() => [] as string[])) {
            const path = join(this.dir, f);
            if (live.has(path)) continue;
            const st = await stat(path).catch(() => null);
            if (st && now - st.mtimeMs > this.lim.orphanAgeMs) {
                await unlink(path).catch(() => {});
                removed++;
            }
        }
        if (removed) logger.info({ removed, pendingBytes: this.pendingBytes }, "uploads swept");
    }

    /** Drop the record and release its share of the byte budget. */
    private forget(id: string, u: Upload) {
        this.uploads.delete(id);
        if (u.received?.bytes) this.pendingBytes = Math.max(0, this.pendingBytes - u.received.bytes);
    }

    /** A fresh link for `sessionId`. */
    create(sessionId: string, filename?: string) {
        const now = Date.now();
        const open = [...this.uploads.values()].filter((u) => u.sessionId === sessionId && u.expiresAt > now).length;
        if (open >= this.lim.maxOpenPerSession) {
            throw new Error(
                `${open} upload links are already open for this number — send or wait out (${Math.round(
                    this.lim.ttlMs / 60_000
                )} min) some of them first`
            );
        }
        const id = randomBytes(32).toString("base64url");
        const expiresAt = now + this.lim.ttlMs;
        this.uploads.set(id, { sessionId, filename: filename ? String(filename).slice(0, 255) : undefined, expiresAt });
        return {
            id,
            url: `${config.publicUrl}${API_PREFIX}/uploads/${id}`,
            expiresAt: new Date(expiresAt),
            maxBytes: this.lim.maxUploadBytes,
        };
    }

    /**
     * Receive the bytes for a link, streamed straight to disk with a running
     * count, so an oversized body is cut off at the cap rather than buffered.
     */
    async receive(id: string, req: Pick<Request, "on" | "pipe" | "unpipe" | "resume" | "get">): Promise<{ bytes: number; mimetype: string; filename?: string }> {
        const u = this.uploads.get(id);
        if (!u || u.expiresAt <= Date.now()) throw new UploadError(404, "this upload link is unknown or has expired");
        if (u.received) throw new UploadError(409, "this upload link has already been used");
        // Claimed before the body arrives, so two concurrent PUTs can't both land.
        const path = join(this.dir, randomBytes(16).toString("hex"));
        u.received = { path, bytes: 0, mimetype: "" };

        const head: Buffer[] = [];
        let headLen = 0;
        let bytes = 0;
        try {
            await new Promise<void>((resolve, reject) => {
                const out = createWriteStream(path);
                let failed = false;
                const stop = (e: UploadError) => {
                    if (failed) return;
                    failed = true;
                    req.unpipe(out);
                    out.destroy();
                    reject(e);
                    req.resume();
                };
                req.on("data", (chunk: Buffer) => {
                    if (failed) return;
                    bytes += chunk.length;
                    // Counted as it streams, so the budget holds for uploads
                    // arriving at the same time, not just finished ones.
                    this.pendingBytes += chunk.length;
                    if (headLen < 64) {
                        head.push(chunk);
                        headLen += chunk.length;
                    }
                    if (bytes > this.lim.maxUploadBytes) {
                        stop(new UploadError(413, `the file is over ${Math.round(this.lim.maxUploadBytes / 1024 / 1024)} MB`));
                    } else if (this.pendingBytes > this.lim.maxPendingBytes) {
                        stop(
                            new UploadError(
                                507,
                                "too many files are waiting to be sent right now — send or let some expire, then retry"
                            )
                        );
                    }
                });
                req.on("error", reject);
                out.on("error", reject);
                out.on("finish", resolve);
                req.pipe(out);
            });
        } catch (e) {
            this.pendingBytes = Math.max(0, this.pendingBytes - bytes);
            await unlink(path).catch(() => {});
            u.received = undefined;
            throw e;
        }
        if (!bytes) {
            await unlink(path).catch(() => {});
            u.received = undefined;
            throw new UploadError(400, "the upload was empty — send the file as the raw request body");
        }
        // Expired while streaming: the sweep may already have dropped the
        // record, so nothing would ever delete this file.
        if (this.uploads.get(id) !== u) {
            this.pendingBytes = Math.max(0, this.pendingBytes - bytes);
            await unlink(path).catch(() => {});
            throw new UploadError(404, "this upload link expired while the file was arriving");
        }

        const mimetype = resolveMime(Buffer.concat(head).subarray(0, 64), u.filename, req.get("content-type"));
        u.received = { path, bytes, mimetype };
        logger.info({ session: u.sessionId, bytes, mime: mimetype, filename: u.filename }, "upload received");
        return { bytes, mimetype, filename: u.filename };
    }

    /**
     * The bytes for a send. Null for an unknown, expired, not-yet-uploaded or
     * other-number id — indistinguishable on purpose. Not consumed here: a send
     * that fails (phone offline, say) can be retried; `done` deletes it after a
     * successful one, and expiry deletes it otherwise.
     */
    async read(sessionId: string, id: string): Promise<{ data: Buffer; mimetype: string; filename?: string } | null> {
        const u = this.uploads.get(id);
        if (!u || u.sessionId !== sessionId || u.expiresAt <= Date.now() || !u.received?.bytes) return null;
        const data = await readFile(u.received.path).catch(() => null);
        return data ? { data, mimetype: u.received.mimetype, filename: u.filename } : null;
    }

    /** Sent: delete it now rather than at expiry. */
    async done(sessionId: string, id: string) {
        const u = this.uploads.get(id);
        if (!u || u.sessionId !== sessionId) return;
        this.forget(id, u);
        if (u.received) await unlink(u.received.path).catch(() => {});
    }

    /** Whether an id names a received upload for this number — lets a send say *why* it can't find one. */
    status(sessionId: string, id: string): "ready" | "waiting" | "missing" {
        const u = this.uploads.get(id);
        if (!u || u.sessionId !== sessionId || u.expiresAt <= Date.now()) return "missing";
        return u.received?.bytes ? "ready" : "waiting";
    }
}

export class UploadError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
    }
}

/**
 * `PUT /api/uploads/<id>` (POST works too). No bearer token: the unguessable,
 * single-use id in the path is the credential, as with any pre-signed URL —
 * the client uploading is a shell command, not the authenticated MCP session.
 */
export function makeUploadRouter(uploads: UploadStore): Router {
    const router = Router();
    const handle = async (req: Request, res: Response) => {
        // express.json() runs first for application/json and would have eaten
        // the body. Everything else (octet-stream, curl's default form type,
        // image/*) arrives untouched.
        if ((req as any)._body) {
            res.status(415).json({ error: { message: "send the file as application/octet-stream, not JSON" } });
            return;
        }
        try {
            const r = await uploads.receive(String(req.params.id || ""), req);
            res.status(201).json({
                upload_id: req.params.id,
                bytes: r.bytes,
                mime_type: r.mimetype,
                next: "call send_media with this upload_id",
            });
        } catch (e) {
            if (e instanceof UploadError) {
                logger.warn({ status: e.status, reason: e.message }, "upload refused");
                res.status(e.status).json({ error: { message: e.message } });
                return;
            }
            logger.error({ e }, "upload failed");
            res.status(500).json({ error: { message: "upload failed" } });
        }
    };
    router.put("/uploads/:id", handle);
    router.post("/uploads/:id", handle);
    return router;
}
