import type { proto } from "baileys";
import { isGroupJid, toChatId, toUserId } from "./jid.js";
import type { Classification, ResolvedIds, ResolvedMedia } from "./map.js";

/**
 * WhatsApp Cloud API compatible shapes.
 *
 * The point of this file is that someone already running against Meta's Cloud
 * API can change their base URL and stop. Same request bodies, same response
 * envelope, same webhook nesting — so their existing parsing code, whatever
 * language it is in, keeps working untouched.
 *
 * Where Meta and this gateway genuinely differ, the difference is capability,
 * not format:
 *
 *   - Meta's Groups API only addresses groups the business itself created, with
 *     the business as admin. A linked-device client has no such restriction, so
 *     `recipient_type: "group"` here works for any group the number is in.
 *   - Meta's group ids are opaque tokens ("Y2FwaV9ncm91cDo…") minted by its
 *     Groups API. There is no equivalent, so ids here are WhatsApp's own group
 *     ids. They are still just strings you echo back.
 *   - Meta requires an approved template to open a conversation outside the
 *     24-hour service window. That window does not exist here.
 *
 * Everything in this file is pure, for the same reason `map.ts` is: the shapes
 * are the contract, and a contract you cannot unit-test is a contract you find
 * out about in production.
 */

/** Thrown for a body Meta itself would reject. Routes turn it into a 400. */
export class CloudRequestError extends Error {
    constructor(
        message: string,
        readonly code = 100,
        readonly details?: string
    ) {
        super(message);
    }
}

/** Meta's error envelope, so existing error handling keeps matching. */
export function buildCloudError(e: CloudRequestError | Error) {
    const err = e instanceof CloudRequestError ? e : new CloudRequestError(e.message, 500);
    return {
        error: {
            message: err.message,
            type: "OAuthException",
            code: err.code,
            error_data: err.details ? { details: err.details } : undefined,
            fbtrace_id: undefined,
        },
    };
}

export type CloudSendKind =
    | { type: "text"; body: string; previewUrl: boolean }
    | { type: "image"; media: string; caption?: string }
    | { type: "audio"; media: string }
    | { type: "video"; media: string; caption?: string }
    | { type: "document"; media: string; caption?: string; filename?: string }
    | { type: "sticker"; media: string }
    | { type: "reaction"; messageId: string; emoji: string }
    | { type: "location"; latitude: number; longitude: number; name?: string; address?: string }
    | { type: "poll"; name: string; options: string[]; selectableCount: number }
    | { type: "read"; messageId: string; typing: boolean };

export interface CloudSendRequest {
    to: string;
    recipientType: "individual" | "group";
    kind: CloudSendKind;
}

/** `id` or `link` — Meta accepts either; only `link` means anything here. */
function mediaRef(o: any, type: string): string {
    const link = o?.link ?? o?.id;
    if (!link || typeof link !== "string") {
        throw new CloudRequestError(
            `(#100) Missing or invalid parameter: ${type}.link is required`,
            100,
            `Provide ${type}.link with an https URL, a data: URI, or base64.`
        );
    }
    return link;
}

/**
 * Parse a Cloud API send request.
 *
 * Deliberately strict about `messaging_product`, exactly as Meta is: getting a
 * clear "expected whatsapp" beats a silent success when someone points a
 * half-configured client at this.
 */
