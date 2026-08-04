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
import {
    buildWhapiGroupEvent,
    buildWhapiMessage,
    buildWhapiPollUpdate,
    classify,
    unwrap,
} from "./map.js";
import { digitsOf, isGroupJid, isLidJid, toWaJid } from "./jid.js";

export type SessionStatus =
    | "starting"
    | "awaiting-pairing"
    | "connecting"
    | "connected"
    | "logged-out"
    | "conflict"
    | "stopped";

/** Simple token bucket. A floor under any bug that would otherwise spam a chat. */
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
    readonly token: string;

    private sock?: WASocket;
    private saveCreds: () => Promise<void> = async () => {};
    private clearAuth: () => Promise<void> = async () => {};
    private groupCache = new Map<string, { meta: GroupMetadata; at: number }>();
    private limiter: RateLimiter;
    private webhook: WebhookSender;
    private log;
    private reconnectAttempts = 0;
    private stopping = false;

    status: SessionStatus = "starting";
    /** Raw QR string, when one is pending. Rendered as an image by the admin page. */
    qr?: string;
    /** 8-character pairing code, when a pair phone is configured. */
    pairingCode?: string;
    me?: { id: string; name?: string };
    lastError?: string;
    connectedAt?: Date;

    constructor(
        private cfg: SessionConfig,
        private stores: Stores,
        private media: MediaStore
    ) {
        this.id = cfg.id;
        this.token = cfg.token;
        this.log = logger.child({ session: cfg.id });
        this.limiter = new RateLimiter(cfg.sendRatePerMinute ?? config.sendRatePerMinute);
        this.webhook = new WebhookSender(cfg.webhookUrl, cfg.token, cfg.id);
    }

    // ---------------------------------------------------------------- lifecycle

    async start(): Promise<void> {
        this.stopping = false;
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
            // The bots never read history; syncing it just burns Pi memory and
            // Mongo writes on every reconnect, multiplied by the session count.
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            cachedGroupMetadata: async (jid: string) => this.groupCache.get(jid)?.meta,
            getMessage: async (key: proto.IMessageKey) => this.lookupMessage(key),
        } as any);

        // Never swallow a credentials write failure. If this stops working the
        // session dies at the next restart, and a silent failure means finding
        // that out days later with no idea why.
        this.sock.ev.on("creds.update", () => {
            void this.saveCreds().catch((e) =>
                this.log.error({ e }, "FAILED TO PERSIST CREDENTIALS — session will not survive a restart")
            );
        });
        this.sock.ev.on("connection.update", (u) => void this.onConnectionUpdate(u));
        this.sock.ev.on("messages.upsert", (u) => void this.onMessages(u));
        this.sock.ev.on("messages.update", (u) => void this.onMessageUpdates(u));
        this.sock.ev.on("groups.upsert", (g) => void this.onGroups(g));
        this.sock.ev.on("groups.update", (g) => void this.onGroupsUpdate(g));
        this.sock.ev.on("group-participants.update", (u) => void this.onParticipants(u));
        this.sock.ev.on("contacts.update", (c) => void this.onContacts(c));
    }

    private async onConnectionUpdate(u: Partial<import("baileys").ConnectionState>) {
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
                if (!this.stopping) {
                    void this.start().catch((e) => this.log.error({ e }, "restart failed"));
                }
            }, delay);
        }
    }

    async stop() {
        this.stopping = true;
        try {
            this.sock?.end(undefined);
        } catch {}
        this.status = "stopped";
    }

    /** Wipe this session's credentials so the next start pairs fresh. */
    async logout() {
        try {
            await this.sock?.logout();
        } catch (e) {
            this.log.warn({ e }, "logout call failed; clearing local state anyway");
        }
        await this.clearAuth();
        this.status = "logged-out";
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
    private async resolveToPn(jid: string | undefined | null): Promise<string> {
        const j = String(jid ?? "");
        if (!j || isGroupJid(j)) return j;
        if (!isLidJid(j)) return j;
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

    private async handleMessage(msg: WAMessage) {
        if (!msg.key?.remoteJid) return;
        if (msg.key.remoteJid === "status@broadcast") return;
        // The bots filter `from_me` themselves, but sending our own messages back
        // would double every interaction log. Drop them here.
        if (msg.key.fromMe) return;

        const cls = classify(msg.message);
        if (cls.kind === "skip") {
            this.log.debug(
                { id: msg.key.id, keys: Object.keys(unwrap(msg.message) || {}) },
                "unsupported message type, skipped"
            );
            return;
        }

        const chatJid = await this.resolveToPn(msg.key.remoteJid);
        const isGroup = isGroupJid(msg.key.remoteJid);
        const senderJid = isGroup
            ? await this.resolveToPn(msg.key.participant || msg.participant)
            : chatJid;

        // Remember the key so whapi-style "act on this id" calls (mark read, react)
        // can reconstruct it later — whapi's API only passes the bare id.
        await this.rememberKey(msg);

        let chatName: string | undefined;
        if (isGroup) {
            const meta = await this.getGroupMetadata(msg.key.remoteJid).catch(() => undefined);
            chatName = meta?.subject;
        }

        const media = cls.mediaKind
            ? await this.media.save(msg, cls.mediaKind, this.sock!, this.id)
            : undefined;

        const payload = buildWhapiMessage(
            msg,
            cls,
            { chatJid, senderJid, chatName, senderName: msg.pushName || undefined },
            media
        );
        if (!payload) return;

        await this.webhook.send({ messages: [payload] });
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

                await this.webhook.send({
                    messages_updates: [
                        buildWhapiPollUpdate(u.key.id, stored.remoteJid, stored.name, resolved),
                    ],
                });
            } catch (e) {
                this.log.error({ e, id: u.key?.id }, "poll update handling failed");
            }
        }
    }

    private async onGroups(groups: GroupMetadata[]) {
        for (const g of groups) await this.emitGroupEvent(g.id, g);
    }

    private async onGroupsUpdate(groups: Partial<GroupMetadata>[]) {
        for (const g of groups) {
            if (!g.id) continue;
            this.groupCache.delete(g.id);
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
            await this.webhook.send({
                groups: [buildWhapiGroupEvent(jid, meta.subject, participants)],
            });
        } catch (e) {
            this.log.error({ e, jid }, "failed to emit group event");
        }
    }

    private async onContacts(contacts: Array<Partial<import("baileys").Contact>>) {
        const payload = [];
        for (const c of contacts) {
            const name = c.name || c.notify;
            if (!c.id || !name) continue;
            const jid = await this.resolveToPn(c.id);
            payload.push({ id: digitsOf(jid), name });
        }
        if (payload.length) await this.webhook.send({ contacts: payload });
    }

    // ----------------------------------------------------------------- outbound

    private assertReady(): WASocket {
        if (!this.sock || this.status !== "connected") {
            throw new Error(`session "${this.id}" not connected (status: ${this.status})`);
        }
        return this.sock;
    }

    private guardRate() {
        if (!this.limiter.tryTake()) {
            throw new Error(`send rate limit exceeded for session "${this.id}"`);
        }
    }

    async sendText(to: string, body: string): Promise<{ id?: string }> {
        const sock = this.assertReady();
        this.guardRate();
        const jid = toWaJid(to);
        if (!jid) throw new Error(`unroutable recipient: ${to}`);
        const sent = await sock.sendMessage(jid, { text: body });
        if (sent) await this.rememberKey(sent);
        return { id: sent?.key?.id || undefined };
    }

    async sendImage(to: string, media: string, caption?: string): Promise<{ id?: string }> {
        const sock = this.assertReady();
        this.guardRate();
        const jid = toWaJid(to);
        if (!jid) throw new Error(`unroutable recipient: ${to}`);

        // The bots send a data: URI, an http(s) URL, or raw base64 (gepetel's
        // sendWhatsAppImage wraps bare base64 into a data URI before calling).
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

        const sock = this.assertReady();
        const meta = await sock.groupMetadata(jid);
        this.groupCache.set(jid, { meta, at: Date.now() });
        return meta;
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
     * whapi's message APIs take a bare id (`PUT /messages/{id}`), but Baileys needs
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

    describe() {
        return {
            id: this.id,
            status: this.status,
            me: this.me,
            connectedAt: this.connectedAt,
            lastError: this.lastError,
            pairingCode: this.pairingCode,
            hasQr: !!this.qr,
            webhookUrl: this.cfg.webhookUrl,
            webhookBacklog: this.webhook.pending,
            reconnectAttempts: this.reconnectAttempts,
        };
    }
}
