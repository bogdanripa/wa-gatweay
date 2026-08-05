import { randomBytes } from "node:crypto";
import type { SessionConfig } from "./config.js";
import type { SessionDoc, Stores } from "./store.js";

/**
 * Persistence and validation for the set of configured numbers.
 *
 * These used to be `WA_SESSION_n_*` environment variables validated at boot, and
 * the validation was allowed to be brutal — a bad value crashed the process
 * before it could half-work. Now the same values arrive from an HTTP form, so
 * the rules have to survive as *rejections* rather than crashes. They are the
 * same rules, and they are here rather than in the route handler because the
 * reasons behind them are storage reasons, not HTTP ones.
 */

/** Rejected input, as opposed to a bug. Routes turn this into a 400. */
export class ValidationError extends Error {}

/** Named a number that isn't there. Routes turn this into a 404. */
export class NotFoundError extends Error {}

/**
 * The id namespaces Mongo document ids (`"<id>:<key>"`) and appears in URLs, so
 * it must not contain a colon, a slash, or anything needing escaping. A change
 * here orphans a live session's credentials, which is why the console refuses to
 * edit it after creation.
 *
 * Lower-cased on the way in. Mongo `_id` matching is case-sensitive but the
 * gateway's own lookup map is not, and "gepetel" resolving to a session that
 * "Gepetel" cannot delete is exactly the kind of split-brain worth designing
 * out rather than handling.
 */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function validateId(raw: unknown): string {
    const id = String(raw ?? "").trim().toLowerCase();
    if (!ID_RE.test(id)) {
        throw new ValidationError(
            `id "${id}" is invalid: use 1-32 characters of [a-z0-9_-], starting alphanumeric`
        );
    }
    return id;
}

/** Normalise an id arriving from a URL path, without asserting it is valid. */
export const normaliseId = (raw: unknown): string => String(raw ?? "").trim().toLowerCase();

/**
 * Optional. A number can be paired before anyone has decided where its events
 * should go — pairing is the slow, physical step (find the phone, scan a code)
 * and there is no reason to block it on a URL that doesn't exist yet.
 *
 * Until one is set, inbound events are discarded rather than queued. Queueing
 * them would mean a number paired and forgotten for a week floods its bot with
 * stale conversation the moment a webhook appears.
 */
function validateWebhookUrl(raw: unknown): string | undefined {
    const url = String(raw ?? "").trim();
    if (!url) return undefined;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new ValidationError(`webhookUrl "${url}" is not a valid URL`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new ValidationError("webhookUrl must be http or https");
    }
    return url;
}

/**
 * Digits only, with the country code. Baileys sends this to WhatsApp verbatim to
 * request a pairing code, and a wrong shape comes back as an opaque failure.
 */
function validatePairPhone(raw: unknown): string | undefined {
    if (raw === undefined || raw === null || raw === "") return undefined;
    const digits = String(raw).replace(/\D/g, "");
    if (!digits) return undefined;
    if (digits.length < 7 || digits.length > 15) {
        throw new ValidationError(`pairPhone must be 7-15 digits including the country code`);
    }
    return digits;
}

/**
 * Optional, and absent means **no cap** rather than some default. There is no
 * gateway-wide fallback: a limit either exists on the number or it doesn't.
 */
function validateRate(raw: unknown): number | undefined {
    if (raw === undefined || raw === null || raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 600) {
        throw new ValidationError("sendRatePerMinute must be a whole number between 1 and 600");
    }
    return n;
}

/**
 * Tokens are generated, never chosen. A bot's token is its only credential and
 * an operator-picked one would be the weakest link in the whole gateway.
 */
export function generateToken(): string {
    return randomBytes(24).toString("base64url");
}

/**
 * The analogue of Meta's `phone_number_id`: 15 numeric digits, minted at
 * creation and never derived from the linked phone number.
 *
 * Meta's is likewise unrelated to the display number, and clients need
 * *something* to put in the request path before a number has been paired at
 * all — so it cannot come from the WhatsApp account.
 */
export function generatePhoneNumberId(): string {
    let digits = "";
    for (const byte of randomBytes(16)) digits += (byte % 10).toString();
    // Leading zero would look wrong beside Meta's, and reads as a typo.
    return (digits[0] === "0" ? "1" : digits[0]) + digits.slice(1, 15);
}

export function toSessionConfig(doc: SessionDoc): SessionConfig {
    return {
        id: doc._id,
        token: doc.token,
        webhookUrl: doc.webhookUrl,
        pairPhone: doc.pairPhone,
        sendRatePerMinute: doc.sendRatePerMinute,
        phoneNumberId: doc.phoneNumberId,
    };
}

export interface CreateSessionInput {
    id?: unknown;
    webhookUrl?: unknown;
    pairPhone?: unknown;
    sendRatePerMinute?: unknown;
}

