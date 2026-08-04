import { MongoClient, type Collection, type Db } from "mongodb";
import { config } from "./config.js";
import { logger } from "./log.js";

/**
 * Every collection below is namespaced by `sessionId`, so numbers sharing this
 * instance never see each other's state. Auth documents encode the session in
 * their `_id` (they're looked up by exact key); the rest carry an indexed field.
 */

/**
 * A configured WhatsApp number. This is the record the management console
 * creates, and it is the reason the gateway no longer needs a redeploy to host
 * another number.
 *
 * `_id` is the session id, which namespaces every other collection's documents —
 * so a session's config and its state are keyed the same way, and deleting one
 * tells you exactly what to purge.
 */
export interface SessionDoc {
    _id: string;
    /** Bearer token the owning bot sends. Unique across sessions. */
    token: string;
    /** Absent until configured; inbound events are discarded until then. */
    webhookUrl?: string;
    pairPhone?: string;
    sendRatePerMinute?: number;
    /**
     * Last inbound message seen, persisted so a redeploy doesn't reset the
     * console's "is this working?" line to "never". Written at most once a
     * minute — it is a display marker, not an audit log.
     */
    lastMessage?: {
        at: Date;
        from: string;
        fromName?: string;
        chatName?: string;
        isGroup: boolean;
    };
    createdAt: Date;
    updatedAt: Date;
}

/** id -> the full WAMessageKey, so whapi-style "act on this message id" calls work. */
export interface MessageKeyDoc {
    /** `${sessionId}:${messageId}` — message ids are only unique within a session. */
    _id: string;
    sessionId: string;
    messageId: string;
    remoteJid: string;
    fromMe: boolean;
    participant?: string;
    createdAt: Date;
}

/** Poll creation messages, kept so vote updates can be decrypted and aggregated. */
export interface PollDoc {
    _id: string;
    sessionId: string;
    messageId: string;
    remoteJid: string;
    /** base64 of the encoded proto.Message for the poll creation message */
    message: string;
    name: string;
    options: string[];
    createdAt: Date;
}

/** Downloaded media, served back over HTTP so the bots can fetch it. */
export interface MediaDoc {
    _id: string;
    sessionId: string;
    path: string;
    mimetype: string;
    createdAt: Date;
}

export interface Stores {
    db: Db;
    sessions: Collection<SessionDoc>;
    authCreds: Collection<{ _id: string; value: string }>;
    authKeys: Collection<{ _id: string; value: string }>;
    messageKeys: Collection<MessageKeyDoc>;
    polls: Collection<PollDoc>;
    media: Collection<MediaDoc>;
    close: () => Promise<void>;
}

export async function connectStores(): Promise<Stores> {
    const client = new MongoClient(config.mongoUrl);
    await client.connect();
    // No argument means "the database named in the connection string", which is
    // the one a managed provider's credentials are actually scoped to.
    const db = client.db(config.mongoDb || undefined);

    const sessions = db.collection<SessionDoc>("sessions");
    const authCreds = db.collection<{ _id: string; value: string }>("auth_creds");
    const authKeys = db.collection<{ _id: string; value: string }>("auth_keys");
    const messageKeys = db.collection<MessageKeyDoc>("message_keys");
    const polls = db.collection<PollDoc>("polls");
    const media = db.collection<MediaDoc>("media");

    const index = (p: Promise<unknown>, what: string) =>
        p.catch((e) => logger.warn({ e }, `index: ${what}`));

    // Not tolerant like the others: two sessions sharing a token makes routing
    // ambiguous, so one bot would silently drive the wrong WhatsApp number. The
    // API checks for it too, but only the index makes it impossible, so failing
    // to build it is a refusal to start rather than a warning.
    try {
        await sessions.createIndex({ token: 1 }, { unique: true });
    } catch (e) {
        throw new Error(
            `could not create the unique index on sessions.token in database "${db.databaseName}" — ` +
                `the gateway will not run without it. A managed database's user is usually authorised ` +
                `for only the database named in its connection string, so check WA_MONGO_DB. Cause: ${
                    e instanceof Error ? e.message : String(e)
                }`
        );
    }

    // Message keys only need to outlive the window in which a bot might react to
    // or mark-as-read a message. A week is generous.
    await index(
        messageKeys.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 }),
        "message_keys TTL"
    );
    await index(messageKeys.createIndex({ sessionId: 1 }), "message_keys sessionId");
    // Polls live longer — tallies accrue over days.
    await index(polls.createIndex({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 }), "polls TTL");
    await index(polls.createIndex({ sessionId: 1 }), "polls sessionId");
    await index(
        media.createIndex({ createdAt: 1 }, { expireAfterSeconds: config.mediaTtlHours * 3600 }),
        "media TTL"
    );
    await index(media.createIndex({ sessionId: 1 }), "media sessionId");

    logger.info({ db: db.databaseName }, "mongo connected");

    return {
        db,
        sessions,
        authCreds,
        authKeys,
        messageKeys,
        polls,
        media,
        close: () => client.close(),
    };
}

/** Namespaced document key. Session ids are validated to exclude ":" at config time. */
export const scopedId = (sessionId: string, key: string) => `${sessionId}:${key}`;
