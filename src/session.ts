import makeWASocket, {
    decryptPollVote,
    downloadMediaMessage,
    DisconnectReason,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    proto,
    type GroupMetadata,
    type WAMessage,
    type WASocket,
} from "baileys";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { Boom } from "@hapi/boom";
import { config, type SessionConfig } from "./config.js";
import { logger, baileysLogger } from "./log.js";
import { scopedId, type ChatDoc, type ContactDoc, type Stores } from "./store.js";
import { describeMessage, isConversationMessage, matchesQuery, type HistoryAnchor } from "./chatlog.js";
import { useMongoAuthState } from "./authState.js";
import { MediaStore } from "./media.js";
import { WebhookSender } from "./webhook.js";
import {
    classify,
    mentionedJidsOf,
    quotedContextOf,
    forwardedOf,
    unwrap,
    type MentionedIdentity,
} from "./map.js";
import {
    buildCloudContactsEvent,
    buildCloudGroupEvent,
    type GroupChange,
    buildCloudMessageEvent,
    buildCloudPollVoteEvent,
    buildCloudCallEvent,
    buildCloudPresenceEvent,
    CloudRequestError,
    type CloudMetadata,
    type CloudSendKind,
    type CloudSendRequest,
} from "./cloud.js";
import {
    digitsOf,
    isGroupJid,
    isLidJid,
    preferPhoneNumber,
    rewriteMentions,
    stripDevice,
    toWaJid,
    toChatId,
    toUserId,
} from "./jid.js";

/**
 * History sync types we accept: identity and naming data, never message
 * backfill. See the `shouldSyncHistoryMessage` call for why this is a
 * allow-list rather than the blanket `false` it used to be.
 */
const HISTORY_TYPES_WORTH_SYNCING = new Set<number>([
    proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
    proto.HistorySync.HistorySyncType.PUSH_NAME,
    proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA,
]);

/** The most an MCP `get_media` returns: it travels back as base64 inside a tool result. */
const MAX_MCP_MEDIA_BYTES = 8_000_000;

export type SessionStatus =
    | "starting"
    | "awaiting-pairing"
    | "connecting"
    | "connected"
    | "logged-out"
    | "conflict"
    | "stopped";

/**
 * Simple token bucket, and entirely optional — a number with no
 * `sendRatePerMinute` gets no limiter at all rather than a default one.
 *
 * Where there is one, it is a floor under any bug that would otherwise spam a
 * chat: WhatsApp bans on volume, and a retry loop is much cheaper to survive
 * than a lost number.
 */
class RateLimiter {
    private tokens: number;
    private last = Date.now();
    constructor(private perMinute: number) {
        this.tokens = perMinute;
    }
    tryTake(): boolean {
        const now = Date.now();
        this.tokens = Math.min(
            this.perMinute,
            this.tokens + ((now - this.last) / 60_000) * this.perMinute
        );
        this.last = now;
        if (this.tokens < 1) return false;
        this.tokens -= 1;
        return true;
    }
}

/**
 * One WhatsApp number: its own socket, its own Signal state, its own webhook
 * target and its own rate limit. Nothing is shared with the other sessions
 * except the Mongo connection and the media directory, both of which namespace
 * by session id.
 */
export class Session {
    readonly id: string;
    /** Mutable: the console can rotate a bot's token without re-pairing the number. */
    token: string;

    private sock?: WASocket;
    private saveCreds: () => Promise<void> = async () => {};
    private clearAuth: () => Promise<void> = async () => {};
    private groupCache = new Map<string, { meta: GroupMetadata; at: number }>();
    /** Absent when this number has no cap configured. */
    private limiter?: RateLimiter;
    private webhook: WebhookSender;
    private log;
    private reconnectAttempts = 0;
    private stopping = false;
    /** Bumped per socket; stale sockets' events are ignored. See start(). */
    private generation = 0;

    status: SessionStatus = "starting";
    /** Raw QR string, when one is pending. Rendered as an image by the admin page. */
    qr?: string;
    /** 8-character pairing code, when a pair phone is configured. */
    pairingCode?: string;
    me?: { id: string; name?: string };
    lastError?: string;
    connectedAt?: Date;

    /**
     * Last live inbound message from WhatsApp, and last outbound send.
     *
     * These exist to answer "is this actually working?" — a connected badge only
     * proves a socket is open, which is also true of a session that has silently
     * stopped receiving. Seeded from Mongo on start so a redeploy doesn't reset
     * the answer to "never".
     */
    lastMessage?: {
        at: Date;
        /** Sender, as bare digits. */
        from: string;
        /** WhatsApp push name, when the sender publishes one. */
        fromName?: string;
        /** Group subject, for group messages. */
        chatName?: string;
        isGroup: boolean;
    };
    lastSentAt?: Date;
    /** Inbound messages seen since this process started. */
    messagesReceived = 0;
    /** Throttles the Mongo write behind lastMessageAt. */
    private lastActivityPersistedAt = 0;
    /** Contact names already sent, so unchanged ones are not re-sent. */
    private emittedContacts = new Map<string, string>();

    // ------------------------------------------------------- MCP-only state

    /**
     * Messages just fetched from the phone for an MCP read, held in memory so
     * the model can react to, reply to or look at what it just read. Never
     * written to Mongo — not keeping history is the point (see `ChatDoc`) — and
     * bounded, so a long session of reading cannot grow the process.
     */
    private fetched = new Map<string, WAMessage>();
    /** The one history request in flight. One at a time, so a reply is never matched to the wrong chat. */
    private pendingHistory?: {
        requestId?: string;
        resolve: (messages: WAMessage[]) => void;
    };
    private historyQueue: Promise<unknown> = Promise.resolve();
    /** Contact names already written, so a burst of identical updates is not a burst of writes. */
    private writtenContacts = new Map<string, string>();
    /** Every group this number is in, from one query, refreshed at most every 10 minutes. */
    private allGroups?: { at: number; groups: GroupMetadata[] };

    constructor(
        private cfg: SessionConfig,
        private stores: Stores,
        private media: MediaStore
    ) {
        this.id = cfg.id;
        this.token = cfg.token;
        this.log = logger.child({ session: cfg.id });
        this.limiter = cfg.sendRatePerMinute ? new RateLimiter(cfg.sendRatePerMinute) : undefined;
        this.webhook = new WebhookSender(cfg.webhookUrl, cfg.token, cfg.id);
    }

    /**
     * Adopt an edited config without touching the socket.
     *
     * Changing a webhook URL or a rate cap has nothing to do with the WhatsApp
     * connection, and tearing the socket down to apply one would cost a
     * reconnect — and, often enough, a `connectionReplaced` flap. The id is not
     * updatable at all: it namespaces the stored credentials, so changing it
     * would orphan them.
     */
    /** MCP access on: assistants may be approved, and the chat index is kept. */
    get mcpEnabled(): boolean {
        return !!this.cfg.mcp;
    }

    applyConfig(cfg: SessionConfig) {
        if (cfg.id !== this.id) throw new Error("a session's id cannot change");
        this.cfg = cfg;
        this.token = cfg.token;
        this.limiter = cfg.sendRatePerMinute ? new RateLimiter(cfg.sendRatePerMinute) : undefined;
        this.webhook.retarget(cfg.webhookUrl, cfg.token);
    }

    // ---------------------------------------------------------------- lifecycle

    async start(): Promise<void> {
        this.stopping = false;
        // Every socket this session has ever opened gets a number, and its event
        // handlers only act while they are the current one.
        //
        // Without this, a socket torn down by `restart()` or `relink()` still
        // emits its `close` a moment later, and that handler would schedule a
        // reconnect on top of the socket that just replaced it. Two sockets on
        // one set of credentials is exactly the `connectionReplaced` flap this
        // gateway refuses to reconnect into — self-inflicted, and only from a
        // console action, which is why it never came up before.
        const gen = ++this.generation;
        const current = () => gen === this.generation;

        const { state, saveCreds, clear } = await useMongoAuthState(this.stores, this.id);
        this.saveCreds = saveCreds;
        this.clearAuth = clear;

        this.status = state.creds.registered ? "connecting" : "awaiting-pairing";

        this.sock = makeWASocket({
            auth: {
                creds: state.creds,
                // The cache matters more than it looks: Signal key reads happen on
                // every single decrypt, and without it each one is a Mongo round
                // trip. On a Pi — with several numbers sharing it — that is the
                // difference between snappy and sluggish.
                keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
            },
            logger: baileysLogger as any,
            // We surface the QR on the admin page instead of the terminal — the Pi
            // is headless and `apps_logs` is a poor QR renderer.
            printQRInTerminal: false,
            browser: [`Gateway (${this.id})`, "Chrome", "1.0.0"],
            // The bots never read history, but refusing *all* of it was too blunt.
            //
            // Baileys ships seven history types down one switch, and turning them
            // all off costs the two things this gateway most depends on: the
            // initial LID↔phone-number mappings, and the contact/chat names. It
            // says so on connect ("DANGER: … PREVENTS BAILEYS FROM ACCESSING
            // INITIAL LID MAPPINGS"), and the symptom is senders arriving as raw
            // LID digits that a consumer then reads as a phone number.
            //
            // So allow only the metadata types and still refuse the message
            // backfill, which is the part that actually burns Pi memory and Mongo
            // writes on every reconnect:
            //
            //   INITIAL_BOOTSTRAP (0)  contacts, chats, LID mappings   ✓
            //   PUSH_NAME         (4)  the names people set themselves ✓
            //   NON_BLOCKING_DATA (5)  supplementary contact data      ✓
            //   FULL (2) / RECENT (3) / ON_DEMAND (6)  message backfill ✗
            //   INITIAL_STATUS_V3 (1)  statuses/stories                ✗
            //
            // Nothing from a sync can reach a bot regardless: `onMessages` only
            // forwards `type === "notify"`, and history arrives as "append".
            syncFullHistory: false,
            //
            // ON_DEMAND is the one exception, and only while an MCP read has
            // asked the phone for a page of history: that reply is how a chat
            // gets read without this box keeping a copy of it. Unasked-for
            // ON_DEMAND data is refused like any other backfill.
            shouldSyncHistoryMessage: (msg: proto.Message.IHistorySyncNotification) =>
                HISTORY_TYPES_WORTH_SYNCING.has(msg.syncType as number) ||
                (msg.syncType === proto.HistorySync.HistorySyncType.ON_DEMAND && !!this.pendingHistory),
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            cachedGroupMetadata: async (jid: string) => this.groupCache.get(jid)?.meta,
            getMessage: async (key: proto.IMessageKey) => this.lookupMessage(key),
        } as any);

        // Never swallow a credentials write failure. If this stops working the
        // session dies at the next restart, and a silent failure means finding
        // that out days later with no idea why.
        this.sock.ev.on("creds.update", () => {
            // Not gated on `current()`: a credential update in flight when a
            // socket is replaced is still this number's credential update, and
            // dropping one is how a session stops surviving restarts.
            void this.saveCreds().catch((e) =>
                this.log.error({ e }, "FAILED TO PERSIST CREDENTIALS — session will not survive a restart")
            );
        });
        this.sock.ev.on("connection.update", (u) => {
            if (current()) void this.onConnectionUpdate(u, gen);
        });
        this.sock.ev.on("messages.upsert", (u) => {
            if (current()) void this.onMessages(u);
        });
        this.sock.ev.on("groups.upsert", (g) => {
            if (current()) void this.onGroups(g);
        });
        this.sock.ev.on("groups.update", (g) => {
            if (current()) void this.onGroupsUpdate(g);
        });
        this.sock.ev.on("group-participants.update", (u) => {
            if (current()) void this.onParticipants(u);
        });
        this.sock.ev.on("contacts.update", (c) => {
            if (!current()) return;
            void this.onContacts(c);
            if (this.mcpEnabled) void this.trackContacts(c);
        });
        // The four below feed only the MCP chat list and contact names; a number
        // without MCP ignores them exactly as it always has.
        this.sock.ev.on("contacts.upsert", (c) => {
            if (current() && this.mcpEnabled) void this.trackContacts(c);
        });
        this.sock.ev.on("chats.upsert", (c) => {
            if (current() && this.mcpEnabled) void this.seedChats(c);
        });
        this.sock.ev.on("chats.update", (c) => {
            if (current() && this.mcpEnabled) void this.onChatsUpdate(c);
        });
        this.sock.ev.on("messaging-history.set", (h) => {
            if (current()) void this.onHistorySet(h);
        });
        this.sock.ev.on("call", (calls) => {
            if (current()) void this.onCalls(calls);
        });
        this.sock.ev.on("presence.update", (p) => {
            if (current()) void this.onPresence(p as any);
        });
    }

