import { config } from "./config.js";
import { logger } from "./log.js";
import type { Stores } from "./store.js";
import type { MediaStore } from "./media.js";
import { Session } from "./session.js";

/**
 * Owns every configured number and routes requests to the right one.
 *
 * Routing is by bearer token, exactly as whapi does it: each channel has its own
 * token, and the token is what identifies the channel. That's what makes this
 * transparent to the bots — gepetel already sends `Authorization: Bearer …`, so
 * pointing a second bot at a second number is a config change on both sides and
 * no code change on either.
 */
export class SessionManager {
    private byId = new Map<string, Session>();
    private byToken = new Map<string, Session>();

    constructor(stores: Stores, media: MediaStore) {
        for (const cfg of config.sessions) {
            const session = new Session(cfg, stores, media);
            this.byId.set(cfg.id.toLowerCase(), session);
            this.byToken.set(cfg.token, session);
        }
    }

    /**
     * Start every session. Failures are isolated deliberately: one number with a
     * corrupt auth document must not stop the others from coming up. A dead
     * session shows as such on /admin and /health.
     */
    async startAll() {
        await Promise.all(
            this.all().map(async (s) => {
                try {
                    await s.start();
                } catch (e) {
                    logger.error({ e, session: s.id }, "session failed to start; others continue");
                }
            })
        );
        logger.info({ sessions: this.all().map((s) => s.id) }, "sessions started");
    }

    async stopAll() {
        await Promise.all(this.all().map((s) => s.stop().catch(() => {})));
    }

    all(): Session[] {
        return [...this.byId.values()];
    }

    byTokenOrNull(token: string): Session | null {
        return this.byToken.get(token) ?? null;
    }

    byIdOrNull(id: string): Session | null {
        return this.byId.get(String(id ?? "").toLowerCase()) ?? null;
    }

    /**
     * Aggregate health. Green only when every number can actually send — a
     * partially-down gateway that reports 200 is how a number sits unpaired for a
     * week without anyone noticing.
     */
    health() {
        const sessions = this.all().map((s) => s.describe());
        const connected = sessions.filter((s) => s.status === "connected").length;
        return {
            ok: connected === sessions.length && sessions.length > 0,
            connected,
            total: sessions.length,
            sessions,
        };
    }
}