export function parseCloudSendRequest(body: any): CloudSendRequest {
    if (!body || typeof body !== "object") {
        throw new CloudRequestError("(#100) Invalid parameter", 100, "Body must be a JSON object.");
    }

    if (body.messaging_product !== "whatsapp") {
        throw new CloudRequestError(
            "(#100) Missing or invalid parameter: messaging_product",
            100,
            'messaging_product must be "whatsapp".'
        );
    }

    // Mark-as-read and typing indicators are a status update, not a message, and
    // carry no `to` at all — Meta overloads the same endpoint for them.
    if (body.status === "read") {
        if (!body.message_id) {
            throw new CloudRequestError(
                "(#100) Missing or invalid parameter: message_id",
                100,
                "A status update requires the message_id being marked read."
            );
        }
        return {
            to: "",
            recipientType: "individual",
            kind: {
                type: "read",
                messageId: String(body.message_id),
                typing: !!body.typing_indicator,
            },
        };
    }

    const to = String(body.to ?? "").trim();
    if (!to) {
        throw new CloudRequestError(
            "(#100) Missing or invalid parameter: to",
            100,
            "Provide the recipient's phone number, or a group id with recipient_type group."
        );
    }

    const recipientType = body.recipient_type === "group" ? "group" : "individual";
    const type = String(body.type ?? "text");
    const content = body[type];

    switch (type) {
        case "text": {
            const text = content?.body;
            if (typeof text !== "string" || !text) {
                throw new CloudRequestError(
                    "(#100) Missing or invalid parameter: text.body",
                    100,
                    "text.body must be a non-empty string."
                );
            }
            // preview_url defaults to false in Meta's API.
            return { to, recipientType, kind: { type: "text", body: text, previewUrl: !!content?.preview_url } };
        }
        case "image":
            return { to, recipientType, kind: { type: "image", media: mediaRef(content, "image"), caption: content?.caption } };
        case "audio":
            return { to, recipientType, kind: { type: "audio", media: mediaRef(content, "audio") } };
        case "video":
            return { to, recipientType, kind: { type: "video", media: mediaRef(content, "video"), caption: content?.caption } };
        case "document":
            return {
                to,
                recipientType,
                kind: {
                    type: "document",
                    media: mediaRef(content, "document"),
                    caption: content?.caption,
                    filename: content?.filename,
                },
            };
        case "sticker":
            return { to, recipientType, kind: { type: "sticker", media: mediaRef(content, "sticker") } };
        case "reaction": {
            if (!content?.message_id) {
                throw new CloudRequestError(
                    "(#100) Missing or invalid parameter: reaction.message_id",
                    100,
                    "reaction.message_id must be the id of the message being reacted to."
                );
            }
            // An empty emoji removes the reaction — that is Meta's behaviour too.
            return {
                to,
                recipientType,
                kind: { type: "reaction", messageId: String(content.message_id), emoji: String(content.emoji ?? "") },
            };
        }
        case "location": {
            const lat = Number(content?.latitude);
            const lng = Number(content?.longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                throw new CloudRequestError(
                    "(#100) Missing or invalid parameter: location.latitude/longitude",
                    100,
                    "Both latitude and longitude must be numbers."
                );
            }
            return {
                to,
                recipientType,
                kind: { type: "location", latitude: lat, longitude: lng, name: content?.name, address: content?.address },
            };
        }
        // Not a Meta type — Meta's Cloud API cannot send a poll at all. WhatsApp
        // can, this gateway can, and refusing to express that would mean anyone
        // adopting the Cloud shape silently loses polls and falls back to
        // posting a numbered list as text. Extended here for the same reason the
        // `message_polls` webhook field exists on the receive side.
        case "poll": {
            const name = content?.name;
            const options: string[] = (content?.options || [])
                .map((o: any) => String(o ?? "").trim())
                .filter(Boolean);
            if (typeof name !== "string" || !name || options.length < 2) {
                throw new CloudRequestError(
                    "(#100) Missing or invalid parameter: poll",
                    100,
                    "poll.name must be a non-empty string and poll.options at least two entries."
                );
            }
            // `selectable_count` is WhatsApp's own encoding: how many options one
            // person may pick. It passes straight through to the protocol, so it
            // expresses things neither Meta nor the older APIs can — "choose up
            // to 2 of 5" is just `2`.
            //
            // `allow_multiple_answers` is accepted as a convenience for clients
            // written against the boolean, and means "as many as there are".
            // Deliberately NOT the inverted `0 means unlimited` convention: 0 is
            // indistinguishable from "unset" and reads as a bug at every call site.
            const raw = content?.selectable_count;
            let selectableCount: number;
            if (raw !== undefined && raw !== null && raw !== "") {
                selectableCount = Number(raw);
                if (!Number.isInteger(selectableCount) || selectableCount < 1) {
                    throw new CloudRequestError(
                        "(#100) Missing or invalid parameter: poll.selectable_count",
                        100,
                        "selectable_count is how many options one person may pick: at least 1."
                    );
                }
                if (selectableCount > options.length) {
                    throw new CloudRequestError(
                        "(#100) Missing or invalid parameter: poll.selectable_count",
                        100,
                        `selectable_count (${selectableCount}) cannot exceed the ${options.length} options given.`
                    );
                }
            } else {
                selectableCount = content?.allow_multiple_answers ? options.length : 1;
            }

            return { to, recipientType, kind: { type: "poll", name, options, selectableCount } };
        }
        case "template":
            throw new CloudRequestError(
                "(#100) Unsupported parameter: template",
                100,
                "Templates exist to open a conversation outside Meta's 24-hour service " +
                    "window. This gateway has no such window — send the message directly as text."
            );
        default:
            throw new CloudRequestError(
                `(#100) Missing or invalid parameter: type`,
                100,
                `"${type}" is not a supported message type here. Supported: text, image, ` +
                    `audio, video, document, sticker, reaction, location, poll.`
            );
    }
}