    /**
     * Someone calls the number (audio or video). On a number set to
     * `rejectCalls` — a bot that can't talk — the call is rejected at once (it
     * would otherwise ring out on the caller's phone) and the consumer is told,
     * so it can answer in text. Other numbers leave calls alone. Only the
     * offer: ringing, timeouts and the rest of a call's life are noise.
     */
    private async onCalls(calls: Array<{ id: string; from: string; callerPn?: string; isGroup?: boolean; groupJid?: string; isVideo?: boolean; status: string; date?: Date }>) {
        if (!this.cfg.rejectCalls) return;
        for (const c of calls) {
            if (c.status !== "offer") continue;
            try {
                await this.sock!.rejectCall(c.id, c.from);
            } catch (e) {
                this.log.warn({ e, id: c.id }, "couldn't reject a call");
            }
            const who = c.callerPn || (await this.resolveParticipant(c.from, c.isGroup ? c.groupJid : undefined, "a caller")) || c.from;
            const from = digitsOf(who);
            this.log.info({ id: c.id, video: !!c.isVideo, group: !!c.isGroup }, "call rejected");
            if (!from) continue;
            await this.webhook.send(
                buildCloudCallEvent(
                    { id: c.id, from, timestamp: Math.floor((c.date ? new Date(c.date).getTime() : Date.now()) / 1000), video: !!c.isVideo, groupJid: c.isGroup ? c.groupJid : undefined },
                    this.cloudMeta()
                )
            );
        }
    }

    /** 1:1 chats whose presence we asked for: jid → when we last asked, when they last wrote, and the phone digits it stands for. */
    private watched = new Map<string, { at: number; wrote: number; from: string }>();
    private onlineAt = 0;
    /** The last presence sent per jid, so a burst of "composing" becomes one event. */
    private lastPresence = new Map<string, { state: string; at: number }>();
    /** The last online/offline sent per jid: a change goes out, and "online" again now and then while it lasts. */
    private lastOnline = new Map<string, { state: string; at: number }>();
    private renewTimer?: NodeJS.Timeout;
    private static readonly WATCH_RENEW_MS = 10 * 60_000;
    private static readonly WATCH_KEEP_MS = 7 * 24 * 3600_000;
    private static readonly TYPING_REPEAT_MS = 8_000;
    private static readonly ONLINE_REPEAT_MS = 5 * 60_000;

    /**
     * Someone wrote 1:1: ask WhatsApp for their presence, so their typing
     * reaches us (it only sends it to whoever subscribed). Renewed now and then,
     * never per message — and kept up for a week after they last wrote
     * (renewWatches), so the consumer also hears when they're back online, at
     * any hour.
     */
    private watchPresence(jid: string, from: string) {
        if (!this.cfg.typingEvents || !jid || isGroupJid(jid) || !from) return;
        const w = this.watched.get(jid);
        if (w) { w.wrote = Date.now(); w.from = from; }
        if (w && Date.now() - w.at < Session.WATCH_RENEW_MS) return;
        this.watched.set(jid, { at: 0, wrote: Date.now(), from });
        if (this.watched.size > 5000) this.watched.delete(this.watched.keys().next().value as string);
        this.subscribe(jid);
        if (!this.renewTimer) {
            this.renewTimer = setInterval(() => this.renewWatches(), Session.WATCH_RENEW_MS);
            this.renewTimer.unref?.();
        }
    }

    private subscribe(jid: string) {
        const w = this.watched.get(jid);
        if (w) w.at = Date.now();
        // WhatsApp only tells an account that is online who is typing — and
        // this one connects offline (markOnlineOnConnect: false). So with
        // typing events on, it goes online when it starts watching someone,
        // and stays so (renewed with the watch).
        if (Date.now() - this.onlineAt > Session.WATCH_RENEW_MS) {
            this.onlineAt = Date.now();
            void this.sock?.sendPresenceUpdate("available").catch((e) => this.log.debug({ e }, "going online failed"));
        }
        void this.sock?.presenceSubscribe(jid).catch((e) => this.log.debug({ e }, "presence subscribe failed"));
    }

    /** Keep watching everyone who wrote in the last week; forget the rest. */
    private renewWatches() {
        if (this.status !== "connected" || !this.cfg.typingEvents) return;
        const now = Date.now();
        for (const [jid, w] of this.watched) {
            if (now - w.wrote > Session.WATCH_KEEP_MS) { this.watched.delete(jid); this.lastOnline.delete(jid); continue; }
            if (now - w.at >= Session.WATCH_RENEW_MS - 5_000) this.subscribe(jid);
        }
    }

    /**
     * Their presence changed. Typing and recording are sent (again at most
     * every TYPING_REPEAT_MS while it lasts); "paused" once, when they stop
     * after typing. Online and offline go out too, for the people being
     * watched: a change at once, "online" again at most every
     * ONLINE_REPEAT_MS, and "offline" with when they were last seen, when
     * WhatsApp says (their privacy settings may hide it).
     */
    private async onPresence(u: { id: string; presences: Record<string, { lastKnownPresence?: string; lastSeen?: number }> }) {
        if (!this.cfg.typingEvents || !u?.id || isGroupJid(u.id)) return;
        const data = u.presences?.[u.id] || Object.values(u.presences || {})[0];
        const raw = data?.lastKnownPresence;
        const from = () => this.watched.get(u.id)?.from || this.resolveToPn(u.id).then(digitsOf);

        // Online / offline.
        const avail = raw === "unavailable" ? "offline" : raw ? "online" : "";
        const lastOn = this.lastOnline.get(u.id);
        if (avail && (!lastOn || lastOn.state !== avail || (avail === "online" && Date.now() - lastOn.at >= Session.ONLINE_REPEAT_MS))) {
            this.lastOnline.set(u.id, { state: avail, at: Date.now() });
            const f = await from();
            if (f) await this.webhook.sendNow(buildCloudPresenceEvent({
                from: f, state: avail, timestamp: Math.floor(Date.now() / 1000),
                ...(avail === "offline" && data?.lastSeen ? { lastSeen: Math.floor(Number(data.lastSeen)) } : {}),
            }, this.cloudMeta()));
        }

        // Typing.
        const state = raw === "composing" ? "typing" : raw === "recording" ? "recording" : raw === "paused" ? "paused" : "";
        const last = this.lastPresence.get(u.id);
        if (!state) {
            // Gone offline or just "available" after typing: that is a stop too.
            if (!last || last.state === "paused") return;
        }
        const next = state || "paused";
        if (last && last.state === next && (next === "paused" || Date.now() - last.at < Session.TYPING_REPEAT_MS)) return;
        if (!last && next === "paused") return;
        this.lastPresence.set(u.id, { state: next, at: Date.now() });
        const f = await from();
        if (!f) return;
        await this.webhook.sendNow(buildCloudPresenceEvent({ from: f, state: next as any, timestamp: Math.floor(Date.now() / 1000) }, this.cloudMeta()));
    }

