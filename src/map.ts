import type { proto } from "baileys";

/**
 * Classifying a Baileys message: what kind of thing is it, and what does the
 * caller need to fetch before it can be forwarded?
 *
 * Pure on purpose, and separate from the shapes in `cloud.ts` that consume it.
 * All I/O — media download, LID resolution — happens in session.ts and is passed
 * back in as already-resolved values, which is what keeps both files testable
 * without a live socket.
 */

export type MediaKind = "image" | "gif" | "voice" | "audio";

export interface Classification {
    /** How a consumer should read this message. "skip" means don't forward at all. */
    kind: "text" | MediaKind | "document" | "link_preview" | "reaction" | "contacts" | "skip";
    /** Plain body text, when there is one. */
    text?: string;
    /** Caption riding along with media. */
    caption?: string;
    /** For link_preview: the unfurled card. */
    preview?: { title: string; description?: string };
    /**
     * Someone reacted to a message. `emoji` is empty when the reaction was
     * removed, which is Meta's convention too — and the difference matters:
     * a consumer that treats a removal as a new reaction answers a person who
     * just took theirs back.
     */
    reaction?: { messageId: string; emoji: string };
    /** Shared contact cards: the name and numbers from each vCard. */
    contacts?: SharedContact[];
    /** Populated for media kinds — the node session.ts must download. */
    mediaKind?: MediaKind;
    /**
     * Set for a document. Deliberately NOT a `mediaKind`: documents are never
     * downloaded on receipt. Only the metadata travels, and the bytes are
     * fetched from WhatsApp if and when a client asks for them.
     */
    document?: {
        filename?: string;
        mimetype?: string;
        sha256?: string;
        size?: number;
    };
}

/** Unwrap the layers WhatsApp wraps messages in (ephemeral, view-once, edits). */
export function unwrap(
    message: proto.IMessage | null | undefined
): proto.IMessage | undefined {
    let m = message ?? undefined;
    // Bounded: these wrappers nest at most a few deep, but never trust remote input
    // with a `while (true)`.
    for (let i = 0; i < 5 && m; i++) {
        if (m.ephemeralMessage?.message) { m = m.ephemeralMessage.message; continue; }
        if (m.viewOnceMessage?.message) { m = m.viewOnceMessage.message; continue; }
        if (m.viewOnceMessageV2?.message) { m = m.viewOnceMessageV2.message; continue; }
        if (m.viewOnceMessageV2Extension?.message) { m = m.viewOnceMessageV2Extension.message; continue; }
        if (m.documentWithCaptionMessage?.message) { m = m.documentWithCaptionMessage.message; continue; }
        if (m.editedMessage?.message) { m = m.editedMessage.message; continue; }
        break;
    }
    return m;
}

/**
 * The JIDs WhatsApp says were mentioned in this message.
 *
 * Every message type can carry a `contextInfo`, and mentions live there rather
 * than in the body — the body only holds `@<user-part>` text. In a LID-addressed
 * group that user part is a LID, so the raw text reads `@81656102801535`, which
 * is 14 digits that look exactly like a phone number to anything downstream.
 *
 * Taking the list from here rather than pattern-matching the text is the whole
 * point: a regex over free text would also rewrite a number somebody typed.
 */
export function mentionedJidsOf(message: proto.IMessage | null | undefined): string[] {
    return (contextInfoOf(message)?.mentionedJid || []).filter((j): j is string => !!j);
}

/**
 * The `contextInfo` node, wherever it lives.
 *
 * Every message type carries its own, so this is a lookup rather than a field —
 * and getting it from all of them is what makes replies work for a photo or a
 * voice note and not only for text.
 */
function contextInfoOf(message: proto.IMessage | null | undefined): proto.IContextInfo | undefined {
    const m = unwrap(message);
    if (!m) return undefined;
    return (
        m.extendedTextMessage?.contextInfo ||
        m.imageMessage?.contextInfo ||
        m.videoMessage?.contextInfo ||
        m.audioMessage?.contextInfo ||
        m.documentMessage?.contextInfo ||
        m.stickerMessage?.contextInfo ||
        m.contactMessage?.contextInfo ||
        m.contactsArrayMessage?.contextInfo ||
        undefined
    );
}

