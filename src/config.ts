function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var ${name}`);
    return v;
}

function optional(name: string, fallback: string): string {
    return process.env[name] || fallback;
}

/**
 * One WhatsApp number. The gateway hosts several, exactly like a whapi account
 * holds several channels — and, as with whapi, the bearer token is what selects
 * which one a request is for. That's why gepetel needs no change to work in a
 * multi-number deployment: it already sends a token, it just gets its own.
 */
export interface SessionConfig {
    /** Stable identifier. Used to namespace all stored state — never change it. */
    id: string;
    /** Bearer token. Set the matching bot's WHAPI_TOKEN to this value. */
    token: string;
    /** Where this number's inbound events go — its own bot's /whapi endpoint. */
    webhookUrl: string;
    /** Optional: pair with an 8-char code instead of a QR. Digits only. */
    pairPhone?: string;
    /** Optional per-session override of the global send rate cap. */
    sendRatePerMinute?: number;
}

/**
 * Sessions are declared with indexed env vars rather than one JSON blob, so each
 * token is its own variable — you can rotate one number's credentials with a
 * single `apps_env_set` instead of rewriting a JSON string containing every
 * other number's secrets.
 *
 *   WA_SESSION_1_ID=gepetel
 *   WA_SESSION_1_TOKEN=...
 *   WA_SESSION_1_WEBHOOK_URL=https://.../whapi
 *   WA_SESSION_1_PAIR_PHONE=40750271099        # optional
 *   WA_SESSION_1_SEND_RATE_PER_MINUTE=20       # optional
 *
 *   WA_SESSION_2_ID=other-bot
 *   ...
 *
 * Indices need not be contiguous; anything up to 64 is scanned.
 */
function parseSessions(): SessionConfig[] {
    const sessions: SessionConfig[] = [];

    for (let i = 1; i <= 64; i++) {
        const id = process.env[`WA_SESSION_${i}_ID`];
        if (!id) continue;

        const token = process.env[`WA_SESSION_${i}_TOKEN`];
        const webhookUrl = process.env[`WA_SESSION_${i}_WEBHOOK_URL`];
        if (!token) throw new Error(`WA_SESSION_${i}_TOKEN is required (session "${id}")`);
        if (!webhookUrl) throw new Error(`WA_SESSION_${i}_WEBHOOK_URL is required (session "${id}")`);

        // The id namespaces Mongo document ids and appears in URLs, so keep it to
        // characters that can't produce ambiguous keys or need escaping.
        if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id)) {
            throw new Error(
                `WA_SESSION_${i}_ID "${id}" is invalid: use 1-32 chars of [a-z0-9_-], starting alphanumeric`
            );
        }

        const rate = process.env[`WA_SESSION_${i}_SEND_RATE_PER_MINUTE`];

        sessions.push({
            id,
            token,
            webhookUrl,
            pairPhone: (process.env[`WA_SESSION_${i}_PAIR_PHONE`] || "").replace(/\D/g, "") || undefined,
            sendRatePerMinute: rate ? parseInt(rate, 10) : undefined,
        });
    }

    if (!sessions.length) {
        throw new Error(
            "No sessions configured. Set at least WA_SESSION_1_ID, WA_SESSION_1_TOKEN and WA_SESSION_1_WEBHOOK_URL."
        );
    }

    // Duplicate ids would silently share auth state — two numbers fighting over
    // one device slot, which ends in both being logged out. Duplicate tokens would
    // make routing ambiguous. Both are worth refusing to start over.
    const ids = new Set<string>();
    const tokens = new Set<string>();
    for (const s of sessions) {
        const lower = s.id.toLowerCase();
        if (ids.has(lower)) throw new Error(`Duplicate session id "${s.id}"`);
        if (tokens.has(s.token)) throw new Error(`Duplicate session token (session "${s.id}")`);
        ids.add(lower);
        tokens.add(s.token);
    }

    return sessions;
}

export const config = {
    /** Mongo connection string. All sessions share it; state is namespaced by id. */
    mongoUrl: required("WA_MONGO_URL"),
    mongoDb: optional("WA_MONGO_DB", "wa_gateway"),

    /** One entry per WhatsApp number. */
    sessions: parseSessions(),

    /**
     * This gateway's public HTTPS base URL, no trailing slash. Media links handed
     * to the bots are built from it, and they fetch those links server-side.
     * On Pironman: https://<app-id>-coolify.bogdanripa.com
     */
    publicUrl: required("WA_PUBLIC_URL").replace(/\/+$/, ""),

    /** Password for the /admin pairing page (username is ignored). */
    adminPassword: required("WA_ADMIN_PASSWORD"),

    port: parseInt(optional("PORT", "8080"), 10),

    /** How long downloaded media stays fetchable before cleanup. */
    mediaTtlHours: parseInt(optional("WA_MEDIA_TTL_HOURS", "48"), 10),
    mediaDir: optional("WA_MEDIA_DIR", "/tmp/wa-media"),

    /** Default outbound cap per session, per minute. Overridable per session. */
    sendRatePerMinute: parseInt(optional("WA_SEND_RATE_PER_MINUTE", "20"), 10),

    logLevel: optional("WA_LOG_LEVEL", "info"),
};

export type Config = typeof config;