/**
 * Meta's send response. `contacts[].input` echoes exactly what was sent, which
 * clients do rely on to correlate.
 */
export function buildCloudSendResponse(input: string, waId: string, messageId?: string) {
    return {
        messaging_product: "whatsapp",
        contacts: [{ input, wa_id: waId }],
        messages: [{ id: messageId || "" }],
    };
}

export interface CloudMetadata {
    /** The linked number in display form, as Meta shows it. */
    displayPhoneNumber: string;
    /** Stable per-number id, the analogue of Meta's phone_number_id. */
    phoneNumberId: string;
    /** Analogue of Meta's WhatsApp Business Account id. */
    businessAccountId: string;
}

/** The `entry[].changes[]` envelope every Cloud webhook is wrapped in. */
function envelope(meta: CloudMetadata, field: string, value: Record<string, any>) {
    return {
        object: "whatsapp_business_account",
        entry: [
            {
                id: meta.businessAccountId,
                changes: [
                    {
                        value: {
                            messaging_product: "whatsapp",
                            metadata: {
                                display_phone_number: meta.displayPhoneNumber,
                                phone_number_id: meta.phoneNumberId,
                            },
                            ...value,
                        },
                        field,
                    },
                ],
            },
        ],
    };
}

/**
 * An inbound message, in Cloud API shape.
 *
 * `group_id` on the message and the participant's number in `from` is exactly
 * how Meta represents a group message, so a client written against its Groups
 * API reads this without changes.
 */
export function buildCloudMessageEvent(
    waMessage: proto.IWebMessageInfo,
    cls: Classification,
    ids: ResolvedIds,
    meta: CloudMetadata,
    media?: ResolvedMedia
): Record<string, any> | null {
    if (cls.kind === "skip") return null;

    const chatId = toChatId(ids.chatJid);
    const isGroup = isGroupJid(chatId);
    const from = toUserId(ids.senderJid);

    const message: Record<string, any> = {
        from,
        id: waMessage.key?.id || "",
        timestamp: String(Number(waMessage.messageTimestamp) || Math.floor(Date.now() / 1000)),
    };
    if (isGroup) message.group_id = chatId;
    // Meta's own shape for a reply, and set only when there is one. Added before
    // the type switch so it applies to every kind of message, not just text.
    if (ids.context) message.context = ids.context;

    switch (cls.kind) {
        case "text":
            message.type = "text";
            message.text = { body: cls.text || "" };
            break;
        case "image":
            message.type = "image";
            message.image = { link: media?.link, caption: cls.caption, mime_type: "image/jpeg" };
            break;
        case "gif":
            // Meta has no GIF type; WhatsApp itself ships them as video.
            message.type = "video";
            message.video = { link: media?.link, caption: cls.caption, mime_type: "video/mp4" };
            break;
        case "voice":
            message.type = "audio";
            message.audio = { link: media?.link, voice: true, mime_type: "audio/ogg" };
            break;
        case "audio":
            message.type = "audio";
            message.audio = { link: media?.link, voice: false, mime_type: "audio/ogg" };
            break;
        case "link_preview":
            // A link preview is a text message with an unfurled card. Meta models
            // it as plain text, so the body is what a client actually gets.
            message.type = "text";
            message.text = { body: cls.preview?.title || "" };
            break;
    }

    const value: Record<string, any> = { messages: [message] };
    if (ids.senderName) {
        value.contacts = [{ profile: { name: ids.senderName }, wa_id: from }];
    }
    return envelope(meta, "messages", value);
}