/** The message this one replies to, if it replies to anything. */
export interface QuotedContext {
    /** Id of the quoted message. */
    id: string;
    /** Who sent the quoted message — a JID, still possibly a LID. */
    participant?: string;
}

/**
 * Is this message a reply, and to what?
 *
 * Keyed on `stanzaId`, not on `contextInfo` existing: contextInfo is also
 * present for a message that merely has mentions or a forwarding score, so
 * treating its presence as "this is a reply" would put a context on messages
 * that reply to nothing.
 *
 * A message quoting one the gateway itself sent is an ordinary reply and
 * reported like any other — the bot's own number is a perfectly good `from`,
 * and suppressing it would hide exactly the case a bot most wants to see.
 */
export function quotedContextOf(message: proto.IMessage | null | undefined): QuotedContext | undefined {
    const ctx = contextInfoOf(message);
    if (!ctx?.stanzaId) return undefined;
    return { id: ctx.stanzaId, participant: ctx.participant || undefined };
}

/**
 * Was this message passed on rather than written? Meta's own fields:
 * `context.forwarded`, and `context.frequently_forwarded` for WhatsApp's
 * "forwarded many times" mark (a forwarding score above 4, which is when the
 * app shows the double arrow). Undefined when it wasn't forwarded, so every
 * other payload stays byte-identical.
 */
export function forwardedOf(message: proto.IMessage | null | undefined): { forwarded: true; frequently_forwarded?: true } | undefined {
    const ctx = contextInfoOf(message);
    const score = Number(ctx?.forwardingScore || 0);
    if (!ctx?.isForwarded && score <= 0) return undefined;
    return score > 4 ? { forwarded: true, frequently_forwarded: true } : { forwarded: true };
}

export function classify(message: proto.IMessage | null | undefined): Classification {
    const m = unwrap(message);
    if (!m) return { kind: "skip" };

    if (m.conversation) {
        return { kind: "text", text: m.conversation };
    }

    if (m.extendedTextMessage) {
        const e = m.extendedTextMessage;
        const body = e.text || "";
        // A link preview with no body of its own is the only case a consumer's
        // link_preview branch can actually reach (text takes priority there).
        if (!body && e.matchedText) {
            return {
                kind: "link_preview",
                preview: { title: e.title || e.matchedText, description: e.description || undefined },
            };
        }
        return { kind: "text", text: body };
    }

    if (m.imageMessage) {
        return {
            kind: "image",
            mediaKind: "image",
            caption: m.imageMessage.caption || undefined,
        };
    }

    if (m.videoMessage) {
        // WhatsApp ships GIFs as videos with gifPlayback set. Consumers often
        // treat the two differently, so keep them apart rather than flattening.
        const isGif = !!m.videoMessage.gifPlayback;
        return {
            kind: isGif ? "gif" : "skip",
            mediaKind: isGif ? "gif" : undefined,
            caption: m.videoMessage.caption || undefined,
        };
    }

    if (m.documentMessage) {
        const d = m.documentMessage;
        return {
            kind: "document",
            caption: d.caption || undefined,
            document: {
                filename: d.fileName || undefined,
                mimetype: d.mimetype || undefined,
                sha256: d.fileSha256 ? Buffer.from(d.fileSha256).toString("base64") : undefined,
                size: d.fileLength ? Number(d.fileLength) : undefined,
            },
        };
    }

    if (m.audioMessage) {
        const isVoice = !!m.audioMessage.ptt;
        return { kind: isVoice ? "voice" : "audio", mediaKind: isVoice ? "voice" : "audio" };
    }

    // A reaction is somebody answering a specific message without typing — in a
    // 1:1 especially, a thumbs-up IS the reply. It used to be dropped here with
    // the stickers, which left a bot talking to someone it believed had gone
    // silent. Meta models it as an ordinary inbound message of type "reaction".
    if (m.reactionMessage?.key?.id) {
        return {
            kind: "reaction",
            reaction: {
                messageId: String(m.reactionMessage.key.id),
                emoji: String(m.reactionMessage.text || ""),
            },
        };
    }

    // A contact card (or several): someone handing over a person's number is
    // asking the bot to do something with it — save it, write to them, add
    // them to a group. Meta delivers these as type "contacts".
    const cards = m.contactMessage ? [m.contactMessage] : m.contactsArrayMessage?.contacts || [];
    if (cards.length) {
        const contacts = cards.map((c) => parseVcard(c?.vcard || "", c?.displayName || "")).filter((c) => c.name || c.phones.length);
        if (contacts.length) return { kind: "contacts", contacts };
    }

    // Stickers, locations, polls, protocol messages: there is no
    // payload shape for these, so forwarding an empty envelope would only make
    // a consumer log and discard it.
    return { kind: "skip" };
}

