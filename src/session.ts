import makeWASocket, {
    DisconnectReason,
    getAggregateVotesInPollMessage,
    makeCacheableSignalKeyStore,
    proto,
    type GroupMetadata,
    type WAMessage,
    type WASocket,
} from "baileys";
import { Boom } from "@hapi/boom";
import { config, type SessionConfig } from "./config.js";
import { logger, baileysLogger } from "./log.js";
import { scopedId, type Stores } from "./store.js";
import { useMongoAuthState } from "./authState.js";
import { MediaStore } from "./media.js";
import { WebhookSender } from "./webhook.js";
import { classify, unwrap } from "./map.js";
import {
    buildCloudContactsEvent,
    buildCloudGroupEvent,
    buildCloudMessageEvent,
    buildCloudPollEvent,
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
            shouldSyncHistoryMessage: (msg: proto.Message.IHistorySyncNotification) =>
                HISTORY_TYPES_WORTH_SYNCING.has(msg.syncType as number),
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
        this.sock.ev.on("messages.update", (u) => {
            if (current()) void this.onMessageUpdates(u);
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
            if (current()) void this.onContacts(c);
        });
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
        const senderJid = isGroup
            ? await this.resolveToPn(key.participant || msg.participant, key.participantAlt)
            : chatJid;

        // Remember the key so "act on this id" calls (mark read, react) can
        // reconstruct it later — the API only ever passes the bare id.
        await this.rememberKey(msg);

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

        const media = cls.mediaKind
            ? await this.media.save(msg, cls.mediaKind, this.sock!, this.id)
            : undefined;

        this.noteInbound({
            at: Session.sentAt(msg),
            from: toUserId(senderJid),
            fromName: msg.pushName || undefined,
            chatName,
            isGroup,
        });

        const ids = { chatJid, senderJid, chatName, senderName: msg.pushName || undefined };
        const event = buildCloudMessageEvent(msg, cls, ids, this.cloudMeta(), media);
        if (event) await this.webhook.send(event);
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

    private async onMessageUpdates(
        updates: Array<{ key: proto.IMessageKey; update: Partial<WAMessage> }>
    ) {
        for (const u of updates) {
            try {
                const pollUpdates = (u.update as any)?.pollUpdates;
                if (!pollUpdates?.length || !u.key?.id) continue;

                const stored = await this.stores.polls.findOne({ _id: scopedId(this.id, u.key.id) });
                if (!stored) continue; // not a poll this session created

                const creation = proto.Message.decode(Buffer.from(stored.message, "base64"));
                const votes = getAggregateVotesInPollMessage(
                    { message: creation, pollUpdates },
                    this.sock?.user?.id
                );

                // Voter jids come back as LIDs in newer groups; resolve before the
                // bot tries to match them against its phone-keyed People records.
                const resolved = await Promise.all(
                    votes.map(async (v) => ({
                        name: v.name,
                        voters: await Promise.all(v.voters.map((x) => this.resolveToPn(x))),
                    }))
                );

                await this.webhook.send(
                    buildCloudPollEvent(
                        u.key.id,
                        stored.remoteJid,
                        stored.name,
                        resolved,
                        this.cloudMeta()
                    )
                );
            } catch (e) {
                this.log.error({ e, id: u.key?.id }, "poll update handling failed");
            }
        }
    }

    private async onGroups(groups: GroupMetadata[]) {
        // Free metadata — this event already carries everything a fetch would
        // return, so caching it here spares a rate-limited round trip later.
        for (const g of groups) this.cacheGroup(g);
        for (const g of groups) await this.emitGroupEvent(g.id, g);
    }

    private async onGroupsUpdate(groups: Partial<GroupMetadata>[]) {
        for (const g of groups) {
            if (!g.id) continue;
            // An update carries only the changed fields. If the subject is one
            // of them, that IS the fresh value — keep it rather than dropping
            // the entry and hoping the refetch succeeds.
            if (g.subject) this.cacheGroup({ ...this.groupCache.get(g.id)?.meta, ...g });
            else this.groupCache.delete(g.id);
            await this.emitGroupEvent(g.id);
        }
    }

    private async onParticipants(u: { id: string; participants: any[]; action: string }) {
        this.groupCache.delete(u.id);
        await this.emitGroupEvent(u.id);
    }

    /**
     * The bots' `groups[]` handler re-fetches the authoritative roster via
     * GET /groups/:id anyway, so this event only needs to carry enough for them to
     * identify the group and decide whether to greet.
     */
    private async emitGroupEvent(jid: string, known?: GroupMetadata) {
        try {
            const meta = known || (await this.getGroupMetadata(jid));
            const participants = await this.groupParticipantIds(meta);
            await this.webhook.send(
                buildCloudGroupEvent(jid, meta.subject, participants, this.cloudMeta())
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
                const sent = await this.sendText(req.to, k.body);
                return { messageId: sent.id, waId };
            }
            case "image": {
                const sent = await this.sendImage(req.to, k.media, k.caption);
                return { messageId: sent.id, waId };
            }
            case "reaction": {
                await this.react(k.messageId, k.emoji);
                return { messageId: k.messageId, waId };
            }
            case "audio":
            case "video":
            case "document":
            case "sticker":
            case "location": {
                const sent = await this.sendCloudMedia(jid, k);
                return { messageId: sent.id, waId };
            }
        }
    }

    /** The media and location kinds with no per-verb route of their own. */
    private async sendCloudMedia(
        jid: string,
        k: Extract<CloudSendKind, { type: "audio" | "video" | "document" | "sticker" | "location" }>
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
            else content = { document: media, caption: k.caption, fileName: k.filename || "file" };
        }

        const sent = await sock.sendMessage(jid, content as any);
        this.lastSentAt = new Date();
        if (sent) await this.rememberKey(sent);
        return { id: sent?.key?.id || undefined };
    }

    async sendText(to: string, body: string): Promise<{ id?: string }> {
        const sock = this.assertReady();
        this.guardRate();
        const jid = toWaJid(to);
        if (!jid) throw new Error(`unroutable recipient: ${to}`);
        const sent = await sock.sendMessage(jid, { text: body });
        this.lastSentAt = new Date();
        if (sent) await this.rememberKey(sent);
        return { id: sent?.key?.id || undefined };
    }

    async sendImage(to: string, media: string, caption?: string): Promise<{ id?: string }> {
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

        const sent = await sock.sendMessage(jid, { image, caption: caption || undefined } as any);
        if (sent) await this.rememberKey(sent);
        return { id: sent?.key?.id || undefined };
    }

    async sendPoll(
        to: string,
        name: string,
        options: string[],
        allowMultiple: boolean
    ): Promise<{ id?: string }> {
        const sock = this.assertReady();
        this.guardRate();
        const jid = toWaJid(to);
        if (!jid) throw new Error(`unroutable recipient: ${to}`);

        const sent = await sock.sendMessage(jid, {
            poll: {
                name,
                values: options,
                // WhatsApp encodes "multi-select" as a selectableCount of 0.
                selectableCount: allowMultiple ? 0 : 1,
            },
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
    async groupParticipantIds(meta: GroupMetadata): Promise<Array<{ id: string; name?: string }>> {
        return Promise.all(
            (meta.participants || []).map(async (p) => ({
                id: p.phoneNumber || (await this.resolveToPn(p.id)),
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
    private async rememberKey(msg: WAMessage) {
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
        if (!doc) return null;
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
        const poll = await this.stores.polls
            .findOne({ _id: scopedId(this.id, key.id) })
            .catch(() => null);
        if (poll) return proto.Message.decode(Buffer.from(poll.message, "base64"));
        return undefined;
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
