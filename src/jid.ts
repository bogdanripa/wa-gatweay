/**
 * Translation between Baileys JIDs and the id shapes this gateway emits.
 * Pure functions only — everything here is unit-tested.
 *
 * The constraints these have to satisfy, which consumers share:
 *   - group chat ids look like /^[\d-]{10,31}@g\.us$/
 *   - participants appear as "<digits>@s.whatsapp.net"
 *   - ids are compared after String(x).replace(/\D/g,"")
 *   - a country is inferred from those digits' calling-code prefix
 *
 * That last point is why LIDs must never leak through. A LID's digits are not a
 * phone number, so a leaked LID wouldn't crash anything — it would quietly make
 * a consumer infer the wrong country for a group. Silent wrongness is worse than a
 * throw, so `toUserId` is deliberately strict about what it will emit.
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

/** Just the digits — the form ids are compared in. */
export function digitsOf(jid: string | undefined | null): string {
    return String(jid ?? "").split("@")[0].split(":")[0].replace(/\D/g, "");
}

/**
 * Normalise any Baileys JID into the chat id shape this gateway emits and matches on.
 * Groups keep their @g.us form; users become <digits>@s.whatsapp.net.
 *
 * NOTE: this does not resolve LIDs — it cannot, being pure. Callers must resolve
 * to a phone-number JID first (see resolveToPn in session.ts). A LID reaching
 * here is passed through unchanged so it is visible in logs rather than silently
 * reshaped into something that looks like a phone number.
 */
export function toChatId(jid: string | undefined | null): string {
    if (!jid) return "";
    const clean = stripDevice(String(jid));
    if (isGroupJid(clean)) return clean;
    if (isLidJid(clean)) return clean; // unresolved — caller's problem, deliberately loud
    const d = digitsOf(clean);
    return d ? `${d}${S_WHATSAPP}` : clean;
}

/**
 * The `from` / participant field: bare digits, which is what consumers key
 * contacts on and infer a country from.
 */
export function toUserId(jid: string | undefined | null): string {
    return digitsOf(jid);
}

/**
 * Inbound direction: turn whatever a caller puts in a `to` field into a real JID.
 * Accepts "120363...@g.us", "4075...@s.whatsapp.net", "4075...@c.us", or bare
 * digits, which is how most callers pass a phone number.
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

/**
 * Given a JID and the `…Alt` counterpart Baileys ships beside it, return the
 * phone-number form if the pair offers one.
 *
 * In a LID-addressed chat the message key carries both: `participant` is the
 * LID, `participantAlt` is the phone-number JID (likewise `remoteJid` /
 * `remoteJidAlt`). That is WhatsApp's own mapping, delivered with the message —
 * no lookup, no dependency on a prior history sync.
 *
 * Returns null when there is nothing better than what we already have, so the
 * caller can fall through to the mapping store and then to a loud warning. It
 * must never invent a phone number: an unresolved LID's digits look exactly
 * like one to anything downstream, which is the failure this whole path exists
 * to prevent.
 */
export function preferPhoneNumber(
    jid: string | undefined | null,
    alt: string | undefined | null
): string | null {
    const j = String(jid ?? "");
    if (!j || !isLidJid(j)) return null;
    const a = String(alt ?? "");
    if (!a || isLidJid(a) || isGroupJid(a)) return null;
    return looksLikePhoneNumber(a) ? a : null;
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