/**
 * Group membership changes, in the shape Meta's Groups API webhooks use.
 *
 * Meta splits these across `group_participants_update` and
 * `group_lifecycle_update`; a roster snapshot maps onto the former.
 */
export function buildCloudGroupEvent(
    groupJid: string,
    subject: string,
    participants: Array<{ id: string; name?: string }>,
    meta: CloudMetadata
): Record<string, any> {
    return envelope(meta, "group_participants_update", {
        groups: [
            {
                group_id: toChatId(groupJid),
                subject,
                participants: participants.map((p) => ({ wa_id: toUserId(p.id), name: p.name })),
            },
        ],
    });
}

/** Contact profile names, as Meta delivers them on a `contacts` change. */
export function buildCloudContactsEvent(
    contacts: Array<{ id: string; name: string }>,
    meta: CloudMetadata
): Record<string, any> {
    return envelope(meta, "contacts", {
        contacts: contacts.map((c) => ({ profile: { name: c.name }, wa_id: c.id })),
    });
}

/**
 * A poll vote, as an inbound message.
 *
 * Meta's Cloud API cannot do polls in either direction, so there is no official
 * shape to copy. This follows how Meta models `button_reply` and `list_reply`:
 * the response is an ordinary inbound message of type `interactive`, whose
 * `context` points at the message being responded to. That context is the join
 * key a tally needs, and it is the same `context` object a reply carries.
 *
 * Three deliberate choices:
 *
 *   - `selected_options` is this voter's COMPLETE current selection, not a
 *     delta. WhatsApp polls are revisable, so a change or a clear is just
 *     another delivery and no consumer has to reconstruct state. Clearing a
 *     vote sends an empty array.
 *   - `results` and `total` carry the full tally every time. A vote-only
 *     payload would force every consumer to accumulate counts itself and get it
 *     subtly wrong; sending the whole picture makes a missed or out-of-order
 *     delivery self-correcting.
 *   - option `id` is the option's index as a string, stable for the life of the
 *     poll, so a consumer can key on it rather than on the title text.
 */
export function buildCloudPollVoteEvent(
    vote: {
        /** Id of this vote event — not the poll's. */
        id: string;
        /** Voter, bare digits. */
        from: string;
        voterName?: string;
        timestamp: number;
        /** The poll message being voted on. */
        pollMessageId: string;
        /** Who sent the poll — this gateway's own number. */
        pollFrom: string;
        groupJid?: string;
        selected: Array<{ id: string; title: string }>;
        results: Array<{ id: string; title: string; count: number; voters: string[] }>;
    },
    meta: CloudMetadata
): Record<string, any> {
    const message: Record<string, any> = {
        from: vote.from,
        id: vote.id,
        timestamp: String(vote.timestamp),
        type: "interactive",
        // The critical field: without it a vote cannot be matched to its poll
        // and the whole delivery is useless.
        context: { from: vote.pollFrom, id: vote.pollMessageId },
        interactive: {
            type: "poll_response",
            poll_response: {
                selected_options: vote.selected,
                results: vote.results,
                total: vote.results.reduce((sum, r) => sum + r.count, 0),
            },
        },
    };
    if (vote.groupJid) message.group_id = toChatId(vote.groupJid);

    const value: Record<string, any> = { messages: [message] };
    if (vote.voterName) {
        value.contacts = [{ profile: { name: vote.voterName }, wa_id: vote.from }];
    }
    return envelope(meta, "messages", value);
}
