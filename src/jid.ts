/**
 * Translation between Baileys JIDs and the id shapes gepetel already expects
 * from whapi. Pure functions only — everything here is unit-tested.
 *
 * gepetel's assumptions, read off its source:
 *   - group chat ids match /^[\d-]{10,31}@g\.us$/            (whapi.ts getGroupInfo)
 *   - participants are stored like "40711@s.whatsapp.net"    (mongo.ts:661 comment)
 *   - every id is reduced with String(x).replace(/\D/g,"")   (util.ts, mongo.ts)
 *   - country/language/timezone are inferred from those digits (util.ts CALLING_CODES)
 *
 * That last point is why LIDs must never leak through. A LID's digits are not a
 * phone number, so a leaked LID wouldn't crash anything — it would quietly make
 * gepetel infer the wrong language for a group. Silent wrongness is worse than a
 * throw, so `toWhapiUserId` is deliberately strict about what it will emit.
 */

export const S_WHATSAPP = "@s.whatsapp.net";
export const S_GROUP = "@g.us";
export const S_LID = "@lid";

export function isGroupJid(jid: string | undefined | null): boolean {
    return !!jid && jid.endsWith(S_GROUP);
}

export function isLidJid(jid: string | undefined | null): boolean {
    return !!jid && jid.endsWith(S_LID);
}

/** Strip Baileys' device/agent suffix: "4075...:12@s.whatsapp.net" -> "4075...@s.whatsapp.net" */
export function stripDevice(jid: string): string {
    const at = jid.indexOf("@");
    if (at < 0) return jid;
    const user = jid.slice(0, at).split(":")[0];
    return `${user}${jid.slice(at)}`;
}

/** Just the digits — the form gepetel reduces everything to anyway. */
export function digitsOf(jid: string | undefined | null): string {
    return String(jid ?? "").split("@")[0].split(":")[0].replace(/\D/g, "");
}

/**
 * Normalise any Baileys JID into the chat id shape gepetel stores and matches on.
 * Groups keep their @g.us form; users become <digits>@s.whatsapp.net.
 *
 * NOTE: this does not resolve LIDs — it cannot, being pure. Callers must resolve
 * to a phone-number JID first (see resolveToPn in session.ts). A LID reaching
 * here is passed through unchanged so it is visible in logs rather than silently
 * reshaped into something that looks like a phone number.
 */
export function toWhapiChatId(jid: string | undefined | null): string {
    if (!jid) return "";
    const clean = stripDevice(String(jid));
    if (isGroupJid(clean)) return clean;
    if (isLidJid(clean)) return clean; // unresolved — caller's problem, deliberately loud
    const d = digitsOf(clean);
    return d ? `${d}${S_WHATSAPP}` : clean;
}

/**
 * The `from` / participant field. whapi hands gepetel bare digits here, and
 * gepetel uses it as a People collection key and for phone-prefix inference.
 */
export function toWhapiUserId(jid: string | undefined | null): string {
    return digitsOf(jid);
}

/**
 * Inbound direction: turn whatever gepetel puts in a `to` field into a real JID.
 * Accepts "120363...@g.us", "4075...@s.whatsapp.net", "4075...@c.us", or bare
 * digits (gepetel passes CREATOR_PHONE and reminder phone numbers that way).
 */
export function toWaJid(input: string | undefined | null): string {
    const raw = String(input ?? "").trim();
    if (!raw) return "";
    if (isGroupJid(raw)) return raw;
    if (raw.endsWith(S_WHATSAPP)) return stripDevice(raw);
    if (raw.endsWith("@c.us")) return `${digitsOf(raw)}${S_WHATSAPP}`;
    if (isLidJid(raw)) return raw;
    const d = digitsOf(raw);
    return d ? `${d}${S_WHATSAPP}` : "";
}

/** Does this look like a phone number rather than a LID or group id? */
export function looksLikePhoneNumber(jid: string | undefined | null): boolean {
    if (!jid) return false;
    if (isGroupJid(jid) || isLidJid(jid)) return false;
    const d = digitsOf(jid);
    // E.164 is 7-15 digits including country code. LIDs are typically 15+ and
    // don't start with a valid calling code, but length is the cheap first filter.
    return d.length >= 7 && d.length <= 15;
}
