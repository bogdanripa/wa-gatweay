import type { proto } from "baileys";
import { classify, quotedContextOf, unwrap } from "./map.js";

/**
 * Reading a Baileys message for a person (well, a model) rather than a bot:
 * what is it, and what does it say. Pure, like `map.ts`, so it is testable
 * without a socket.
 *
 * Used only on messages the MCP side has just fetched from the phone. Nothing
 * this produces is stored — see `ChatDoc` for why the gateway keeps no history.
 */

/** Wrappers and side-channel fields that are not, by themselves, a message. */
const NOT_CONTENT = new Set(["messageContextInfo", "senderKeyDistributionMessage"]);

/**
 * Message kinds that don't move a chat up the list or count as unread:
 * protocol traffic (deletes, edits, history notifications, key shares),
 * reactions and poll votes. WhatsApp's own app treats them the same way.
 */
const NOT_CONVERSATION = new Set([
    "protocolMessage",
    "reactionMessage",
    "encReactionMessage",
    "pollUpdateMessage",
    "keepInChatMessage",
    "pinInChatMessage",
]);

/** Does this message belong in a conversation — i.e. would a person see it as a new message? */
export function isConversationMessage(message: proto.IMessage | null | undefined): boolean {
    const m = unwrap(message);
    if (!m) return false;
    const keys = Object.keys(m).filter((k) => (m as any)[k] != null && !NOT_CONTENT.has(k));
    if (!keys.length) return false;
    return !keys.every((k) => NOT_CONVERSATION.has(k));
}

export interface MessageSummary {
    /** text, image, video, gif, voice, audio, document, sticker, location, contacts, poll, reaction, link_preview, other */
    type: string;
    /** Body text or caption, when there is one. */
    text?: string;
    filename?: string;
    mimetype?: string;
    /** True when there is media `get_media` can fetch. */
    media?: boolean;
    /** Id of the message this one quotes. */
    replyTo?: string;
    /** For a reaction: the message reacted to, and the emoji ("" means removed). */
    reaction?: { messageId: string; emoji: string };
}

/** What a message is and says, in a shape meant to be read. */
export function describeMessage(message: proto.IMessage | null | undefined): MessageSummary {
    const m = unwrap(message);
    const cls = classify(message);
    const replyTo = quotedContextOf(message)?.id;
    const base = (s: MessageSummary): MessageSummary => (replyTo ? { ...s, replyTo } : s);

    switch (cls.kind) {
        case "text":
            return base({ type: "text", text: cls.text });
        case "link_preview":
            return base({ type: "link_preview", text: cls.preview?.title });
        case "image":
            return base({ type: "image", text: cls.caption, media: true, mimetype: m?.imageMessage?.mimetype || undefined });
        case "gif":
            return base({ type: "gif", text: cls.caption, media: true });
        case "voice":
        case "audio":
            return base({ type: cls.kind, media: true, mimetype: m?.audioMessage?.mimetype || undefined });
        case "document":
            return base({
                type: "document",
                text: cls.caption,
                filename: cls.document?.filename,
                mimetype: cls.document?.mimetype,
                media: true,
            });
        case "reaction":
            return { type: "reaction", reaction: cls.reaction };
        case "contacts":
            return base({
                type: "contacts",
                text: (cls.contacts || [])
                    .map((c) => [c.name, ...c.phones.map((p) => p.phone)].filter(Boolean).join(" "))
                    .join("; "),
            });
    }

    // What `classify` skips, because no bot payload exists for it — but a
    // person reading the chat still wants to know it was there.
    if (m?.videoMessage) return base({ type: "video", text: m.videoMessage.caption || undefined, media: true });
    if (m?.stickerMessage) return base({ type: "sticker", media: true, mimetype: m.stickerMessage.mimetype || undefined });
    if (m?.locationMessage || m?.liveLocationMessage) {
        const l = m.locationMessage || m.liveLocationMessage!;
        const name = (l as proto.Message.ILocationMessage).name || (l as proto.Message.ILocationMessage).address;
        return base({
            type: "location",
            text: [name, `${l.degreesLatitude},${l.degreesLongitude}`].filter(Boolean).join(" "),
        });
    }
    const poll = m?.pollCreationMessage || m?.pollCreationMessageV2 || m?.pollCreationMessageV3;
    if (poll) {
        return base({
            type: "poll",
            text: [poll.name, ...(poll.options || []).map((o) => `- ${o.optionName}`)].filter(Boolean).join("\n"),
        });
    }
    return base({ type: "other" });
}

/**
 * Lower-case and strip diacritics, so "sedinta" finds "ședință" — people type
 * without them all the time, in a chat and in a search box alike.
 */
export function foldForSearch(s: string | undefined | null): string {
    return String(s ?? "")
        .normalize("NFD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase();
}

/** Substring match on folded text. Every whitespace-separated term must appear. */
export function matchesQuery(text: string | undefined | null, query: string): boolean {
    const hay = foldForSearch(text);
    const terms = foldForSearch(query).split(/\s+/).filter(Boolean);
    return terms.length > 0 && terms.every((t) => hay.includes(t));
}

/** Where a history page starts: a message's full key and its time, as the phone's request needs them. */
export interface HistoryAnchor {
    id: string;
    fromMe: boolean;
    participant?: string;
    remoteJid: string;
    /** Unix milliseconds. */
    at: number;
}

/**
 * An opaque paging token for "older than this". The phone's history request
 * needs the anchor's whole key and timestamp, and the gateway keeps no copy of
 * the messages to look them up from — so the cursor carries them itself.
 */
export function encodeCursor(a: HistoryAnchor): string {
    return Buffer.from(JSON.stringify([a.id, a.fromMe ? 1 : 0, a.participant || "", a.remoteJid, a.at])).toString(
        "base64url"
    );
}

export function decodeCursor(cursor: string): HistoryAnchor | null {
    try {
        const [id, fromMe, participant, remoteJid, at] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (typeof id !== "string" || typeof remoteJid !== "string" || !Number.isFinite(at)) return null;
        return { id, fromMe: !!fromMe, participant: participant || undefined, remoteJid, at };
    } catch {
        return null;
    }
}
