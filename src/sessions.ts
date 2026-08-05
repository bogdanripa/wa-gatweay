import { config } from "./config.js";
import { logger } from "./log.js";
import type { SessionDoc, Stores } from "./store.js";
import type { MediaStore } from "./media.js";
import { Session } from "./session.js";
import {
    NotFoundError,
    SessionStore,
    purgeSessionState,
    toSessionConfig,
    type CreateSessionInput,
    type UpdateSessionInput,
} from "./sessionStore.js";

/**
 * Owns every configured number and routes requests to the right one.
 *
 * Routing is by bearer token, as the hosted APIs do it: each number has its own
 * token, and the token is what identifies the channel. That's what makes this
 * transparent to the bots — they already send `Authorization: Bearer …`, so
 * pointing a second bot at a second number is a config change on both sides and
 * no code change on either.
 *
 * The set of numbers is now mutable at runtime, because the management console
 * edits it. Mongo is the source of truth and these maps are a cache of it, so
 * every mutation writes first and only then touches the maps — a failed write
 * must not leave a session running that no longer exists on disk.
 */
export class SessionManager {
    private byId = new Map<string, Session>();
    private byToken = new Map<string, Session>();
    readonly store: SessionStore;

    constructor(
        private stores: Stores,
        private media: MediaStore
    ) {
        this.store = new SessionStore(stores);
    }

    /**
     * Bring up every number already in Mongo. Failures are isolated
     * deliberately: one number with a corrupt auth document must not stop the
     * others from coming up. A dead session shows as such in the console.
     *
     * Zero numbers is a perfectly good state — it is what a fresh deployment
     * looks like before anyone has opened the console.
     */
    async loadAll() {
        const docs = await this.store.all();
        for (const doc of docs) this.build(doc);
        await Promise.all(this.all().map((s) => this.startIsolated(s)));
        logger.info({ sessions: this.all().map((s) => s.id) }, "sessions loaded");
    }

    /** Rebuild a Session and restore the activity it had before a restart. */
    private build(doc: SessionDoc): Session {
        const session = new Session(toSessionConfig(doc), this.stores, this.media);
        session.lastMessage = doc.lastMessage;
        return this.track(session);
    }

    private track(session: Session): Session {
        this.byId.set(session.id, session);
        this.byToken.set(session.token, session);
        return session;
    }

    private async startIsolated(session: Session) {
        try {
            await session.start();
        } catch (e) {
            logger.error({ e, session: session.id }, "session failed to start; others continue");
        }
    }

    // ------------------------------------------------------------- mutations

    /** Add a number and bring it straight up, so a QR is waiting by the time the console refreshes. */
    async create(input: CreateSessionInput): Promise<SessionDoc> {
        const doc = await this.store.create(input);
        const session = this.build(doc);
        await this.startIsolated(session);
        logger.info({ session: doc._id }, "number added");
        return doc;
    }

    async update(id: string, patch: UpdateSessionInput): Promise<SessionDoc> {
        const doc = await this.store.update(id, patch);
        this.byId.get(id)?.applyConfig(toSessionConfig(doc));
        return doc;
    }

    async rotateToken(id: string): Promise<SessionDoc> {
        const session = this.byId.get(id);
        const doc = await this.store.rotateToken(id);
        if (session) {
            // Drop the old key first — `session.token` is about to change, and
            // then nothing would remember which entry to remove. A stale entry
            // means the revoked token keeps working.
            this.byToken.delete(session.token);
            session.applyConfig(toSessionConfig(doc));
            this.byToken.set(doc.token, session);
        }
        logger.warn({ session: id }, "token rotated — the bot's token must be updated");
        return doc;
    }

    /** Unlink from WhatsApp and show a fresh QR, keeping the number configured. */
    async relink(id: string): Promise<void> {
        const session = this.requireSession(id);
        await session.relink();
    }

    /** Bounce the socket without touching credentials. */
    async restart(id: string): Promise<void> {
        const session = this.requireSession(id);
        await session.restart();
    }

    /**
     * Remove a number entirely: unlink the device, forget the config, and purge
     * everything keyed to its id.
     *
     * Order matters. The config row goes last, so a crash midway leaves a
     * configured session with wiped state — which re-pairs — rather than an
     * unreferenced pile of credentials nothing will ever clean up.
     */
    async remove(id: string): Promise<void> {
        const session = this.byId.get(id);
        // Checked against the store as well as the live map: a session that
        // failed to start is configured but not tracked, and deleting it has to
        // work — that is exactly when you want to.
        if (!session && !(await this.store.get(id))) {
            throw new NotFoundError(`no number with id "${id}"`);
        }
        if (session) {
            await session.unlink().catch((e) => logger.warn({ e, session: id }, "unlink during delete failed"));
            this.byToken.delete(session.token);
            this.byId.delete(id);
        }
        await purgeSessionState(this.stores, id);
        await this.store.remove(id);
        logger.warn({ session: id }, "number removed");
    }

    private requireSession(id: string): Session {
        const session = this.byId.get(id);
        if (!session) throw new NotFoundError(`no number with id "${id}"`);
        return session;
    }

    async stopAll() {
        await Promise.all(this.all().map((s) => s.stop().catch(() => {})));
    }

    // ---------------------------------------------------------------- reads

    all(): Session[] {
        return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    }

    byTokenOrNull(token: string): Session | null {
        return this.byToken.get(token) ?? null;
    }

    byIdOrNull(id: string): Session | null {
        return this.byId.get(id) ?? null;
    }

    /**
     * Liveness, served unauthenticated. Counts only — see `Session.describe()`
     * for why nothing identifying belongs on a public endpoint.
     *
     * This is 200 whenever the process is up, including with zero numbers
     * configured, because Pironman gates deploys on it: a readiness check here
     * would mean a fresh deployment could never go healthy long enough for
     * anyone to add the first number. `ready()` is the strict one.
     */
    health() {
        const sessions = this.all();
        return {
            ok: true,
            configured: config.configured,
            connected: sessions.filter((s) => s.status === "connected").length,
            total: sessions.length,
        };
    }

    /**
     * Readiness: green only when every configured number can actually send. A
     * partially-down gateway reporting green is how a number sits unpaired for a
     * week without anyone noticing.
     */
    ready() {
        const sessions = this.all().map((s) => s.describe());
        const connected = sessions.filter((s) => s.status === "connected").length;
        return {
            ok: config.configured && sessions.length > 0 && connected === sessions.length,
            configured: config.configured,
            // Named rather than implied: "not ready" on a fresh install means
            // "nobody has set the env vars", and that should not read as a
            // WhatsApp problem.
            missingConfig: config.missingConfig.length ? config.missingConfig : undefined,
            connected,
            total: sessions.length,
            sessions,
        };
    }
}
