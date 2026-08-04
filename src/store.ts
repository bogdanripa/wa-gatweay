import { MongoClient, type Collection, type Db } from "mongodb";
import { config } from "./config.js";
import { logger } from "./log.js";

/**
 * Every collection below is namespaced by `sessionId`, so numbers sharing this
 * instance never see each other's state. Auth documents encode the session in
 * their `_id` (they're looked up by exact key); the rest carry an indexed field.
 */

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
    const db = client.db(config.mongoDb);

    const authCreds = db.collection<{ _id: string; value: string }>("auth_creds");
    const authKeys = db.collection<{ _id: string; value: string }>("auth_keys");
    const messageKeys = db.collection<MessageKeyDoc>("message_keys");
    const polls = db.collection<PollDoc>("polls");
    const media = db.collection<MediaDoc>("media");

    const index = (p: Promise<unknown>, what: string) =>
        p.catch((e) => logger.warn({ e }, `index: ${what}`));

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

    logger.info({ db: config.mongoDb, sessions: config.sessions.length }, "mongo connected");

    return {
        db,
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
