import { Router, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { WAMessage } from "baileys";
import { z } from "zod";
import { logger } from "./log.js";
import { Session } from "./session.js";
import type { SessionManager } from "./sessions.js";
import { resourceMetadataUrlOf, type OAuthService } from "./oauth.js";
import type { ChatDoc } from "./store.js";
import type { CloudSendKind } from "./cloud.js";
import { decodeCursor, describeMessage, encodeCursor } from "./chatlog.js";
import { isGroupJid, toWaJid } from "./jid.js";
import { MAX_UPLOAD_BYTES, type UploadStore } from "./uploads.js";
import { sendKindFor } from "./sniff.js";
import { fitForModel } from "./imageFit.js";



/**
 * `/api/mcp`: one WhatsApp number as a Model Context Protocol server, so an
 * assistant can read and write as that account.
 *
 * This is a different thing from the Cloud API surface and deliberately kept
 * apart from it. That one is a compatibility contract with bots we cannot see;
 * this one is a tool surface for a person's own assistant, opt-in per number
 * and authorised by OAuth (`oauth.ts`): an assistant signs in once, the
 * operator approves it for one number, and it holds a token for that number
 * only. A bot token can never open it and an MCP token can never drive the
 * bot API.
 *
 * It keeps no message history. WhatsApp's servers have none and offer no
 * search, so reading or searching a chat asks the phone for pages of history
 * and discards them after answering — see `Session.readChat`. What is stored is
 * metadata: the chat list and people's names.
 *
 * Stateless Streamable HTTP with JSON responses: a fresh server per request,
 * no session ids, no SSE stream for the edge proxy to buffer or cut.
 */

const bearerOf = (req: Request): string => {
    const hdr = req.get("authorization") || "";
    return hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
};

const text = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }] });
const failure = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }], isError: true });

/** `2026-11-19 14:03` in UTC — short, sortable, and unambiguous with the Z. */
function when(d: Date): string {
    return d.toISOString().slice(0, 16).replace("T", " ") + "Z";
}

/** One message as a line a model can read cheaply. */
function renderMessage(m: WAMessage, sender: string): string {
    const d = describeMessage(m.message);
    const at = when(new Date(Number(m.messageTimestamp || 0) * 1000));
    const id = m.key?.id || "?";
    let body: string;
    if (d.type === "text" || d.type === "link_preview") body = d.text || "";
    else if (d.type === "reaction") body = `<reacted ${d.reaction?.emoji || "(removed)"} to ${d.reaction?.messageId}>`;
    else {
        const label = d.type === "document" && d.filename ? `document: ${d.filename}` : d.type;
        body = `<${label}${d.media ? ", get_media available" : ""}>${d.text ? ` ${d.text}` : ""}`;
    }
    const reply = d.replyTo ? ` (reply to ${d.replyTo})` : "";
    return `[${at}] ${sender} {id:${id}}${reply}: ${body}`;
}

function senderLabel(m: WAMessage, chat: ChatDoc, names: Map<string, { id: string; name?: string }>): string {
    if (m.key?.fromMe) return "me";
    const raw = chat.isGroup ? m.key?.participant || m.participant : m.key?.remoteJid;
    const who = raw ? names.get(raw) : undefined;
    if (!who) return "unknown";
    return who.name ? `${who.name} (${who.id})` : who.id;
}

function chatTitle(chat: ChatDoc, fallback?: string): string {
    const id = Session.chatIdOf(chat.jid);
    const name = chat.name || fallback;
    return name ? `${name} (${id})` : id;
}

const messageId = z.string().min(1).max(128).describe("A message id, as shown in {id:…} by read_chat or search_chat.");
const chatRef = z
    .string()
    .min(1)
    .describe(
        "The chat: a phone number with country code (digits, e.g. 40722123456), or a group id ending in @g.us. " +
            "Use search_contacts or list_chats to find it."
    );