/**
 * One mentioned identity, carrying both ids.
 *
 * LID is WhatsApp's canonical identifier going forward, and phone numbers are
 * the thing being migrated away from — so the LID is what a consumer should key
 * on, and `phone` is a convenience that may be null now and may disappear
 * entirely later. Neither is dropped, so a consumer has a migration path rather
 * than a cliff.
 */
export interface MentionedIdentity {
    /** Canonical id. Null only for a mention that arrived as a phone JID whose LID we have never seen. */
    lid: string | null;
    /** Null when the mapping does not have it — that is expected, not an error. */
    phone: string | null;
}

export interface ResolvedIds {
    /** Every @-mention in this message, both ids each. */
    mentions?: MentionedIdentity[];
    /** The sender's LID, when known, beside the phone number in `from`. */
    senderLid?: string | null;
    /**
     * Set only when the message is a reply. Additive: everything else in the
     * payload is unchanged whether this is present or not.
     */
    context?: { id?: string; from?: string; forwarded?: boolean; frequently_forwarded?: boolean };
    /** Already LID-resolved chat JID. */
    chatJid: string;
    /** Already LID-resolved sender JID (for groups: the participant). */
    senderJid: string;
    chatName?: string;
    senderName?: string;
}

export interface ResolvedMedia {
    /** Publicly fetchable URL of the full-resolution media. */
    link?: string;
    /** Base64 data URI of the thumbnail, or the same URL when there is no thumb. */
    preview?: string;
}


/** One shared contact, as much of it as a bot needs. */
export interface SharedContact {
    name: string;
    phones: { phone: string; waId?: string; type?: string }[];
    emails: string[];
    org?: string;
}

/**
 * The parts of a vCard worth passing on. WhatsApp writes them itself
 * (`TEL;type=CELL;waid=40712345678:+40 712 345 678`), but a card shared from a
 * phone's address book can carry anything, so this reads leniently: unfolded
 * lines, any parameter order, quoted-printable left alone.
 */
export function parseVcard(vcard: string, displayName = ""): SharedContact {
    const lines = vcard.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
    const out: SharedContact = { name: displayName.trim(), phones: [], emails: [] };
    for (const line of lines) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const [prop, ...params] = line.slice(0, i).split(";");
        const value = line.slice(i + 1).trim();
        const key = prop.replace(/^item\d+\./i, "").toUpperCase();
        const param = (n: string) => params.find((x) => x.toLowerCase().startsWith(n + "="))?.split("=")[1];
        if (key === "FN" && value && !out.name) out.name = value;
        else if (key === "ORG" && value) out.org = value.split(";").filter(Boolean).join(", ");
        else if (key === "EMAIL" && value) out.emails.push(value);
        else if (key === "TEL" && value) {
            const waId = param("waid");
            const type = param("type") || params.find((x) => !x.includes("="));
            out.phones.push({ phone: value, ...(waId ? { waId } : {}), ...(type ? { type: type.toUpperCase() } : {}) });
        }
    }
    return out;
}
