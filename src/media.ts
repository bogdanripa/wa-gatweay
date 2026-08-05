import { randomBytes } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { downloadMediaMessage, type WAMessage, type WASocket } from "baileys";
import { config } from "./config.js";
import { logger } from "./log.js";
import type { Stores } from "./store.js";
import type { MediaKind, ResolvedMedia } from "./map.js";
import { baileysLogger } from "./log.js";

const EXT: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
};

/**
 * Consumers expect plain HTTPS links to media. Baileys hands you encrypted
 * blobs you must download and decrypt yourself.
 *
 * These links get fetched server-side by whatever consumes them — commonly an
 * image or transcription model, which will not send your headers — so they have
 * to be publicly reachable. The path carries 24 bytes of entropy and the record
 * is TTL'd, so the exposure is a long random URL that expires, not an open
 * bucket.
 */
export class MediaStore {
    constructor(private stores: Stores) {}

    async init() {
        await mkdir(config.mediaDir, { recursive: true });
    }

    /**
     * Download one media message and return a fetchable URL.
     * Never throws — a failed download degrades to "no media", which a consumer
     * handles far better than a missing message would.
     */
    async save(
        waMessage: WAMessage,
        kind: MediaKind,
        sock: WASocket,
        sessionId: string
    ): Promise<ResolvedMedia | undefined> {
        try {
            const buffer = (await downloadMediaMessage(
                waMessage,
                "buffer",
                {},
                {
                    logger: baileysLogger,
                    // Lets Baileys ask WhatsApp to re-upload if the media has expired
                    // off the CDN — common for anything more than a few days old.
                    reuploadRequest: sock.updateMediaMessage,
                }
            )) as Buffer;

            const inner =
                waMessage.message?.imageMessage ||
                waMessage.message?.videoMessage ||
                waMessage.message?.audioMessage;
            const mimetype = inner?.mimetype || "application/octet-stream";
            const ext = EXT[mimetype.split(";")[0]] || "bin";

            const id = `${randomBytes(24).toString("hex")}.${ext}`;
            const path = join(config.mediaDir, id);
            await writeFile(path, buffer);
            await this.stores.media.insertOne({
                _id: id,
                sessionId,
                path,
                mimetype,
                createdAt: new Date(),
            });

            const link = `${config.mediaBaseUrl}/${id}`;

            // Images and GIFs also carry a small JPEG thumbnail inline. Surfacing it
            // as a data URI avoids a second HTTP hop when the thumbnail is all a
            // consumer needs.
            let preview: string | undefined;
            const thumb = (inner as any)?.jpegThumbnail as Uint8Array | undefined;
            if (thumb?.length) {
                preview = `data:image/jpeg;base64,${Buffer.from(thumb).toString("base64")}`;
            }

            logger.info({ session: sessionId, id, mimetype, bytes: buffer.length, kind }, "media saved");
            return { link, preview: preview || link };
        } catch (e) {
            logger.error({ e, session: sessionId, kind, id: waMessage.key?.id }, "media download failed");
            return undefined;
        }
    }

    /** Look up a stored file for the HTTP handler. */
    async get(id: string) {
        // Path traversal guard: ids are hex + extension, nothing else is servable.
        if (!/^[0-9a-f]{48}\.[a-z0-9]{1,5}$/.test(id)) return null;
        return this.stores.media.findOne({ _id: id });
    }

    /**
     * Mongo's TTL index expires the *record*; the file on disk needs its own
     * sweep or the container fills up. Runs hourly.
     */
    startCleanup() {
        const sweep = async () => {
            try {
                const cutoff = new Date(Date.now() - config.mediaTtlHours * 3600_000);
                // Anything whose record has already expired is unreachable anyway.
                const stale = await this.stores.media
                    .find({ createdAt: { $lt: cutoff } })
                    .toArray();
                for (const doc of stale) {
                    await unlink(doc.path).catch(() => {});
                    await this.stores.media.deleteOne({ _id: doc._id });
                }
                if (stale.length) logger.info({ n: stale.length }, "media swept");
            } catch (e) {
                logger.error({ e }, "media sweep failed");
            }
        };
        setInterval(sweep, 3600_000).unref();
        void sweep();
    }
}
