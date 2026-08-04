import type { proto } from "baileys";
import { isGroupJid, toWhapiChatId, toWhapiUserId } from "./jid.js";

/**
 * Baileys events -> whapi-shaped webhook payloads.
 *
 * The whole point of this file is that gepetel's `POST /whapi` handler does not
 * change. Every field emitted here is one gepetel actually reads; I walked its
 * app.ts handler and mapped them one for one. Anything gepetel ignores is left
 * out rather than approximated.
 *
 * Split into a pure `classify` (what kind of message is this?) and a pure
 * `buildWhapiMessage` (assemble the payload) so both are unit-testable without a
 * live socket. All I/O — media download, LID resolution — happens in session.ts
 * and is passed in as already-resolved values.
 */

export type MediaKind = "image" | "gif" | "voice" | "audio";

export interface Classification {
    /** How gepetel should read this message. "skip" means don't forward at all. */
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

export function classify(message: proto.IMessage | null | undefined): Classification {
    const m = unwrap(message);
    if (!m) return { kind: "skip" };

    if (m.conversation) {
        return { kind: "text", text: m.conversation };
    }

    if (m.extendedTextMessage) {
        const e = m.extendedTextMessage;
        const body = e.text || "";
        // A link preview with no body of its own is the only case gepetel's
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
        // WhatsApp ships GIFs as videos with gifPlayback set. gepetel treats the
        // two differently (it describes a GIF's thumbnail), so keep them apart.
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
    // messages: gepetel has no branch for these and logs+skips them anyway.
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

/**
 * Assemble the whapi `messages[]` entry. Returns null for anything gepetel would
 * discard, so the caller can avoid an empty webhook round trip.
 */
export function buildWhapiMessage(
    waMessage: proto.IWebMessageInfo,
    cls: Classification,
    ids: ResolvedIds,
    media?: ResolvedMedia
): Record<string, any> | null {
    if (cls.kind === "skip") return null;

    const chatId = toWhapiChatId(ids.chatJid);
    const isGroup = isGroupJid(chatId);

    const base: Record<string, any> = {
        id: waMessage.key?.id || "",
        from_me: !!waMessage.key?.fromMe,
        type: cls.kind === "link_preview" ? "link_preview" : cls.kind,
        chat_id: chatId,
        // gepetel only uses chat_name for groups; for DMs whapi sends the contact
        // name, which gepetel ignores in favour of from_name.
        chat_name: isGroup ? ids.chatName || "" : ids.senderName || "",
        from: toWhapiUserId(ids.senderJid),
        from_name: ids.senderName || "",
        timestamp: Number(waMessage.messageTimestamp) || Math.floor(Date.now() / 1000),
    };

    switch (cls.kind) {
        case "text":
            base.text = { body: cls.text || "" };
            break;

        case "image":
            // gepetel prefers image.link (full res) and falls back to image.preview.
            base.image = {
                link: media?.link,
                preview: media?.preview || media?.link,
                caption: cls.caption,
            };
            break;

        case "gif":
            // gepetel reads gif.preview only — it describes the still, not the loop.
            base.gif = { preview: media?.preview || media?.link, caption: cls.caption };
            break;

        case "voice":
            base.voice = { link: media?.link };
            break;

        case "audio":
            base.audio = { link: media?.link };
            break;

        case "link_preview":
            base.link_preview = {
                title: cls.preview?.title || "",
                description: cls.preview?.description,
                preview: media?.preview,
            };
            break;
    }

    return base;
}

/**
 * whapi's `groups[]` event shape. gepetel reads `id`, `name` and
 * `participants[].id/.name/.pushname`, then re-fetches the authoritative roster
 * via GET /groups/:id anyway.
 */
export function buildWhapiGroupEvent(
    groupJid: string,
    subject: string,
    participants: Array<{ id: string; name?: string }>
): Record<string, any> {
    return {
        id: toWhapiChatId(groupJid),
        name: subject || "",
        participants: participants.map((p) => ({
            id: toWhapiUserId(p.id),
            name: p.name,
        })),
    };
}

/**
 * whapi's `messages_updates[]` poll-tally shape. gepetel looks for an entry whose
 * `type === "poll"` with a `poll.results` array of { name, count, voters }.
 */
export function buildWhapiPollUpdate(
    messageId: string,
    chatJid: string,
    pollName: string,
    votes: Array<{ name: string; voters: string[] }>
): Record<string, any> {
    const results = votes.map((v) => ({
        name: v.name,
        count: v.voters.length,
        voters: v.voters.map(toWhapiUserId),
    }));
    return {
        after_update: {
            id: messageId,
            type: "poll",
            chat_id: toWhapiChatId(chatJid),
            poll: {
                name: pollName,
                results,
                total: results.reduce((s, r) => s + r.count, 0),
            },
        },
    };
}