export function buildMcpServer(session: Session, uploads: UploadStore): McpServer {
    const server = new McpServer(
        { name: "whatsapp", version: "1.0.0" },
        {
            instructions:
                `WhatsApp, acting as the account linked to "${session.id}"${session.me?.name ? ` (${session.me.name})` : ""}. ` +
                "Messages you send go out as this person — confirm content and recipient with the user before sending, " +
                "editing or deleting. Find people and groups with search_contacts or list_chats; read a conversation " +
                "with read_chat before replying to it. Chat history is fetched live from the account's phone, so " +
                "read_chat and search_chat need that phone online and take a few seconds per page.",
        }
    );

    /** Every tool goes through here: one log line per call (name only — never arguments, which carry content). */
    const tool = <S extends z.ZodRawShape>(
        name: string,
        config: { title: string; description: string; inputSchema: S; annotations?: Record<string, boolean> },
        run: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<CallToolResult>
    ) => {
        server.registerTool(name, config as any, (async (args: any) => {
            const startedAt = Date.now();
            try {
                const result = await run(args);
                logger.info({ session: session.id, tool: name, ms: Date.now() - startedAt }, "MCP tool call");
                return result;
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                logger.warn({ session: session.id, tool: name, e: message, ms: Date.now() - startedAt }, "MCP tool call failed");
                return failure(message);
            }
        }) as any);
    };

    // ------------------------------------------------------------------ reads

    tool(
        "list_chats",
        {
            title: "List recent chats",
            description:
                "Most recently active conversations, newest first, with unread counts. Covers chats with activity " +
                "since MCP access was turned on for this number (plus any WhatsApp announced when the device was linked).",
            inputSchema: {
                limit: z.number().int().min(1).max(100).default(20),
                unread_only: z.boolean().default(false).describe("Only chats with unread messages."),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ limit, unread_only }) => {
            const chats = await session.listChats({ limit, unreadOnly: unread_only });
            if (!chats.length) return text(unread_only ? "No unread chats." : "No chats seen yet.");
            return text(
                chats
                    .map(
                        (c) =>
                            `${c.name || "(no name)"} — chat: ${c.chat_id}${c.is_group ? " [group]" : ""} — last ${when(
                                new Date(c.last_message_at)
                            )}${c.last_message_from_me ? " (by me)" : ""}${c.unread ? ` — ${c.unread} unread` : ""}`
                    )
                    .join("\n")
            );
        }
    );

    tool(
        "search_contacts",
        {
            title: "Search contacts and groups",
            description:
                "Find people and groups by name (saved name, their own WhatsApp name, or group subject) or by part " +
                "of a phone number. Returns the chat id to use with the other tools.",
            inputSchema: {
                query: z.string().min(1),
                limit: z.number().int().min(1).max(50).default(15),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ query, limit }) => {
            const found = await session.searchContacts(query, limit);
            if (!found.length) return text(`Nobody matching "${query}". Try part of the name or number, or check_number for someone new.`);
            return text(
                found
                    .map((c: any) =>
                        c.is_group
                            ? `${c.name} — chat: ${c.chat_id} [group, ${c.participants ?? "?"} members]`
                            : `${c.name || "(no name)"} — chat: ${c.chat_id}${
                                  c.saved_name && c.push_name && c.saved_name !== c.push_name ? ` (calls themselves ${c.push_name})` : ""
                              }${c.phone ? "" : " [phone number unknown]"}`
                    )
                    .join("\n")
            );
        }
    );

    tool(
        "read_chat",
        {
            title: "Read a chat",
            description:
                "Recent messages in one conversation, oldest first, fetched live from the phone. Each line shows the " +
                "message id to use with reply_to, react, get_media, edit or delete. Pass the returned `before` cursor " +
                "to read further back.",
            inputSchema: {
                chat: chatRef,
                limit: z.number().int().min(1).max(50).default(30),
                before: z.string().optional().describe("Cursor from a previous read_chat, to page older messages."),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ chat, limit, before }) => {
            const cursor = before ? decodeCursor(before) : undefined;
            if (before && !cursor) return failure("That `before` cursor is not one read_chat issued.");
            const page = await session.readChat(chat, { limit, before: cursor ?? undefined });
            const names = await session.senderNames(page.chat, page.messages);
            const lines = page.messages.map((m) => renderMessage(m, senderLabel(m, page.chat, names)));
            const header = `Chat ${chatTitle(page.chat)} — ${page.messages.length} message(s), oldest first.`;
            const footer = page.next
                ? `\nOlder messages: read_chat with before="${encodeCursor(page.next)}"`
                : "\nNo older messages returned (start of chat, or the phone has no more).";
            return text([header, ...lines].join("\n") + footer);
        }
    );

    tool(
        "search_chat",
        {
            title: "Search a chat",
            description:
                "Find messages in one conversation containing every word of the query (case- and accent-insensitive). " +
                "WhatsApp has no server-side search, so this pages the chat's history from the phone and matches as it " +
                "goes — `scan` bounds how far back it looks, about 50 messages per few seconds.",
            inputSchema: {
                chat: chatRef,
                query: z.string().min(1),
                scan: z.number().int().min(50).max(1000).default(300).describe("How many messages back to look."),
                limit: z.number().int().min(1).max(50).default(20),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ chat, query, scan, limit }) => {
            const r = await session.searchChat(chat, query, { scan, limit });
            const names = await session.senderNames(r.chat, r.hits);
            const head = `${r.hits.length} match(es) for "${query}" in ${chatTitle(r.chat)}, newest first — ${r.scanned} message(s) scanned.`;
            const tail = r.more
                ? `\nStopped at the scan limit; older history not searched (search again with a larger scan, or read_chat with before="${encodeCursor(r.more)}").`
                : "";
            return text([head, ...r.hits.map((m) => renderMessage(m, senderLabel(m, r.chat, names)))].join("\n") + tail);
        }
    );

    tool(
        "get_media",
        {
            title: "Get a message's photo or file",
            description:
                "Download the photo, sticker, voice note or document attached to a message, so you can look at it. " +
                "Works for messages read in this session or received in the last week; nothing is stored.",
            inputSchema: { message_id: messageId },
            annotations: { readOnlyHint: true },
        },
        async ({ message_id }) => {
            const media = await session.mediaOf(message_id);
            const mime = media.mimetype.split(";")[0];
            if (media.kind === "image" || media.kind === "sticker") {
                const fit = await fitForModel(media.data, mime);
                return { content: [{ type: "image", data: fit.data.toString("base64"), mimeType: fit.mime }] };
            }
            const base64 = media.data.toString("base64");
            if (media.kind === "audio") {
                return { content: [{ type: "audio", data: base64, mimeType: mime }] };
            }
            if (mime.startsWith("text/") || mime === "application/json") {
                return text(`${media.filename || "file"}:\n${media.data.toString("utf8")}`);
            }
            return {
                content: [
                    { type: "text", text: `${media.kind}${media.filename ? ` "${media.filename}"` : ""}, ${mime}, ${media.data.length} bytes.` },
                    {
                        type: "resource",
                        resource: { uri: `whatsapp://media/${encodeURIComponent(message_id)}`, mimeType: mime, blob: base64 },
                    },
                ],
            };
        }
    );

    tool(
        "group_info",
        {
            title: "Group details",
            description: "A group's subject, description and members (with phone numbers where WhatsApp shares them).",
            inputSchema: { group: z.string().min(1).describe("Group id ending in @g.us.") },
            annotations: { readOnlyHint: true },
        },
        async ({ group }) => {
            const jid = toWaJid(group);
            if (!isGroupJid(jid)) return failure(`"${group}" is not a group id (they end in @g.us).`);
            const { meta, participants } = await session.groupInfo(jid);
            const lines = participants.map(
                (p, i) =>
                    `- ${p.name || "(no name)"} — ${p.id.includes("@lid") ? `lid ${p.lid}` : p.id.replace(/\D/g, "")}${
                        meta.participants[i]?.admin ? " [admin]" : ""
                    }`
            );
            return text(
                [`${meta.subject} (${meta.id}) — ${participants.length} members`, meta.desc ? `Description: ${meta.desc}` : "", ...lines]
                    .filter(Boolean)
                    .join("\n")
            );
        }
    );

    tool(
        "check_number",
        {
            title: "Check numbers are on WhatsApp",
            description: "Whether phone numbers (with country code) have WhatsApp — before writing to someone new.",
            inputSchema: { phones: z.array(z.string().min(3)).min(1).max(20) },
            annotations: { readOnlyHint: true },
        },
        async ({ phones }) => {
            const r = await session.checkNumbers(phones);
            return text(r.map((x) => `${x.phone}: ${x.on_whatsapp ? "on WhatsApp" : "not on WhatsApp"}`).join("\n"));
        }
    );

    // ----------------------------------------------------------------- writes

    const send = async (to: string, kind: CloudSendKind, replyTo?: string) => {
        const jid = toWaJid(to);
        if (!jid) throw new Error(`"${to}" is not a phone number or group id`);
        const { messageId: id } = await session.sendCloud({
            to: jid,
            recipientType: isGroupJid(jid) ? "group" : "individual",
            kind,
            replyTo,
        });
        return text(`Sent${replyTo ? ` as a reply to ${replyTo}` : ""}. message_id: ${id}`);
    };

    tool(
        "send_message",
        {
            title: "Send a message",
            description:
                "Send a text message as this account to a person or group. Set reply_to to a message id to send it as " +
                "a quoted reply. Confirm the text and recipient with the user first.",
            inputSchema: {
                to: chatRef,
                text: z.string().min(1).max(65536),
                reply_to: messageId.optional(),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        },
        async ({ to, text: body, reply_to }) => send(to, { type: "text", body, previewUrl: true }, reply_to)
    );

    tool(
        "prepare_upload",
        {
            title: "Get an upload link for a local file",
            description:
                "To send a file from this computer (a photo, PDF, video…), get a one-time upload link, PUT the file " +
                "there with the curl command this returns, then call send_media with the upload_id. The file goes " +
                "straight to the gateway and never through you, so size doesn't matter (up to " +
                `${MAX_UPLOAD_BYTES / 1024 / 1024} MB). Needs a shell ` +
                "to run curl; without one, send by public URL instead.",
            inputSchema: {
                filename: z
                    .string()
                    .max(255)
                    .optional()
                    .describe("The file's name, e.g. IMG_2041.jpg — helps type detection and is what a document is called."),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        },
        async ({ filename }) => {
            const u = uploads.create(session.id, filename);
            const local = filename ? `"${filename.replace(/"/g, "")}"` : "<path to the file>";
            return text(
                [
                    `upload_id: ${u.id}`,
                    "",
                    "Upload with:",
                    `curl -sS --fail-with-body -X PUT -H 'content-type: application/octet-stream' --data-binary @${local} '${u.url}'`,
                    "",
                    `Then call send_media with upload_id "${u.id}". The link works once, expires in 15 minutes, and takes up to ${
                        MAX_UPLOAD_BYTES / 1024 / 1024
                    } MB. The file is deleted once sent, or when the link expires if it never is.`,
                ].join("\n")
            );
        }
    );

    tool(
        "send_media",
        {
            title: "Send a photo or file",
            description:
                "Send a photo, video, document or audio as this account. Give exactly one of: `upload_id` (a local " +
                "file uploaded via prepare_upload — use this for anything on this computer), `url` (a public https " +
                "link), or `data` (base64 — only for tiny files, since you would have to write out every byte). " +
                "`type` defaults to what the file is (photos as image). Optional caption and reply_to.",
            inputSchema: {
                to: chatRef,
                type: z.enum(["image", "video", "document", "audio"]).optional(),
                upload_id: z.string().optional().describe("From prepare_upload, after the curl upload succeeded."),
                url: z.string().url().optional(),
                data: z.string().optional().describe("data: URI or raw base64 — tiny files only."),
                caption: z.string().max(4096).optional(),
                filename: z.string().max(255).optional().describe("For documents: the name the recipient sees."),
                reply_to: messageId.optional(),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        },
        async ({ to, type, upload_id, url, data, caption, filename, reply_to }) => {
            const given = [upload_id, url, data].filter(Boolean).length;
            if (given !== 1) return failure("Give exactly one of `upload_id`, `url` or `data`.");

            let media: string | Buffer;
            let mimetype: string | undefined;
            let name = filename;
            if (upload_id) {
                const state = uploads.status(session.id, upload_id);
                if (state === "waiting") {
                    return failure("Nothing has been uploaded to that link yet — run the curl command from prepare_upload first.");
                }
                const up = state === "ready" ? await uploads.read(session.id, upload_id) : null;
                if (!up) return failure("That upload_id is unknown, expired (15 minutes) or already sent. Call prepare_upload again.");
                media = up.data;
                mimetype = up.mimetype;
                name = filename || up.filename;
            } else {
                media = (url || data)!;
            }

            const as = type || (mimetype ? sendKindFor(mimetype) : "image");
            const kind: CloudSendKind =
                as === "image"
                    ? { type: "image", media, caption }
                    : as === "video"
                      ? { type: "video", media, caption, mimetype }
                      : as === "audio"
                        ? { type: "audio", media, mimetype }
                        : { type: "document", media, caption, filename: name, mimetype };
            const result = await send(to, kind, reply_to);
            if (upload_id) await uploads.done(session.id, upload_id);
            return result;
        }
    );

    tool(
        "react",
        {
            title: "React to a message",
            description: "React to a message with an emoji. An empty emoji removes your reaction.",
            inputSchema: { message_id: messageId, emoji: z.string().max(16) },
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        },
        async ({ message_id, emoji }) => {
            await session.react(message_id, emoji);
            return text(emoji ? `Reacted ${emoji}.` : "Reaction removed.");
        }
    );

    tool(
        "mark_read",
        {
            title: "Mark a chat read",
            description: "Mark a conversation as read: blue ticks for the sender, unread badge cleared on the phone.",
            inputSchema: { chat: chatRef },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        },
        async ({ chat }) => {
            await session.markChatRead(chat);
            return text("Marked read.");
        }
    );

    tool(
        "edit_message",
        {
            title: "Edit one of my messages",
            description: "Change the text of a message this account sent (WhatsApp allows this for about 15 minutes).",
            inputSchema: { message_id: messageId, text: z.string().min(1).max(65536) },
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        },
        async ({ message_id, text: body }) => {
            await session.editMessage(message_id, body);
            return text("Edited.");
        }
    );

    tool(
        "delete_message",
        {
            title: "Delete one of my messages for everyone",
            description: "Delete a message this account sent, for everyone in the chat. Cannot be undone.",
            inputSchema: { message_id: messageId },
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        },
        async ({ message_id }) => {
            await session.deleteMessage(message_id);
            return text("Deleted for everyone.");
        }
    );

    return server;
}

export function makeMcpRouter(manager: SessionManager, oauth: OAuthService, uploads: UploadStore): Router {
    const router = Router();

    const jsonRpcError = (res: Response, status: number, message: string) =>
        res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });

    router.all("/mcp", async (req: Request, res: Response) => {
        const token = bearerOf(req);
        const session = await oauth.sessionForAccessToken(token).catch(() => null);
        if (!session) {
            // The commonest mistake is pasting the bot token, so say which one
            // this is — the token itself is never logged.
            const isBotToken = !!token && !!manager.byTokenOrNull(token);
            logger.warn(
                {
                    path: req.path,
                    reason: !token ? "no bearer token" : isBotToken ? "bot token sent to MCP" : "access token unknown or expired",
                },
                "request refused"
            );
            // This header is how a client finds the sign-in: it points at the
            // resource metadata, which names the authorization server. Without
            // it a client has nowhere to start, since the root well-known paths
            // belong to the static site, not to this container.
            res.setHeader(
                "www-authenticate",
                `Bearer resource_metadata="${resourceMetadataUrlOf(req)}"` +
                    (token ? `, error="invalid_token"` : "")
            );
            jsonRpcError(
                res,
                401,
                isBotToken
                    ? "that is the number's bot token — MCP signs in with OAuth; connect your assistant to this URL and approve it"
                    : "unauthorized"
            );
            return;
        }
        // Stateless: no SSE stream to open (GET) and no session to end (DELETE).
        if (req.method !== "POST") {
            res.setHeader("allow", "POST");
            jsonRpcError(res, 405, "method not allowed — this MCP endpoint is stateless and takes POST only");
            return;
        }

        const server = buildMcpServer(session, uploads);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => {
            void transport.close();
            void server.close();
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (e) {
            logger.error({ e, session: session.id }, "MCP request failed");
            if (!res.headersSent) jsonRpcError(res, 500, "internal error");
        }
    });

    return router;
}
