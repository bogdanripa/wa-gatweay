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
    kind: "text" | MediaKind | "link_preview" | "skip";
    /** Plain body text, when there is one. */
    text?: string;
    /** Caption riding along with media. */
    caption?: string;
    /** For link_preview: the unfurled card. */
    preview?: { title: string; description?: string };
    /** Populated for media kinds — the node session.ts must download. */
    mediaKind?: MediaKind;
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
    const m = unwrap(message);
    if (!m) return [];
    const ctx =
        m.extendedTextMessage?.contextInfo ||
        m.imageMessage?.contextInfo ||
        m.videoMessage?.contextInfo ||
        m.audioMessage?.contextInfo ||
        m.documentMessage?.contextInfo ||
        m.stickerMessage?.contextInfo;
    return (ctx?.mentionedJid || []).filter((j): j is string => !!j);
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

    if (m.audioMessage) {
        const isVoice = !!m.audioMessage.ptt;
        return { kind: isVoice ? "voice" : "audio", mediaKind: isVoice ? "voice" : "audio" };
    }

    // Stickers, documents, contacts, locations, polls, reactions, protocol
    // messages: there is no payload shape for these, so forwarding an empty
    // envelope would only make a consumer log and discard it.
    return { kind: "skip" };
}

export interface ResolvedIds {
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