    private async onConnectionUpdate(
        u: Partial<import("baileys").ConnectionState>,
        gen: number
    ) {
        const { connection, lastDisconnect, qr } = u;

        if (qr) {
            this.qr = qr;
            this.status = "awaiting-pairing";
            // If a phone number was configured, prefer a pairing code — no screen
            // needed, which is the friendlier path for a headless box.
            if (this.cfg.pairPhone && !this.pairingCode && !this.sock?.authState.creds.registered) {
                try {
                    this.pairingCode = await this.sock!.requestPairingCode(this.cfg.pairPhone);
                    this.log.warn({ code: this.pairingCode }, "PAIRING CODE — enter in WhatsApp > Linked devices");
                } catch (e) {
                    this.log.error({ e }, "requestPairingCode failed; fall back to the QR on /admin");
                }
            } else {
                this.log.warn("QR code pending — open /admin to scan it");
            }
        }

        if (connection === "connecting") {
            if (this.status !== "awaiting-pairing") this.status = "connecting";
        }

        if (connection === "open") {
            this.status = "connected";
            this.qr = undefined;
            this.pairingCode = undefined;
            this.reconnectAttempts = 0;
            this.connectedAt = new Date();
            this.lastError = undefined;
            const meId = this.sock?.user?.id;
            this.me = meId ? { id: meId, name: this.sock?.user?.name } : undefined;
            this.log.info({ me: this.me }, "whatsapp connected");
        }

        if (connection === "close") {
            const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
            this.lastError = (lastDisconnect?.error as Error)?.message;

            if (this.stopping) {
                this.status = "stopped";
                return;
            }

            if (code === DisconnectReason.loggedOut) {
                // The device was unlinked from the phone. Reconnecting with these
                // creds will never work — wipe them (this session's only) so /admin
                // offers a fresh QR rather than looping on a dead session forever.
                this.status = "logged-out";
                await this.clearAuth();
                this.log.error("logged out of WhatsApp — re-pair via /admin");
                return;
            }

            if (code === DisconnectReason.connectionReplaced) {
                // Another client took this device slot. Almost always means a second
                // instance of the gateway is running on the same credentials — or
                // two sessions were accidentally configured with the same id.
                // Reconnecting here starts a flap war that ends in a logout, so stop
                // and make the operator look.
                this.status = "conflict";
                this.log.error(
                    "connection replaced — another client is using these credentials. " +
                    "Check for a second gateway instance, then restart."
                );
                return;
            }

            this.status = "connecting";
            this.reconnectAttempts++;
            // Cap at 30s. restartRequired (515) is the normal post-pairing restart
            // and should be immediate.
            const delay =
                code === DisconnectReason.restartRequired
                    ? 0
                    : Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts, 5));
            this.log.warn({ code, delay, attempt: this.reconnectAttempts }, "connection closed, reconnecting");
            setTimeout(() => {
                // `gen` may have moved while we waited — a console restart, or an
                // unlink. Whoever bumped it owns the socket now.
                if (!this.stopping && gen === this.generation) {
                    void this.start().catch((e) => this.log.error({ e }, "restart failed"));
                }
            }, delay);
        }
    }

    async stop() {
        this.stopping = true;
        if (this.renewTimer) { clearInterval(this.renewTimer); this.renewTimer = undefined; }
        this.generation++;
        try {
            this.sock?.end(undefined);
        } catch {}
        this.status = "stopped";
    }

    /**
     * Unlink from WhatsApp and wipe this session's credentials.
     *
     * The `sock.logout()` call is best-effort on purpose: it is what removes the
     * entry from the phone's "Linked devices" list, but it needs a live socket,
     * and the common reason to unlink is that the session is already broken.
     * Failing to tell WhatsApp must not stop us clearing local state, or the
     * session is stuck holding credentials it can no longer use.
     */
    async unlink() {
        this.stopping = true;
        this.generation++;
        try {
            await this.sock?.logout();
        } catch (e) {
            this.log.warn({ e }, "logout call failed; clearing local state anyway");
        }
        try {
            this.sock?.end(undefined);
        } catch {}
        await this.clearAuth();
        this.sock = undefined;
        this.qr = undefined;
        this.pairingCode = undefined;
        this.me = undefined;
        this.connectedAt = undefined;
        this.reconnectAttempts = 0;
        this.status = "logged-out";
    }

    /** Unlink, then come back up on fresh credentials so a new QR appears. */
    async relink() {
        await this.unlink();
        await this.start();
    }

    /**
     * Bounce the socket without touching credentials — the escape hatch for a
     * session stuck in `conflict`, which deliberately does not self-reconnect.
     */
    async restart() {
        this.stopping = true;
        this.generation++;
        try {
            this.sock?.end(undefined);
        } catch {}
        this.sock = undefined;
        this.reconnectAttempts = 0;
        await this.start();
    }

    // ------------------------------------------------------------- LID handling

    /**
     * Resolve a LID to its phone-number JID.
     *
     * WhatsApp is migrating identities from phone numbers to LIDs, so in newer
     * groups `key.participant` and group rosters come back as `...@lid`. The bots
     * infer a group's country, language and timezone from participant phone
     * prefixes, so an unresolved LID doesn't crash anything — it silently makes
     * them guess the wrong language. That's the worst failure mode available, so
     * resolve aggressively and log when we can't.
     */
    private async resolveToPn(jid: string | undefined | null, alt?: string | null): Promise<string> {
        const j = String(jid ?? "");
        if (!j || isGroupJid(j)) return j;
        if (!isLidJid(j)) return j;

        // Best source first: in a LID-addressed chat, Baileys v7 puts the
        // phone-number form of the sender right on the message key —
        // `participantAlt` next to `participant`, `remoteJidAlt` next to
        // `remoteJid`. That is WhatsApp's own answer, delivered with the
        // message, and it needs no lookup and no prior history sync.
        //
        // Missing this was why senders arrived as raw LID digits: they aren't
        // phone numbers, but `digitsOf` will happily emit them as if they were,
        // and a consumer then infers a country from "1395…".
        const altJid = preferPhoneNumber(j, alt);
        if (altJid) {
            // Teach the mapping store, so a later message that arrives without
            // an alt — a poll vote, a group roster — resolves from cache.
            void this.sock?.signalRepository?.lidMapping
                ?.storeLIDPNMappings([{ lid: stripDevice(j), pn: stripDevice(altJid) }])
                .catch((e: unknown) => this.log.debug({ e }, "could not cache LID mapping"));
            return altJid;
        }

        try {
            const pn = await this.sock?.signalRepository?.lidMapping?.getPNForLID(j);
            if (pn) return pn;
        } catch (e) {
            this.log.debug({ e, jid: j }, "LID resolution threw");
        }

        this.log.warn({ jid: j }, "unresolved LID — phone-prefix inference will be wrong for this id");
        return j;
    }

    // ------------------------------------------------------------------ inbound

    private async onMessages(upsert: { messages: WAMessage[]; type: string }) {
        // Before the "notify" filter: the chat list has to move for our own
        // sends and for messages that arrived while offline, both of which come
        // as "append". Only metadata is written — see `trackMessage`.
        if (this.mcpEnabled) {
            for (const msg of upsert.messages) {
                await this.trackMessage(msg, upsert.type).catch((e) =>
                    this.log.warn({ e, id: msg.key?.id }, "could not update the MCP chat index")
                );
            }
        }

        // "append" is history backfill; only "notify" is a live message. The bots
        // would happily reply to a week-old message otherwise.
        if (upsert.type !== "notify") return;

        for (const msg of upsert.messages) {
            try {
                await this.handleMessage(msg);
            } catch (e) {
                this.log.error({ e, id: msg.key?.id }, "failed to handle message");
            }
        }
    }

    /**
     * When WhatsApp says the message was sent.
     *
     * NOT `new Date()`. Those agree for a message arriving on a live socket, and
     * disagree badly for everything WhatsApp queued while the socket was down —
     * it delivers the whole backlog as live `notify` events on reconnect, so
     * stamping them with our own clock dates an hour-old message to the moment
     * of the last redeploy.
     */
    private static sentAt(msg: WAMessage): Date {
        const seconds = Number(msg.messageTimestamp);
        return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
    }

    private async handleMessage(msg: WAMessage) {
        if (!msg.key?.remoteJid) return;
        if (msg.key.remoteJid === "status@broadcast") return;

        // Before the fromMe drop on purpose: our own vote changes the tally too,
        // and a vote is not an echo of a message we sent.
        if (await this.handlePollVote(msg)) return;
        // The bots filter `from_me` themselves, but sending our own messages back
        // would double every interaction log. Drop them here.
        if (msg.key.fromMe) return;

        const cls = classify(msg.message);
        if (cls.kind === "skip") {
            // Still counts as proof the socket is delivering, so record it — but
            // from the raw key only. Resolving a group's subject for a sticker
            // would mean a metadata fetch WhatsApp rate-limits, for a message
            // nobody downstream will ever see.
            this.noteInbound({
                at: Session.sentAt(msg),
                from: digitsOf(msg.key.participant || msg.participant || msg.key.remoteJid),
                fromName: msg.pushName || undefined,
                // Cache-only: a subject we already hold costs nothing, and the
                // alternative is showing "in a group" with no idea which. What it
                // must not do is trigger a metadata fetch — WhatsApp rate-limits
                // those hard, and this is a message nobody downstream will see.
                chatName: this.groupCache.get(msg.key.remoteJid)?.meta.subject,
                isGroup: isGroupJid(msg.key.remoteJid),
            });
            this.log.debug(
                { id: msg.key.id, keys: Object.keys(unwrap(msg.message) || {}) },
                "unsupported message type, skipped"
            );
            return;
        }

        // `…Alt` carries the phone-number form when the chat is LID-addressed.
        const key = msg.key as typeof msg.key & {
            remoteJidAlt?: string;
            participantAlt?: string;
        };
        const chatJid = await this.resolveToPn(key.remoteJid, key.remoteJidAlt);
        const isGroup = isGroupJid(msg.key.remoteJid);
        if (!isGroup) {
            this.watchPresence(msg.key.remoteJid, digitsOf(chatJid));
            // Their message ends that bout of typing: the next "composing" is a
            // new one and goes out at once, not throttled as a repeat.
            if (msg.key.remoteJid) this.lastPresence.delete(msg.key.remoteJid);
            if (key.remoteJidAlt) this.lastPresence.delete(key.remoteJidAlt);
        }
        const senderJid = isGroup
            ? await this.resolveToPn(key.participant || msg.participant, key.participantAlt)
            : chatJid;

        // Remember the key so "act on this id" calls (mark read, react) can
        // reconstruct it later — the API only ever passes the bare id. For a
        // document the body comes too, because the file is fetched on demand
        // and the body is what says where from.
        // Every inbound body is kept, not just documents: a bot that replies to a
        // photo needs the photo's message content for WhatsApp to render the
        // quote (thumbnail, caption), and the key alone cannot give that.
        await this.rememberKey(msg, true);

        let chatName: string | undefined;
        if (isGroup) {
            // Was `.catch(() => undefined)`, which made a failing metadata fetch
            // indistinguishable from a group with no subject — the message still
            // went out, just anonymously, with nothing anywhere to explain it.
            const meta = await this.getGroupMetadata(msg.key.remoteJid).catch((e) => {
                this.log.warn(
                    { e, jid: msg.key.remoteJid },
                    "could not read group metadata — this message goes out without its group name"
                );
                return undefined;
            });
            chatName = meta?.subject;
        }

        // Only when there is a webhook to hand the link to. Without one the event
        // is discarded anyway, and an MCP-only number — a personal account in a
        // dozen groups — would otherwise fill the Pi's disk with photos nobody
        // will ever be sent a link to.
        const media = cls.mediaKind && this.cfg.webhookUrl
            ? await this.media.save(msg, cls.mediaKind, this.sock!, this.id)
            : undefined;

        const mentions = await this.resolveMentions(cls, msg, isGroup ? msg.key.remoteJid : undefined);

        // The sender's LID, beside the phone number already in `from`.
        const rawSender = String(key.participant || msg.participant || key.remoteJid || "");
        const senderLid = isLidJid(rawSender) ? digitsOf(rawSender) : await this.lidFor(rawSender);

        // Only set when the message actually replies to something, so the payload
        // is byte-identical to before for everything else.
        const quoted = quotedContextOf(msg.message);
        let context: { id?: string; from?: string; forwarded?: boolean; frequently_forwarded?: boolean } | undefined;
        if (quoted) {
            const from = quoted.participant
                ? await this.resolveParticipant(
                      quoted.participant,
                      isGroup ? msg.key.remoteJid : undefined,
                      "the sender of a quoted message"
                  )
                : undefined;
            context = {
                id: quoted.id,
                // Falls back to the raw participant so an unresolvable LID is
                // still reported rather than dropped — visible, as everywhere else.
                from: toUserId(from ?? quoted.participant ?? "") || undefined,
            };
        }
        // Passed on, in Meta's shape: the same `context` block, `forwarded` and
        // `frequently_forwarded`. A forward quotes nothing, so this stands on its
        // own — without it a bot credits forwarded words to whoever passed them on.
        const fwd = forwardedOf(msg.message);
        if (fwd) context = { ...(context || {}), ...fwd };

        this.noteInbound({
            at: Session.sentAt(msg),
            from: toUserId(senderJid),
            fromName: msg.pushName || undefined,
            chatName,
            isGroup,
        });

        const ids = {
            chatJid,
            senderJid,
            chatName,
            senderName: msg.pushName || undefined,
            context,
            mentions,
            senderLid,
        };
        const event = buildCloudMessageEvent(msg, cls, ids, this.cloudMeta(), media);

        // The other half of the trace, with "webhook delivered" as its pair: at
        // `info` so that "did the gateway see it?" and "did the bot get it?" are
        // both answerable from the logs, without reading Mongo.
        //
        // Metadata only — never the body, the caption or a filename's contents.
        // These logs are read in a terminal by whoever is debugging, and message
        // content is not theirs to read. `document` is the exception that proves
        // it: the name of a file IS the thing you need to identify it later,
        // because nothing else about it is stored here.
        this.log.info(
            {
                id: msg.key.id,
                type: cls.kind,
                from: toUserId(senderJid),
                chat: isGroup ? chatName || msg.key.remoteJid : undefined,
                group: isGroup || undefined,
                mentions: mentions?.length || undefined,
                replyTo: context?.id,
                // Present exactly when something was downloaded and re-hosted,
                // which is the question you ask when a link 404s.
                media: media?.link,
                ...(cls.kind === "document"
                    ? {
                          filename: cls.document?.filename,
                          mime: cls.document?.mimetype,
                          bytes: cls.document?.size,
                      }
                    : {}),
            },
            "message received"
        );

        if (event) await this.webhook.send(event);
    }

    /**
     * Turn `@<lid>` mentions in the body into `@<phone number>`.
     *
     * WhatsApp puts mentions in `contextInfo.mentionedJid` and writes only the
     * JID's user part into the text, so in a LID-addressed group the body reads
     * `@81656102801535`. Those digits are not a phone number, but nothing
     * downstream can tell — the same leak `from` is resolved to prevent, through
     * a different field.
     *
     * The mapping is built from the JIDs WhatsApp listed, never by pattern
     * matching the text, so a number somebody typed by hand is untouchable.
     * Anything that cannot be resolved is left as it was and logged, because a
     * visible LID beats a plausible-looking wrong number.
     */
    private async resolveMentions(
        cls: { text?: string; caption?: string },
        msg: WAMessage,
        groupJid?: string
    ): Promise<MentionedIdentity[]> {
        const jids = mentionedJidsOf(msg.message);
        if (!jids.length) return [];

        const mentions: MentionedIdentity[] = [];
        const rewrite = new Map<string, string>();

        for (const jid of jids) {
            if (isLidJid(jid)) {
                const lid = digitsOf(jid);
                const pn = await this.resolveParticipant(jid, groupJid, "a mention");
                const phone = pn ? digitsOf(pn) : null;
                // Only a resolved mention is rewritten in the body. An unresolved
                // one stays a LID on purpose: deleting it or substituting a
                // placeholder would change what the message says and hide that
                // the mapping is missing.
                if (phone) rewrite.set(lid, phone);
                mentions.push({ lid, phone });
            } else {
                // Already a phone JID. WhatsApp does support phone → LID, so the
                // canonical id can still be filled from the other direction.
                mentions.push({ lid: await this.lidFor(jid), phone: digitsOf(jid) });
            }
        }

        if (rewrite.size) {
            cls.text = rewriteMentions(cls.text, rewrite);
            cls.caption = rewriteMentions(cls.caption, rewrite);
        }
        return mentions;
    }

    /**
     * Phone → LID, the direction WhatsApp actually supports.
     *
     * Still best-effort: the store only knows pairings already seen on the wire.
     * Null is a normal answer here, not a failure.
     */
    private async lidFor(jid: string): Promise<string | null> {
        if (!jid || isGroupJid(jid) || isLidJid(jid)) return null;
        try {
            const lid = await this.sock?.signalRepository?.lidMapping?.getLIDForPN(stripDevice(jid));
            return lid ? digitsOf(lid) : null;
        } catch {
            return null;
        }
    }

    /**
     * Mapping store first, then the group roster we already hold.
     *
     * `where` only shapes the warning: knowing a LID went unresolved is useful,
     * knowing whether it was a mention or a quoted sender is what makes it
     * actionable.
     */
    private async resolveParticipant(
        jid: string,
        groupJid?: string,
        where = "an id"
    ): Promise<string | undefined> {
        const viaStore = await this.resolveToPn(jid);
        if (viaStore !== jid) return viaStore;

        // The roster carries `phoneNumber` beside a participant's LID, and for a
        // group we have usually just fetched it for the chat name — so this is a
        // cache read, not another rate-limited query.
        const roster = groupJid ? this.groupCache.get(groupJid)?.meta.participants : undefined;
        const hit = roster?.find(
            (p) => digitsOf(p.id) === digitsOf(jid) || digitsOf((p as any).lid) === digitsOf(jid)
        );
        if (hit?.phoneNumber) return hit.phoneNumber;

        this.log.warn({ jid, where }, "unresolved LID — passed through rather than reshaped");
        return undefined;
    }

    /**
     * A poll vote, which arrives as an ordinary message carrying a
     * `pollUpdateMessage`. Returns true when the message was one.
     *
     * Baileys used to decrypt these and re-emit them on `messages.update` with a
     * `pollUpdates` array. In v7 that code is commented out and marked "TODO:
     * Remove entirely", so nothing emits it any more — which is why every vote
     * silently vanished: we were listening for an event the library had stopped
     * producing. The decryption is done here instead.
     */
    private async handlePollVote(msg: WAMessage): Promise<boolean> {
        const update = unwrap(msg.message)?.pollUpdateMessage;
        const pollId = update?.pollCreationMessageKey?.id;
        if (!update?.vote || !pollId) return false;

        try {
            const stored = await this.stores.polls.findOne({ _id: scopedId(this.id, pollId) });
            if (!stored) {
                // A poll someone else created, or one older than the 90-day TTL.
                this.log.debug({ pollId }, "vote for a poll we do not hold");
                return true;
            }

            const creation = proto.Message.decode(Buffer.from(stored.message, "base64"));
            const pollEncKey = creation.messageContextInfo?.messageSecret;
            if (!pollEncKey) {
                this.log.warn({ pollId }, "stored poll has no message secret — cannot decrypt votes");
                return true;
            }

            // The creator and voter JIDs are mixed into the AES-GCM signature, so
            // the wrong *form* of an id fails authentication rather than
            // producing wrong output — it throws, and every vote is lost.
            //
            // `getKeyAuthor` prefers `participantAlt`, the phone-number form. In a
            // LID-addressed group the voter encrypted with the LID, so that
            // preference is exactly backwards here. Rather than guess the
            // addressing mode, try the forms we hold: LID first, since that is
            // where WhatsApp is heading and where this was observed failing.
            const meLid = this.sock?.user?.lid ? jidNormalizedUser(this.sock.user.lid) : undefined;
            const mePn = jidNormalizedUser(this.sock?.user?.id || "");
            const key = msg.key as typeof msg.key & { participantAlt?: string };
            const voterLid = key.participant ? jidNormalizedUser(key.participant) : undefined;
            const voterPn = key.participantAlt ? jidNormalizedUser(key.participantAlt) : undefined;

            const attempts: Array<{ creator: string; voter: string }> = [];
            for (const creator of [meLid, mePn]) {
                for (const voter of [voterLid, voterPn]) {
                    if (creator && voter) attempts.push({ creator, voter });
                }
            }

            let decrypted: ReturnType<typeof decryptPollVote> | undefined;
            let voterJid = voterLid || voterPn || "";
            for (const attempt of attempts) {
                try {
                    decrypted = decryptPollVote(update.vote, {
                        pollEncKey,
                        pollCreatorJid: attempt.creator,
                        pollMsgId: pollId,
                        voterJid: attempt.voter,
                    });
                    voterJid = attempt.voter;
                    // `info` because this path silently emitted nothing for
                    // weeks — 29 polls and zero votes — and a debug line would
                    // not have shown that either.
                    this.log.info({ pollId, ...attempt }, "poll vote decrypted");
                    break;
                } catch {
                    // Wrong form for this chat; try the next.
                }
            }
            if (!decrypted) {
                this.log.error(
                    { pollId, tried: attempts.length },
                    "could not decrypt a poll vote with any known id form"
                );
                return true;
            }

            // A vote names its choices as SHA-256 of the option text. Compared as
            // hex rather than via toString(), which differs between Buffer and
            // Uint8Array and would silently never match.
            const chosen = (decrypted.selectedOptions || []).map((o) =>
                Buffer.from(o).toString("hex")
            );

            // Replace this voter's previous selection; an empty one removes them,
            // which is what makes a cleared vote lower the counts.
            const votes = (stored.votes || []).filter((v) => v.voter !== voterJid);
            if (chosen.length) {
                votes.push({
                    voter: voterJid,
                    options: chosen,
                    at: Number(update.senderTimestampMs) || Date.now(),
                });
            }
            await this.stores.polls.updateOne({ _id: stored._id }, { $set: { votes } });

            await this.emitPollVote(msg, stored, votes, voterJid, chosen);
        } catch (e) {
            this.log.error({ e, pollId }, "failed to handle a poll vote");
        }
        return true;
    }

    /** Build the full tally and deliver it. */
    private async emitPollVote(
        msg: WAMessage,
        stored: { messageId: string; remoteJid: string; options: string[] },
        votes: Array<{ voter: string; options: string[] }>,
        voterJid: string,
        chosen: string[]
    ) {
        const hashOf = (name: string) =>
            createHash("sha256").update(Buffer.from(name)).digest("hex");

        // Every option, including ones nobody picked: a consumer showing a tally
        // needs the zeroes as much as the counts.
        const results = await Promise.all(
            stored.options.map(async (title, index) => {
                const hash = hashOf(title);
                const voters = votes.filter((v) => v.options.includes(hash)).map((v) => v.voter);
                const resolved = await Promise.all(
                    voters.map(async (v) =>
                        toUserId((await this.resolveParticipant(v, isGroupJid(stored.remoteJid) ? stored.remoteJid : undefined, "a poll voter")) ?? v)
                    )
                );
                return { id: String(index), title, count: resolved.length, voters: resolved };
            })
        );

        const selected = stored.options
            .map((title, index) => ({ id: String(index), title, hash: hashOf(title) }))
            .filter((o) => chosen.includes(o.hash))
            .map(({ id, title }) => ({ id, title }));

        const voterPn =
            (await this.resolveParticipant(
                voterJid,
                isGroupJid(stored.remoteJid) ? stored.remoteJid : undefined,
                "a poll voter"
            )) ?? voterJid;

        await this.webhook.send(
            buildCloudPollVoteEvent(
                {
                    id: msg.key.id || "",
                    from: toUserId(voterPn),
                    voterName: msg.pushName || undefined,
                    timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
                    pollMessageId: stored.messageId,
                    pollFrom: digitsOf(this.me?.id),
                    groupJid: isGroupJid(stored.remoteJid) ? stored.remoteJid : undefined,
                    selected,
                    results,
                },
                this.cloudMeta()
            )
        );
    }

    /**
     * Record that a message arrived, for the console's "is this actually
     * working?" line.
     *
     * A `connected` badge only proves a socket is open — which is equally true
     * of a session that has quietly stopped receiving. The timestamp is the
     * useful signal; the sender and chat make it recognisable, so you can match
     * it against a message you just sent yourself.
     */
    /**
     * Meta's `metadata` block. `businessAccountId` reuses the phone number id —
     * there is no WhatsApp Business Account here to have an id of its own, and
     * clients only ever echo it back.
     */
    private cloudMeta(): CloudMetadata {
        return {
            displayPhoneNumber: digitsOf(this.me?.id) || "",
            phoneNumberId: this.cfg.phoneNumberId,
            businessAccountId: this.cfg.phoneNumberId,
        };
    }

    private noteInbound(m: {
        at: Date;
        from: string;
        fromName?: string;
        chatName?: string;
        isGroup: boolean;
    }) {
        this.lastMessage = { ...m };
        this.messagesReceived++;

        // Persisted so a redeploy doesn't reset the answer to "never", but at
        // most once a minute: on a busy number this would otherwise be a Mongo
        // write per message, on a Pi, purely to render one line.
        const now = Date.now();
        if (now - this.lastActivityPersistedAt < 60_000) return;
        this.lastActivityPersistedAt = now;
        void this.stores.sessions
            .updateOne({ _id: this.id }, { $set: { lastMessage: this.lastMessage } })
            .catch((e) => this.log.debug({ e }, "could not persist last-message marker"));
    }

    private async onGroups(groups: GroupMetadata[]) {
        // Free metadata — this event already carries everything a fetch would
        // return, so caching it here spares a rate-limited round trip later.
        for (const g of groups) this.cacheGroup(g);
        for (const g of groups) await this.emitGroupEvent(g.id, g, { action: "upsert", participants: [] });
    }

    private async onGroupsUpdate(groups: Partial<GroupMetadata>[]) {
        for (const g of groups) {
            if (!g.id) continue;
            // An update carries only the changed fields. If the subject is one
            // of them, that IS the fresh value — keep it rather than dropping
            // the entry and hoping the refetch succeeds.
            if (g.subject) this.cacheGroup({ ...this.groupCache.get(g.id)?.meta, ...g });
            else this.groupCache.delete(g.id);
            await this.emitGroupEvent(g.id, undefined, { action: "update", participants: [] });
        }
    }

    private async onParticipants(u: { id: string; participants: any[]; action: string }) {
        const cached = this.groupCache.get(u.id);
        this.groupCache.delete(u.id);
        // Who was added/removed/promoted. Baileys hands these over as JIDs or,
        // in v7, as objects carrying the LID and phone-number forms side by
        // side; either way the consumer gets numbers, resolved like a sender's.
        const myPn = digitsOf(this.sock?.user?.id || "");
        const myLid = digitsOf(this.sock?.user?.lid || "");
        let selfRemoved = false;
        const affected: string[] = [];
        for (const p of u.participants || []) {
            const jid = typeof p === "string" ? p : String(p?.id || "");
            const alt = typeof p === "string" ? undefined : p?.phoneNumber;
            if (!jid) continue;
            if (
                u.action === "remove" &&
                ((myPn && digitsOf(jid) === myPn) ||
                    (myLid && digitsOf(jid) === myLid) ||
                    (alt && myPn && digitsOf(String(alt)) === myPn))
            ) {
                selfRemoved = true;
            }
            const pn = await this.resolveParticipant(jid, u.id, "a participant change");
            affected.push(pn || (alt ? String(alt) : jid));
        }
        // Once we're the one removed, a live metadata fetch is no longer
        // authorized and throws — which used to lose the event entirely,
        // exactly when a consumer most needs to hear about it. Fall back to
        // the roster we had a moment ago (or, failing that, a bare stub) so
        // the webhook still goes out instead of dying in emitGroupEvent's
        // catch.
        const known = selfRemoved
            ? (cached?.meta ?? { id: u.id, owner: undefined, subject: "", participants: [] })
            : undefined;
        await this.emitGroupEvent(u.id, known, {
            action: selfRemoved ? "remove_self" : String(u.action || ""),
            participants: affected,
        });
    }

    /**
     * The bots' `groups[]` handler re-fetches the authoritative roster via
     * GET /groups/:id anyway, so this event only needs to carry enough for them to
     * identify the group and decide whether to greet.
     */
    private async emitGroupEvent(jid: string, known?: GroupMetadata, change?: GroupChange) {
        try {
            const meta = known || (await this.getGroupMetadata(jid));
            const participants = await this.groupParticipantIds(meta);
            await this.webhook.send(
                buildCloudGroupEvent(jid, meta.subject, participants, this.cloudMeta(), change)
            );
        } catch (e) {
            this.log.error({ e, jid }, "failed to emit group event");
        }
    }

    /**
     * Forward contact names, but only when they're actually news.
     *
     * WhatsApp re-emits `contacts.update` for the same contact with the same
     * name over and over, and now that history sync is on, connecting produces
     * a burst of them for the entire address book. Every one of those used to be
     * its own webhook delivery — a bot being told six times an hour that AdiC is
     * still called AdiC, and a visible pile of noise in anything watching the
     * endpoint.
     *
     * So remember what we've already said and send only the differences.
     */
    private async onContacts(contacts: Array<Partial<import("baileys").Contact>>) {
        const payload = [];
        for (const c of contacts) {
            const name = c.name || c.notify;
            if (!c.id || !name) continue;
            // `phoneNumber` is the resolved form when `id` is a LID.
            const jid = await this.resolveToPn(c.id, c.phoneNumber);
            const id = digitsOf(jid);
            if (!id || this.emittedContacts.get(id) === name) continue;
            this.emittedContacts.set(id, name);
            payload.push({ id, name });
        }

        // Bounded: an address book is finite, but this must not be the thing
        // that grows a long-lived process out of memory.
        if (this.emittedContacts.size > 5000) this.emittedContacts.clear();

        if (!payload.length) return;
        await this.webhook.send(buildCloudContactsEvent(payload, this.cloudMeta()));
    }

    // ----------------------------------------------------------------- outbound

    private assertReady(): WASocket {
        if (!this.sock || this.status !== "connected") {
            throw new Error(`session "${this.id}" not connected (status: ${this.status})`);
        }
        return this.sock;
    }

    private guardRate() {
        // No limiter means this number is uncapped, by configuration.
        if (this.limiter && !this.limiter.tryTake()) {
            throw new Error(`send rate limit exceeded for session "${this.id}"`);
        }
    }

    /**
     * Does this string address this number?
     *
     * Used only to catch a client posting to `/<some-other-number-id>/messages`
     * with this number's token — the token is what routes, so an unrecognised
     * segment is fine and ignored, but one belonging to a *different* number is
     * a misconfiguration that would otherwise send from the wrong account.
     */
    matchesAddress(value: string): boolean {
        const v = String(value || "").trim().toLowerCase();
        if (!v) return false;
        return (
            v === this.id ||
            v === this.cfg.phoneNumberId ||
            (!!this.me?.id && digitsOf(this.me.id) === digitsOf(v))
        );
    }

    /**
     * Send in Cloud API terms. Returns the wa_id Meta's response echoes back —
     * the group id for a group, the recipient's digits otherwise.
     */
    async sendCloud(req: CloudSendRequest): Promise<{ messageId?: string; waId: string }> {
        const k = req.kind;
        const startedAt = Date.now();
        let result: { messageId?: string; waId: string };
        try {
            result = await this.dispatchCloud(req);
        } catch (e) {
            // The route logs the error too, but without the type or recipient —
            // and "which send failed" is the first question. A rejected request
            // is the caller's mistake, so it stays a warn.
            this.log.warn(
                { e, type: k.type, to: req.to, ms: Date.now() - startedAt },
                "send failed"
            );
            throw e;
        }
        // The outbound counterpart of "message received". Without it a bot that
        // says it sent something and a number that never showed it are two
        // claims with nothing between them; this is that something. Metadata
        // only, for the same reason the inbound line is.
        this.log.info(
            {
                id: result.messageId,
                type: k.type,
                to: result.waId || undefined,
                group: result.waId ? isGroupJid(toWaJid(req.to) || "") || undefined : undefined,
                ms: Date.now() - startedAt,
            },
            "message sent"
        );
        return result;
    }

    private async dispatchCloud(req: CloudSendRequest): Promise<{ messageId?: string; waId: string }> {
        const k = req.kind;

        // A status update carries no recipient at all.
        if (k.type === "read") {
            await this.markRead(k.messageId);
            if (k.typing) {
                const key = await this.recallKey(k.messageId);
                if (key) await this.sendPresence(key.remoteJid, "typing");
            }
            return { messageId: k.messageId, waId: "" };
        }

        const jid = toWaJid(req.to);
        if (!jid) {
            throw new CloudRequestError(
                "(#100) Missing or invalid parameter: to",
                100,
                `"${req.to}" is not a phone number or group id this gateway can route to.`
            );
        }
        const waId = isGroupJid(jid) ? toChatId(jid) : toUserId(jid);

        switch (k.type) {
            case "text": {
                const sent = await this.sendText(req.to, k.body, k.mentions, req.replyTo);
                return { messageId: sent.id, waId };
            }
            case "image": {
                const sent = await this.sendImage(req.to, k.media, k.caption, req.replyTo);
                return { messageId: sent.id, waId };
            }
            case "reaction": {
                await this.react(k.messageId, k.emoji);
                return { messageId: k.messageId, waId };
            }
            case "poll": {
                const sent = await this.sendPoll(req.to, k.name, k.options, k.selectableCount);
                return { messageId: sent.id, waId };
            }
            case "audio":
            case "video":
            case "document":
            case "sticker":
            case "location": {
                const sent = await this.sendCloudMedia(jid, k, req.replyTo);
                return { messageId: sent.id, waId };
            }
        }
    }

    /** The media and location kinds with no per-verb route of their own. */
    private async sendCloudMedia(
        jid: string,
        k: Extract<CloudSendKind, { type: "audio" | "video" | "document" | "sticker" | "location" }>,
        replyTo?: string
    ): Promise<{ id?: string }> {
        const sock = this.assertReady();
        this.guardRate();

        let content: any;
        if (k.type === "location") {
            content = { location: { degreesLatitude: k.latitude, degreesLongitude: k.longitude, name: k.name, address: k.address } };
        } else {
            const media = k.media.startsWith("http://") || k.media.startsWith("https://")
                ? { url: k.media }
                : Buffer.from(k.media.startsWith("data:") ? k.media.split(",")[1] ?? "" : k.media, "base64");
            if (k.type === "audio") content = { audio: media, mimetype: "audio/mp4" };
            else if (k.type === "video") content = { video: media, caption: k.caption };
            else if (k.type === "sticker") content = { sticker: media };
            else content = { document: media, caption: k.caption, fileName: k.filename || "file", mimetype: documentMime(k.media, k.filename) };
        }

        const sent = await sock.sendMessage(jid, content as any, await this.quoteOptions(replyTo));
        this.lastSentAt = new Date();
        if (sent) await this.rememberKey(sent);
        return { id: sent?.key?.id || undefined };
    }

    async sendText(to: string, body: string, mentions: string[] = [], replyTo?: string): Promise<{ id?: string }> {
        const sock = this.assertReady();
        this.guardRate();
        const jid = toWaJid(to);
        if (!jid) throw new Error(`unroutable recipient: ${to}`);
        const mentionedJid = await this.mentionJids(mentions);
        const sent = await sock.sendMessage(
            jid,
            mentionedJid.length ? { text: body, mentions: mentionedJid } : { text: body },
            await this.quoteOptions(replyTo)
        );
        this.lastSentAt = new Date();
        if (sent) await this.rememberKey(sent);
        return { id: sent?.key?.id || undefined };
    }

    /**
     * Baileys' send options for a reply: the quoted message's full key plus its
     * content, both from the key store. The content is what WhatsApp shows in
     * the quote box; when it has expired (a week) the quote still points at the
     * right message, WhatsApp just shows it without a preview. An unknown id is
     * logged and the message goes out unquoted rather than not at all.
     */
    private async quoteOptions(replyTo?: string): Promise<{ quoted?: WAMessage }> {
        if (!replyTo) return {};
        const doc = await this.stores.messageKeys
            .findOne({ _id: scopedId(this.id, replyTo) })
            .catch(() => null);
        if (!doc) {
            const fetched = this.fetched.get(replyTo);
            if (fetched) return { quoted: fetched };
            this.log.warn({ replyTo }, "reply to a message this gateway never saw — sent without a quote");
            return {};
        }
        const message = doc.message
            ? proto.Message.decode(Buffer.from(doc.message, "base64"))
            : { conversation: "" };
        return {
            quoted: {
                key: {
                    id: doc.messageId,
                    remoteJid: doc.remoteJid,
                    fromMe: doc.fromMe,
                    participant: doc.participant,
                },
                message,
            } as WAMessage,
        };
    }

    /**
     * The JIDs to declare for an outbound mention list.
     *
     * A tag renders when the `@<user>` in the text matches a JID in
     * `contextInfo.mentionedJid`. The consumer writes phone numbers into the
     * body, so the phone-number JID is what must be declared; in a LID-addressed
     * group the client may only know the person by LID, so where the mapping
     * store has one, that form is declared beside it. Declaring both is
     * harmless — an unmatched entry is simply ignored — and it is the same
     * "carry both ids" rule the inbound side follows.
     */
    private async mentionJids(mentions: string[]): Promise<string[]> {
        const out: string[] = [];
        for (const raw of mentions || []) {
            const digits = String(raw ?? "").replace(/\D/g, "");
            if (!digits) continue;
            const pnJid = `${digits}@s.whatsapp.net`;
            if (!out.includes(pnJid)) out.push(pnJid);
            const lid = await this.lidFor(pnJid);
            if (lid && !out.includes(`${lid}@lid`)) out.push(`${lid}@lid`);
        }
        return out;
    }

    async sendImage(to: string, media: string, caption?: string, replyTo?: string): Promise<{ id?: string }> {
        const sock = this.assertReady();
        this.guardRate();
        const jid = toWaJid(to);
        if (!jid) throw new Error(`unroutable recipient: ${to}`);

        // Callers send a data: URI, an http(s) URL, or raw base64 — all three are
        // common enough in the wild that rejecting any of them is a papercut.
        let image: Buffer | { url: string };
        if (media.startsWith("http://") || media.startsWith("https://")) {
            image = { url: media };
        } else {
            const base64 = media.startsWith("data:") ? media.split(",")[1] ?? "" : media;
            image = Buffer.from(base64, "base64");
        }

        const sent = await sock.sendMessage(jid, { image, caption: caption || undefined } as any, await this.quoteOptions(replyTo));
        if (sent) await this.rememberKey(sent);
        return { id: sent?.key?.id || undefined };
    }

    /**
     * `selectableCount` is how many options one voter may pick, passed straight
     * through to WhatsApp. Baileys sends a single-select poll for exactly 1 and a
     * multiple-choice one otherwise, so this is the whole control.
     */
    async sendPoll(
        to: string,
        name: string,
        options: string[],
        selectableCount: number
    ): Promise<{ id?: string }> {
        const sock = this.assertReady();
        this.guardRate();
        const jid = toWaJid(to);
        if (!jid) throw new Error(`unroutable recipient: ${to}`);

        const sent = await sock.sendMessage(jid, {
            poll: { name, values: options, selectableCount },
        });
        if (!sent?.key?.id) throw new Error("poll send returned no message id");

        await this.rememberKey(sent);
        // Vote updates arrive encrypted and can only be decrypted with the original
        // creation message, so it has to outlive this process.
        await this.stores.polls.updateOne(
            { _id: scopedId(this.id, sent.key.id) },
            {
                $set: {
                    sessionId: this.id,
                    messageId: sent.key.id,
                    remoteJid: jid,
                    message: Buffer.from(proto.Message.encode(sent.message!).finish()).toString("base64"),
                    name,
                    options,
                    createdAt: new Date(),
                },
            },
            { upsert: true }
        );
        return { id: sent.key.id };
    }

    async react(messageId: string, emoji: string): Promise<void> {
        const sock = this.assertReady();
        const key = await this.recallKey(messageId);
        if (!key) throw new Error(`unknown message id: ${messageId}`);
        await sock.sendMessage(key.remoteJid, { react: { text: emoji, key: key as any } });
    }

    async markRead(messageId: string): Promise<void> {
        const sock = this.assertReady();
        const key = await this.recallKey(messageId);
        if (!key) throw new Error(`unknown message id: ${messageId}`);
        await sock.readMessages([key as any]);
    }

    async sendPresence(
        to: string,
        presence: "typing" | "recording" | "paused" | "available"
    ): Promise<void> {
        const sock = this.assertReady();
        const jid = toWaJid(to);
        if (!jid) throw new Error(`unroutable recipient: ${to}`);
        const map = {
            typing: "composing",
            recording: "recording",
            paused: "paused",
            available: "available",
        } as const;
        await sock.sendPresenceUpdate(map[presence], jid);
    }

    // ------------------------------------------------------------------- groups

    async getGroupMetadata(jid: string): Promise<GroupMetadata> {
        const cached = this.groupCache.get(jid);
        // 5 minutes. WhatsApp rate-limits metadata queries hard, and the bots call
        // getGroupInfo on every single group event.
        if (cached && Date.now() - cached.at < 5 * 60_000) return cached.meta;

        try {
            const sock = this.assertReady();
            const meta = await sock.groupMetadata(jid);
            this.groupCache.set(jid, { meta, at: Date.now() });
            return meta;
        } catch (e) {
            // A stale name is enormously better than no name. WhatsApp
            // rate-limits these queries and the socket may be mid-reconnect, so
            // a refresh failing is routine — but dropping the group's name from
            // every message until it succeeds is not, and that is what made
            // messages arrive as "in a group" with no idea which.
            if (cached) {
                this.log.debug({ e, jid }, "group metadata refresh failed, using cached");
                return cached.meta;
            }
            throw e;
        }
    }

    /** Remember metadata Baileys volunteers, so we don't have to go asking. */
    private cacheGroup(meta?: Partial<GroupMetadata>) {
        if (!meta?.id || !meta.subject) return;
        this.groupCache.set(meta.id, { meta: meta as GroupMetadata, at: Date.now() });
    }

    /**
     * Participant ids as phone numbers.
     *
     * `GroupParticipant` extends `Contact`, which carries an explicit
     * `phoneNumber` alongside the (possibly LID) `id` — so prefer that, and only
     * fall back to a mapping lookup when it's absent.
     */
    async groupParticipantIds(
        meta: GroupMetadata
    ): Promise<Array<{ id: string; lid: string | null; name?: string }>> {
        return Promise.all(
            (meta.participants || []).map(async (p) => ({
                id: p.phoneNumber || (await this.resolveToPn(p.id)),
                // Carried for the same reason mentions carry it: the number is
                // what the migration takes away, the LID is what survives it.
                lid: (p as any).lid
                    ? digitsOf((p as any).lid)
                    : isLidJid(p.id)
                      ? digitsOf(p.id)
                      : null,
                name: p.name || p.notify || undefined,
            }))
        );
    }

    async groupInfo(jid: string) {
        const meta = await this.getGroupMetadata(jid);
        const participants = await this.groupParticipantIds(meta);
        return { meta, participants };
    }

    // ------------------------------------------------------------ message keys

    /**
     * The message APIs take a bare id (`PUT /messages/{id}`), but Baileys needs
     * the full key — remoteJid, fromMe and participant. So every message we see or
     * send gets its key stored, scoped to this session and TTL'd to a week.
     */
    private async rememberKey(msg: WAMessage, keepBody = false) {
        const k = msg.key;
        if (!k?.id || !k.remoteJid) return;
        try {
            await this.stores.messageKeys.updateOne(
                { _id: scopedId(this.id, k.id) },
                {
                    $set: {
                        sessionId: this.id,
                        messageId: k.id,
                        remoteJid: k.remoteJid,
                        fromMe: !!k.fromMe,
                        participant: k.participant || undefined,
                        // Our own messages, because a retry receipt asks us to
                        // re-send something WE sent — an inbound body would
                        // otherwise be stored for nothing. The exception is an
                        // inbound document, where the body is the only handle on
                        // a file we deliberately did not download: url, mediaKey
                        // and enc-sha, no bytes. See MessageKeyDoc.message.
                        ...((k.fromMe || keepBody) && msg.message
                            ? {
                                  message: Buffer.from(
                                      proto.Message.encode(msg.message).finish()
                                  ).toString("base64"),
                              }
                            : {}),
                        createdAt: new Date(),
                    },
                },
                { upsert: true }
            );
        } catch (e) {
            this.log.warn({ e, id: k.id }, "failed to remember message key");
        }
    }

    private async recallKey(id: string) {
        const doc = await this.stores.messageKeys.findOne({ _id: scopedId(this.id, id) });
        if (!doc) {
            // A message an MCP read just fetched from the phone: known only in memory.
            const k = this.fetched.get(id)?.key;
            return k?.id && k.remoteJid
                ? { id: k.id, remoteJid: k.remoteJid, fromMe: !!k.fromMe, participant: k.participant || undefined }
                : null;
        }
        return {
            id: doc.messageId,
            remoteJid: doc.remoteJid,
            fromMe: doc.fromMe,
            participant: doc.participant,
        };
    }

    /** Baileys calls this when it needs a message body back (poll votes, retries). */
    private async lookupMessage(key: proto.IMessageKey): Promise<proto.IMessage | undefined> {
        if (!key.id) return undefined;

        // Polls first: their creation message outlives the 7-day key TTL because
        // vote tallies accrue for months.
        const poll = await this.stores.polls
            .findOne({ _id: scopedId(this.id, key.id) })
            .catch(() => null);
        if (poll) return proto.Message.decode(Buffer.from(poll.message, "base64"));

        // Then anything we sent. This is what answers a retry receipt, and
        // returning undefined here is why a recipient can sit on "Waiting for
        // this message" indefinitely — nothing ever re-sends it.
        const sent = await this.stores.messageKeys
            .findOne({ _id: scopedId(this.id, key.id) })
            .catch(() => null);
        if (sent?.message) {
            return proto.Message.decode(Buffer.from(sent.message, "base64"));
        }

        this.log.warn(
            { id: key.id },
            "a retry asked for a message we no longer hold — the recipient will keep waiting"
        );
        return undefined;
    }

    // ----------------------------------------------------------------- documents

    /**
     * Inbound documents are fetched on demand, never on receipt.
     *
     * This is Meta's own model — a webhook hands you a media id, and you call
     * `GET /<MEDIA_ID>` if and when you want the file — and it is the only sane
     * one here: most files posted in a group are never read by any bot, so
     * downloading them all means warehousing everybody's documents on a
     * Raspberry Pi for the few that matter. What is kept is the pointer
     * (WhatsApp's url, the media key, the enc-sha), which is what `rememberKey`
     * stores for a document and nothing else.
     *
     * Null for anything that is not a document this session received: an
     * unknown id, another session's id (ids are scoped), or one whose key has
     * aged out of the week-long TTL. The caller turns all three into a 404 —
     * they are indistinguishable to a client and should be.
     */
    private async documentOf(
        mediaId: string
    ): Promise<{ msg: WAMessage; doc: proto.Message.IDocumentMessage } | null> {
        const rec = await this.stores.messageKeys
            .findOne({ _id: scopedId(this.id, mediaId) })
            .catch((e) => {
                this.log.warn({ e, id: mediaId }, "could not read stored message key");
                return null;
            });
        if (!rec?.message) return null;

        let message: proto.IMessage;
        try {
            message = proto.Message.decode(Buffer.from(rec.message, "base64"));
        } catch (e) {
            this.log.warn({ e, id: mediaId }, "stored message body would not decode");
            return null;
        }

        const doc = unwrap(message)?.documentMessage;
        if (!doc) return null;

        return {
            msg: {
                key: {
                    id: rec.messageId,
                    remoteJid: rec.remoteJid,
                    fromMe: rec.fromMe,
                    participant: rec.participant,
                },
                message,
            } as WAMessage,
            doc,
        };
    }

    /** Meta's media-metadata answer, for a document this session received. */
    async documentMetadata(mediaId: string) {
        const found = await this.documentOf(mediaId);
        if (!found) {
            // A 404 here is the one failure a client cannot tell apart from the
            // others by design, so the log is where the difference has to live —
            // otherwise "it says 404" is unanswerable.
            this.log.info({ id: mediaId }, "media lookup for an id this number does not hold");
            return null;
        }
        const d = found.doc;
        this.log.info(
            {
                id: mediaId,
                filename: d.fileName,
                mime: d.mimetype,
                bytes: d.fileLength ? Number(d.fileLength) : undefined,
            },
            "media lookup"
        );
        return {
            mimetype: d.mimetype || "application/octet-stream",
            filename: d.fileName || undefined,
            // base64, matching what the webhook already reported for this file —
            // a client can compare the two without re-encoding either.
            sha256: d.fileSha256 ? Buffer.from(d.fileSha256).toString("base64") : undefined,
            size: d.fileLength ? Number(d.fileLength) : undefined,
        };
    }

    /**
     * The document's bytes, as a stream.
     *
     * Nothing is written to disk on the way through — this is WhatsApp's own
     * blob, decrypted in flight and piped at the client. "Don't store anything"
     * is the point, so don't quietly add a cache here.
     */
    async documentStream(
        mediaId: string
    ): Promise<{ stream: Readable; mimetype: string; filename?: string } | null> {
        const found = await this.documentOf(mediaId);
        if (!found) {
            this.log.info({ id: mediaId }, "document requested that this number does not hold");
            return null;
        }

        const sock = this.sock;
        if (!sock) {
            // Fetching needs a live socket for the re-upload path below, and a
            // reconnect is usually seconds away — 503 is the honest answer.
            this.log.warn({ id: mediaId }, "document requested while disconnected");
            throw new Error("this number is not connected to WhatsApp right now");
        }

        const startedAt = Date.now();
        this.log.info(
            { id: mediaId, filename: found.doc.fileName, bytes: found.doc.fileLength ? Number(found.doc.fileLength) : undefined },
            "document fetch started"
        );

        const stream = (await downloadMediaMessage(
            found.msg,
            "stream",
            {},
            {
                logger: baileysLogger,
                // WhatsApp's CDN drops older media; this asks the sending device
                // to put it back. Without it anything more than a few days old
                // fails here, which is well inside the week the pointer lives.
                reuploadRequest: sock.updateMediaMessage,
            }
        )) as unknown as Readable;

        // Counted here rather than in the route because this is the only place
        // that sees every byte: a truncated download reads as a success from the
        // HTTP side, and the gap between this and `bytes` above is the symptom.
        let sent = 0;
        stream.on("data", (chunk: Buffer) => {
            sent += chunk.length;
        });
        stream.on("end", () => {
            this.log.info(
                { id: mediaId, bytes: sent, ms: Date.now() - startedAt },
                "document fetch complete"
            );
        });

        return {
            stream,
            mimetype: found.doc.mimetype || "application/octet-stream",
            filename: found.doc.fileName || undefined,
        };
    }

    // ---------------------------------------------------------------- MCP index

    /**
     * Keep the chat list current: which chats moved, when, how many unread, and
     * the newest message's key. No content — the text is never written, and the
     * key is what lets `readChat` ask the phone for the history instead.
     */
    private async trackMessage(msg: WAMessage, type: string) {
        const key = msg.key as WAMessage["key"] & { remoteJidAlt?: string; participantAlt?: string };
        const rawJid = key?.remoteJid;
        if (!rawJid || !key.id) return;
        // Status updates, channels and broadcast lists are not chats a person
        // replies in.
        if (rawJid === "status@broadcast" || rawJid.endsWith("@newsletter") || rawJid.endsWith("@broadcast")) return;
        const isGroup = isGroupJid(rawJid);

        if (!key.fromMe && msg.pushName) {
            const sender = isGroup ? key.participant || msg.participant : rawJid;
            const alt = isGroup ? key.participantAlt : key.remoteJidAlt;
            if (sender) await this.trackContacts([{ id: sender, phoneNumber: alt || undefined, notify: msg.pushName }]);
        }

        if (!isConversationMessage(msg.message)) return;

        // Our own sends and offline arrivals come as "append" and never reach
        // `handleMessage`, which is what remembers keys for live inbound
        // messages. Without this a model could not react to or quote them.
        // Not for a history bootstrap: those only seed anchors, and keeping
        // their bodies would be exactly the backfill this gateway refuses.
        if (type !== "history" && (key.fromMe || type !== "notify")) await this.rememberKey(msg, true);

        const jid = isGroup ? rawJid : await this.resolveToPn(rawJid, key.remoteJidAlt);
        const at = Session.sentAt(msg).getTime();
        const live = !key.fromMe && type === "notify";
        const name = isGroup ? this.groupCache.get(rawJid)?.meta.subject : !key.fromMe ? msg.pushName || undefined : undefined;

        const $set: Partial<ChatDoc> = {
            sessionId: this.id,
            jid,
            rawJid,
            isGroup,
            lastMessageAt: new Date(at),
            anchor: { id: key.id, fromMe: !!key.fromMe, participant: key.participant || undefined, remoteJid: rawJid, at },
            updatedAt: new Date(),
            ...(name ? { name } : {}),
            // Writing in a chat means having read it — the phone clears it the same way.
            ...(key.fromMe ? { unreadCount: 0 } : {}),
        };
        const update: any = { $set };
        if (live) update.$inc = { unreadCount: 1 };
        else if (!key.fromMe) update.$setOnInsert = { unreadCount: 0 };

        try {
            // Only ever moves forward: an older message (an offline backlog
            // arriving out of order) must not replace a newer anchor. The filter
            // fails to match it, the upsert then collides with the existing
            // _id, and that collision is the "older, ignore" answer.
            await this.stores.chats.updateOne(
                {
                    _id: scopedId(this.id, jid),
                    $or: [{ lastMessageAt: { $lte: new Date(at) } }, { lastMessageAt: { $exists: false } }],
                },
                update,
                { upsert: true }
            );
        } catch (e: any) {
            if (e?.code !== 11000) throw e;
        }
    }

    /** Chats WhatsApp announces (history bootstrap, a new chat): listed even before a message moves them. */
    private async seedChats(chats: Array<Partial<import("baileys").Chat>>) {
        for (const c of chats) {
            if (!c.id || c.id === "status@broadcast" || c.id.endsWith("@newsletter") || c.id.endsWith("@broadcast")) continue;
            const isGroup = isGroupJid(c.id);
            const jid = isGroup ? c.id : (await this.quietPn(c.id)) || c.id;
            const ts = Number(c.conversationTimestamp || 0);
            await this.stores.chats
                .updateOne(
                    { _id: scopedId(this.id, jid) },
                    {
                        $setOnInsert: {
                            sessionId: this.id,
                            jid,
                            rawJid: c.id,
                            isGroup,
                            lastMessageAt: new Date(ts > 0 ? ts * 1000 : 0),
                            unreadCount: Math.max(0, Number(c.unreadCount || 0)),
                            updatedAt: new Date(),
                        },
                        ...(c.name ? { $set: { name: c.name } } : {}),
                    },
                    { upsert: true }
                )
                .catch((e) => this.log.debug({ e, jid }, "could not seed chat"));
        }
    }

    /**
     * Read state from the phone. Only the two values that mean something on
     * their own are taken: 0 (read there) and negative (marked unread there).
     * Positive counts are increments Baileys derives from the same messages
     * `trackMessage` already counted, and adding them would count twice.
     */
    private async onChatsUpdate(updates: Array<Partial<import("baileys").Chat>>) {
        for (const u of updates) {
            if (!u.id || typeof u.unreadCount !== "number" || u.unreadCount > 0) continue;
            const jid = isGroupJid(u.id) ? u.id : (await this.quietPn(u.id)) || u.id;
            await this.stores.chats
                .updateMany(
                    { sessionId: this.id, $or: [{ jid }, { rawJid: u.id }] },
                    u.unreadCount === 0 ? { $set: { unreadCount: 0 } } : { $max: { unreadCount: 1 } }
                )
                .catch((e) => this.log.debug({ e }, "could not apply chat read state"));
        }
    }

    /**
     * History sync deliveries. An ON_DEMAND one is the answer to `readChat`,
     * and goes straight back to it without touching Mongo; the bootstrap kinds
     * seed the chat list and names on an MCP number.
     */
    private async onHistorySet(h: {
        chats: Array<Partial<import("baileys").Chat>>;
        contacts: Array<Partial<import("baileys").Contact>>;
        messages: WAMessage[];
        syncType?: number | null;
        peerDataRequestSessionId?: string | null;
    }) {
        if (h.syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
            const pending = this.pendingHistory;
            if (!pending) return;
            // Matched by request id when WhatsApp echoes it; with one request in
            // flight at a time, the only pending one is the answer otherwise.
            if (pending.requestId && h.peerDataRequestSessionId && pending.requestId !== h.peerDataRequestSessionId) return;
            pending.resolve(h.messages || []);
            return;
        }
        if (!this.mcpEnabled) return;
        await this.trackContacts(h.contacts || []);
        await this.seedChats(h.chats || []);
        // Anchors only: these messages are not stored, but the newest key per
        // chat is what makes a chat readable before anyone writes in it again.
        for (const m of h.messages || []) await this.trackMessage(m, "history").catch(() => {});
    }

    /** LID → phone through the mapping store, without the loud warning `resolveToPn` gives. */
    private async quietPn(jid: string): Promise<string | undefined> {
        if (!isLidJid(jid)) return jid;
        try {
            return (await this.sock?.signalRepository?.lidMapping?.getPNForLID(jid)) || undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Names for people: the address-book name, their own push name, and the
     * business name. Keyed by phone digits where the LID resolves, else by the
     * LID — both ids are kept, as everywhere else.
     */
    private async trackContacts(contacts: Array<Partial<import("baileys").Contact>>) {
        for (const c of contacts) {
            if (!c.id || isGroupJid(c.id) || c.id.endsWith("@newsletter") || c.id.endsWith("@broadcast")) continue;
            const lidJid = c.lid || (isLidJid(c.id) ? c.id : undefined);
            const pn = c.phoneNumber || (isLidJid(c.id) ? await this.quietPn(c.id) : c.id);
            const jid = stripDevice(pn && !isLidJid(pn) ? pn : lidJid || c.id);
            const digits = digitsOf(jid);
            if (!digits) continue;

            const fields: Partial<ContactDoc> = {
                ...(c.name ? { name: c.name } : {}),
                ...(c.notify ? { notify: c.notify } : {}),
                ...(c.verifiedName ? { verifiedName: c.verifiedName } : {}),
                ...(lidJid ? { lid: digitsOf(lidJid) } : {}),
            };
            const signature = JSON.stringify(fields);
            if (signature === "{}" || this.writtenContacts.get(digits) === signature) continue;
            this.writtenContacts.set(digits, signature);
            if (this.writtenContacts.size > 5000) this.writtenContacts.clear();

            await this.stores.contacts
                .updateOne(
                    { _id: scopedId(this.id, digits) },
                    { $set: { sessionId: this.id, jid, ...fields, updatedAt: new Date() } },
                    { upsert: true }
                )
                .catch((e) => this.log.debug({ e }, "could not store contact"));
        }
    }

    // ---------------------------------------------------------------- MCP reads

    private assertMcp() {
        if (!this.mcpEnabled) throw new Error(`MCP access is off for "${this.id}"`);
    }

    /** A chat by whatever the caller has: phone digits, a group id, a jid. */
    private async findChat(input: string): Promise<ChatDoc | null> {
        const jid = toWaJid(input);
        if (!jid) return null;
        return this.stores.chats.findOne({
            sessionId: this.id,
            $or: [{ _id: scopedId(this.id, jid) }, { rawJid: jid }],
        });
    }

    /** Display name for a 1:1 chat or a contact: address book first, then what they call themselves. */
    private static nameOf(c?: Partial<ContactDoc> | null): string | undefined {
        return c?.name || c?.notify || c?.verifiedName || undefined;
    }

    /** The id a model should pass back: digits for a person, the @g.us id for a group, a raw LID when unresolved. */
    static chatIdOf(jid: string): string {
        if (isGroupJid(jid) || isLidJid(jid)) return jid;
        return digitsOf(jid);
    }

    async listChats(opts: { limit: number; unreadOnly?: boolean }) {
        this.assertMcp();
        const chats = await this.stores.chats
            .find({ sessionId: this.id, ...(opts.unreadOnly ? { unreadCount: { $gt: 0 } } : {}) })
            .sort({ lastMessageAt: -1 })
            .limit(opts.limit)
            .toArray();
        const people = await this.stores.contacts
            .find({ _id: { $in: chats.filter((c) => !c.isGroup).map((c) => scopedId(this.id, digitsOf(c.jid))) } })
            .toArray();
        const byId = new Map(people.map((p) => [p._id, p]));
        const groups = chats.some((c) => c.isGroup && !c.name) ? await this.listGroups().catch(() => []) : [];
        return chats.map((c) => ({
            chat_id: Session.chatIdOf(c.jid),
            name: c.isGroup
                ? c.name || groups.find((g) => g.id === c.jid)?.subject
                : Session.nameOf(byId.get(scopedId(this.id, digitsOf(c.jid)))) || c.name,
            is_group: c.isGroup,
            last_message_at: c.lastMessageAt.toISOString(),
            unread: c.unreadCount,
            last_message_from_me: c.anchor?.fromMe,
        }));
    }

    /** Every group this number is in, from one query rather than one per group. */
    async listGroups(): Promise<GroupMetadata[]> {
        if (this.allGroups && Date.now() - this.allGroups.at < 10 * 60_000) return this.allGroups.groups;
        const sock = this.assertReady();
        const groups = Object.values(await sock.groupFetchAllParticipating());
        for (const g of groups) this.cacheGroup(g);
        this.allGroups = { at: Date.now(), groups };
        return groups;
    }

    /**
     * People and groups whose name, push name or number contains the query.
     * Read from the names this number has been told about — WhatsApp has no
     * server-side contact search to ask.
     */
    async searchContacts(query: string, limit: number) {
        this.assertMcp();
        const q = String(query || "").trim();
        const qDigits = q.replace(/\D/g, "");
        const byNumber = qDigits.length >= 3 && qDigits.length === q.replace(/[\s+()-]/g, "").length;

        const people = (await this.stores.contacts.find({ sessionId: this.id }).toArray())
            .filter((c) =>
                byNumber
                    ? digitsOf(c.jid).includes(qDigits)
                    : matchesQuery([c.name, c.notify, c.verifiedName].filter(Boolean).join(" "), q)
            )
            .slice(0, limit)
            .map((c) => ({
                chat_id: Session.chatIdOf(c.jid),
                name: Session.nameOf(c),
                saved_name: c.name,
                push_name: c.notify,
                phone: isLidJid(c.jid) ? null : digitsOf(c.jid),
                lid: c.lid ?? (isLidJid(c.jid) ? digitsOf(c.jid) : null),
                is_group: false,
            }));

        const groups = byNumber
            ? []
            : (await this.listGroups().catch(() => []))
                  .filter((g) => matchesQuery(g.subject, q))
                  .slice(0, limit)
                  .map((g) => ({ chat_id: g.id, name: g.subject, participants: g.participants?.length, is_group: true }));

        return [...groups, ...people].slice(0, limit);
    }

    /**
     * A page of a chat, fetched from the phone and kept nowhere.
     *
     * WhatsApp's servers hold no history, so a linked device can only read a
     * chat by asking the primary phone, which answers with up to `limit`
     * messages older than a given one. The newest key this gateway has seen in
     * the chat is that starting point; `before` (a cursor from an earlier page)
     * pages further back. The phone has to be online for this to answer.
     */
    async readChat(chatInput: string, opts: { limit: number; before?: HistoryAnchor }) {
        this.assertMcp();
        const chat = await this.findChat(chatInput);
        if (!chat) {
            throw new Error(
                `no activity seen in "${chatInput}" since MCP was turned on. WhatsApp can only page history ` +
                    `back from a message this device has seen — once anyone writes there, it becomes readable.`
            );
        }
        const anchor = opts.before ?? chat.anchor;
        if (!anchor) throw new Error(`no message seen in "${chatInput}" yet to read back from`);
        if (anchor.remoteJid !== chat.rawJid && toWaJid(anchor.remoteJid) !== chat.jid) {
            throw new Error("that cursor belongs to a different chat");
        }

        const messages: WAMessage[] = [];
        // The phone answers with messages *older* than the anchor, so the
        // newest one has to come from what this gateway already holds.
        if (!opts.before) {
            const newest = await this.messageWithBody(anchor.id);
            // The key store's createdAt is when we saw it, not when it was sent.
            if (newest) messages.push({ ...newest, messageTimestamp: Math.floor(anchor.at / 1000) } as WAMessage);
        }
        const older = await this.requestHistory(anchor, opts.limit);
        const sameChat = (m: WAMessage) =>
            m.key?.remoteJid === anchor.remoteJid || toWaJid(m.key?.remoteJid) === chat.jid;
        for (const m of older) if (sameChat(m) && m.key?.id !== anchor.id) messages.push(m);

        messages.sort((a, b) => Session.sentAt(a).getTime() - Session.sentAt(b).getTime());
        for (const m of messages) this.keepFetched(m);

        const oldest = older.filter(sameChat).sort((a, b) => Session.sentAt(a).getTime() - Session.sentAt(b).getTime())[0];
        const next: HistoryAnchor | undefined = oldest?.key?.id
            ? {
                  id: oldest.key.id,
                  fromMe: !!oldest.key.fromMe,
                  participant: oldest.key.participant || undefined,
                  remoteJid: oldest.key.remoteJid || anchor.remoteJid,
                  at: Session.sentAt(oldest).getTime(),
              }
            : undefined;

        this.log.info({ chat: chat.isGroup ? chat.jid : "1:1", fetched: older.length, paged: !!opts.before }, "MCP chat read");
        return { chat, messages, next };
    }

    /** Names for the senders in a page of messages: our own label, contacts, push names, group roster. */
    async senderNames(chat: ChatDoc, messages: WAMessage[]): Promise<Map<string, { id: string; name?: string }>> {
        const out = new Map<string, { id: string; name?: string }>();
        const ids = new Set<string>();
        for (const m of messages) {
            if (m.key?.fromMe) continue;
            const raw = chat.isGroup ? m.key?.participant || m.participant : m.key?.remoteJid;
            if (raw) ids.add(raw);
        }
        for (const raw of ids) {
            const pn = isLidJid(raw) ? await this.quietPn(raw) : stripDevice(raw);
            const jid = pn || raw;
            const contact =
                (await this.stores.contacts.findOne({ _id: scopedId(this.id, digitsOf(jid)) })) ||
                (isLidJid(raw) ? await this.stores.contacts.findOne({ sessionId: this.id, lid: digitsOf(raw) }) : null);
            const pushed = messages.find((m) => (m.key?.participant || m.key?.remoteJid) === raw && m.pushName)?.pushName;
            out.set(raw, { id: Session.chatIdOf(contact?.jid || jid), name: Session.nameOf(contact) || pushed || undefined });
        }
        return out;
    }

    /**
     * Search a chat by paging its history from the phone and matching in
     * memory. Bounded by `scan` messages: the phone answers 50 at a time, a few
     * seconds each, so an unbounded search of a busy group would never end.
     */
    async searchChat(chatInput: string, query: string, opts: { scan: number; limit: number }) {
        this.assertMcp();
        const hits: WAMessage[] = [];
        let before: HistoryAnchor | undefined;
        let scanned = 0;
        let chat: ChatDoc | undefined;
        while (scanned < opts.scan && hits.length < opts.limit) {
            const page = await this.readChat(chatInput, { limit: 50, before });
            chat = page.chat;
            scanned += page.messages.length;
            for (const m of [...page.messages].reverse()) {
                const d = describeMessage(m.message);
                if (matchesQuery([d.text, d.filename].filter(Boolean).join(" "), query)) hits.push(m);
                if (hits.length >= opts.limit) break;
            }
            if (!page.next || !page.messages.length) {
                before = undefined;
                break;
            }
            before = page.next;
        }
        return { chat: chat!, hits, scanned, more: before };
    }

    /** Ask the phone for history older than `anchor`, and wait for its answer. One request at a time. */
    private requestHistory(anchor: HistoryAnchor, count: number): Promise<WAMessage[]> {
        const run = () =>
            new Promise<WAMessage[]>((resolve, reject) => {
                const sock = this.assertReady();
                const timer = setTimeout(() => {
                    this.pendingHistory = undefined;
                    reject(
                        new Error(
                            "your phone did not answer the history request within 30s — WhatsApp keeps no history " +
                                "on its servers, so reading a chat needs the phone online with WhatsApp reachable"
                        )
                    );
                }, 30_000);
                // Set before sending: the answer is let through by
                // `shouldSyncHistoryMessage` only while a request is pending.
                this.pendingHistory = {
                    resolve: (messages) => {
                        clearTimeout(timer);
                        this.pendingHistory = undefined;
                        resolve(messages);
                    },
                };
                sock.fetchMessageHistory(
                    Math.max(1, Math.min(50, count)),
                    { remoteJid: anchor.remoteJid, id: anchor.id, fromMe: anchor.fromMe, participant: anchor.participant },
                    anchor.at
                )
                    .then((requestId) => {
                        if (this.pendingHistory) this.pendingHistory.requestId = requestId;
                    })
                    .catch((e) => {
                        clearTimeout(timer);
                        this.pendingHistory = undefined;
                        reject(e);
                    });
            });
        const result = this.historyQueue.then(run, run);
        this.historyQueue = result.catch(() => {});
        return result;
    }

    private keepFetched(m: WAMessage) {
        if (!m.key?.id) return;
        this.fetched.delete(m.key.id);
        this.fetched.set(m.key.id, m);
        if (this.fetched.size > 2000) this.fetched.delete(this.fetched.keys().next().value!);
    }

    /** A message with its content: the in-memory fetch cache, else the week-long key store. */
    private async messageWithBody(id: string): Promise<WAMessage | null> {
        const hot = this.fetched.get(id);
        if (hot) return hot;
        const doc = await this.stores.messageKeys.findOne({ _id: scopedId(this.id, id) }).catch(() => null);
        if (!doc?.message) return null;
        try {
            return {
                key: { id: doc.messageId, remoteJid: doc.remoteJid, fromMe: doc.fromMe, participant: doc.participant },
                message: proto.Message.decode(Buffer.from(doc.message, "base64")),
                messageTimestamp: Math.floor(doc.createdAt.getTime() / 1000),
            } as WAMessage;
        } catch {
            return null;
        }
    }

    // --------------------------------------------------------------- MCP actions

    /** Mark a whole chat read: a read receipt for its newest message, and the phone's unread badge cleared. */
    async markChatRead(chatInput: string) {
        this.assertMcp();
        const sock = this.assertReady();
        const chat = await this.findChat(chatInput);
        if (!chat?.anchor) throw new Error(`no message seen in "${chatInput}" to mark read`);
        const a = chat.anchor;
        const key = { remoteJid: a.remoteJid, id: a.id, fromMe: a.fromMe, participant: a.participant };
        if (!a.fromMe) await sock.readMessages([key]);
        // The receipt turns the sender's ticks blue; this is what clears the
        // unread badge on the phone and every other linked device.
        await sock
            .chatModify({ markRead: true, lastMessages: [{ key, messageTimestamp: Math.floor(a.at / 1000) }] }, a.remoteJid)
            .catch((e) => this.log.warn({ e }, "read receipt sent, but clearing the unread badge failed"));
        await this.stores.chats.updateOne({ _id: chat._id }, { $set: { unreadCount: 0 } });
    }

    async editMessage(messageId: string, text: string): Promise<void> {
        const sock = this.assertReady();
        const key = await this.recallKey(messageId);
        if (!key) throw new Error(`unknown message id: ${messageId}`);
        if (!key.fromMe) throw new Error("only your own messages can be edited");
        await sock.sendMessage(key.remoteJid, { text, edit: key as any });
        this.log.info({ id: messageId }, "message edited");
    }

    async deleteMessage(messageId: string): Promise<void> {
        const sock = this.assertReady();
        const key = await this.recallKey(messageId);
        if (!key) throw new Error(`unknown message id: ${messageId}`);
        if (!key.fromMe) throw new Error("only your own messages can be deleted for everyone");
        await sock.sendMessage(key.remoteJid, { delete: key as any });
        this.log.info({ id: messageId }, "message deleted for everyone");
    }

    async checkNumbers(numbers: string[]) {
        const sock = this.assertReady();
        const digits = numbers.map((n) => String(n).replace(/\D/g, "")).filter(Boolean);
        const found = (await sock.onWhatsApp(...digits)) || [];
        return digits.map((d) => {
            const hit = found.find((f) => digitsOf(f.jid) === d);
            return { phone: d, on_whatsapp: !!hit?.exists };
        });
    }

    /**
     * A message's media, downloaded from WhatsApp now and returned, not stored.
     * Capped: this goes back to a model as base64, and a 100 MB video is not
     * something it can use.
     */
    async mediaOf(messageId: string): Promise<{ data: Buffer; mimetype: string; filename?: string; kind: string }> {
        const msg = await this.messageWithBody(messageId);
        if (!msg) throw new Error(`no media known for message ${messageId} — read the chat first, or it is over a week old`);
        const m = unwrap(msg.message);
        const node =
            (m?.imageMessage && { n: m.imageMessage, kind: "image" }) ||
            (m?.stickerMessage && { n: m.stickerMessage, kind: "sticker" }) ||
            (m?.videoMessage && { n: m.videoMessage, kind: "video" }) ||
            (m?.audioMessage && { n: m.audioMessage, kind: "audio" }) ||
            (m?.documentMessage && { n: m.documentMessage, kind: "document" });
        if (!node) throw new Error(`message ${messageId} has no media`);
        const size = Number((node.n as any).fileLength || 0);
        if (size > MAX_MCP_MEDIA_BYTES) {
            throw new Error(`that ${node.kind} is ${Math.round(size / 1e6)} MB — too large to return (limit ${MAX_MCP_MEDIA_BYTES / 1e6} MB)`);
        }
        const sock = this.assertReady();
        const data = (await downloadMediaMessage(msg, "buffer", {}, {
            logger: baileysLogger,
            reuploadRequest: sock.updateMediaMessage,
        })) as Buffer;
        this.log.info({ id: messageId, kind: node.kind, bytes: data.length }, "MCP media fetch");
        return {
            data,
            mimetype: (node.n as any).mimetype || "application/octet-stream",
            filename: (node.n as any).fileName || undefined,
            kind: node.kind,
        };
    }

    // -------------------------------------------------------------------- state

    /**
     * What is safe to serve without the management key.
     *
     * `/api/health` is public by necessity — Pironman's healthcheck and deploy
     * gate request it unauthenticated — so nothing here may be a credential.
     * That rules out the pairing code in particular: it is the QR in text form,
     * and anyone who reads one during a pairing window can link their own device
     * to the number.
     */
    describe() {
        return {
            id: this.id,
            status: this.status,
            connectedAt: this.connectedAt,
        };
    }

    /** The full picture, for the management console only. */
    describeForManagement() {
        return {
            ...this.describe(),
            token: this.token,
            // null rather than absent, so the console can tell "not set" from
            // "the API forgot to send it".
            webhookUrl: this.cfg.webhookUrl ?? null,
            phoneNumberId: this.cfg.phoneNumberId,
            pairPhone: this.cfg.pairPhone,
            sendRatePerMinute: this.cfg.sendRatePerMinute ?? null,
            rejectCalls: !!this.cfg.rejectCalls,
            typingEvents: !!this.cfg.typingEvents,
            mcpEnabled: this.mcpEnabled,
            me: this.me,
            lastError: this.lastError,
            pairingCode: this.pairingCode,
            qr: this.qr,
            lastMessage: this.lastMessage,
            lastSentAt: this.lastSentAt,
            messagesReceived: this.messagesReceived,
            webhookBacklog: this.webhook.pending,
            lastWebhookDeliveryAt: this.webhook.lastDeliveryAt,
            lastWebhookFailure: this.webhook.lastFailure,
            reconnectAttempts: this.reconnectAttempts,
        };
    }
}

/**
 * A document's type, so it opens as what it is (a PDF as a PDF): from its
 * data: URI, else from the file name, else a plain file.
 */
export function documentMime(media: string, filename?: string): string {
    const fromUri = /^data:([^;,]+)/.exec(media || "")?.[1];
    if (fromUri) return fromUri;
    const ext = String(filename || "").toLowerCase().split(".").pop() || "";
    const byExt: Record<string, string> = {
        pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        txt: "text/plain", csv: "text/csv", zip: "application/zip", ics: "text/calendar", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    };
    return byExt[ext] || "application/octet-stream";
}