export interface UpdateSessionInput {
    webhookUrl?: unknown;
    pairPhone?: unknown;
    sendRatePerMinute?: unknown;
}

export class SessionStore {
    constructor(private stores: Stores) {}

    async all(): Promise<SessionDoc[]> {
        const docs = await this.stores.sessions.find().sort({ _id: 1 }).toArray();

        // Backfill numbers created before these fields existed. Done here rather
        // than as a migration script because it has to happen exactly once per
        // document and this is the only path that reads them — a number without
        // a phone_number_id can't be addressed on the Cloud endpoint at all.
        for (const doc of docs) {
            const patch: Partial<SessionDoc> = {};
            if (!doc.phoneNumberId) patch.phoneNumberId = generatePhoneNumberId();
            if (!Object.keys(patch).length) continue;

            Object.assign(doc, patch);
            await this.stores.sessions.updateOne({ _id: doc._id }, { $set: patch });
        }
        return docs;
    }

    async get(id: string): Promise<SessionDoc | null> {
        return this.stores.sessions.findOne({ _id: id });
    }

    async create(input: CreateSessionInput): Promise<SessionDoc> {
        const id = validateId(input.id);
        const doc: SessionDoc = {
            _id: id,
            token: generateToken(),
            webhookUrl: validateWebhookUrl(input.webhookUrl),
            pairPhone: validatePairPhone(input.pairPhone),
            sendRatePerMinute: validateRate(input.sendRatePerMinute),
            phoneNumberId: generatePhoneNumberId(),
            createdAt: new Date(),
            updatedAt: new Date(),
        };

        // Reusing an id would adopt the previous number's credentials — the new
        // number would try to occupy a device slot registered to a different
        // account. Check before inserting so the error names the real problem.
        if (await this.get(id)) {
            throw new ValidationError(`a number with id "${id}" already exists`);
        }

        try {
            await this.stores.sessions.insertOne(doc);
        } catch (e: any) {
            if (e?.code === 11000) throw new ValidationError(`id "${id}" is already taken`);
            throw e;
        }
        return doc;
    }

    async update(id: string, patch: UpdateSessionInput): Promise<SessionDoc> {
        const existing = await this.get(id);
        if (!existing) throw new NotFoundError(`no number with id "${id}"`);

        const $set: Partial<SessionDoc> = { updatedAt: new Date() };
        const $unset: Record<string, ""> = {};

        if (patch.webhookUrl !== undefined) {
            const url = validateWebhookUrl(patch.webhookUrl);
            if (url) $set.webhookUrl = url;
            else $unset.webhookUrl = "";
        }
        if (patch.pairPhone !== undefined) {
            const phone = validatePairPhone(patch.pairPhone);
            if (phone) $set.pairPhone = phone;
            else $unset.pairPhone = "";
        }
        if (patch.sendRatePerMinute !== undefined) {
            const rate = validateRate(patch.sendRatePerMinute);
            if (rate) $set.sendRatePerMinute = rate;
            else $unset.sendRatePerMinute = "";
        }

        await this.stores.sessions.updateOne(
            { _id: id },
            Object.keys($unset).length ? { $set, $unset } : { $set }
        );
        return (await this.get(id))!;
    }

    async rotateToken(id: string): Promise<SessionDoc> {
        const existing = await this.get(id);
        if (!existing) throw new NotFoundError(`no number with id "${id}"`);
        const token = generateToken();
        await this.stores.sessions.updateOne(
            { _id: id },
            { $set: { token, updatedAt: new Date() } }
        );
        return { ...existing, token };
    }

    async remove(id: string): Promise<void> {
        await this.stores.sessions.deleteOne({ _id: id });
    }
}

/**
 * Delete everything a session owns. Called when a number is removed from the
 * console, and deliberately thorough: a leftover auth document means recreating
 * the same id later silently adopts a dead account's credentials, which
 * presents as "the QR never appears" with nothing in the logs to explain it.
 *
 * The prefix match is what keeps this from touching the other numbers.
 */
export async function purgeSessionState(stores: Stores, sessionId: string): Promise<void> {
    const prefix = new RegExp(`^${sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`);
    await Promise.all([
        stores.authCreds.deleteMany({ _id: { $regex: prefix } }),
        stores.authKeys.deleteMany({ _id: { $regex: prefix } }),
        stores.messageKeys.deleteMany({ sessionId }),
        stores.polls.deleteMany({ sessionId }),
        // Media is deliberately NOT purged here. The row is what tells the hourly
        // sweep which file to unlink, so deleting rows would strand the files on
        // disk forever. The TTL index expires them on the normal schedule, and
        // until then a link we already handed a bot keeps working.
    ]);
}

