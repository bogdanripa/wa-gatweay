function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var ${name}`);
    return v;
}

function optional(name: string, fallback: string): string {
    return process.env[name] || fallback;
}

/**
 * Numbers come from the environment as strings, and a typo in one used to fail
 * open: `parseInt("twenty")` is NaN, and `NaN < 1` is false, which silently
 * disabled the send rate limiter — the one guard standing between a bug and a
 * WhatsApp ban. Refuse to start instead.
 */
function positiveInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`${name} must be a positive integer, got "${raw}"`);
    }
    return n;
}

/**
 * One WhatsApp number. The gateway hosts several, like a hosted account holds
 * several channels — and, as there, the bearer token is what selects which one
 * a request is for. That's why the bots need no change to work in a
 * multi-number deployment: they already send a token, they just get their own.
 *
 * These are no longer environment variables. They live in Mongo (see
 * `sessionStore.ts`) so numbers can be added and paired from the management
 * console without a redeploy — a redeploy replaces the container, and waiting
 * for one just to add a number was the whole reason this moved.
 */
export interface SessionConfig {
    /** Stable identifier. Used to namespace all stored state — never change it. */
    id: string;
    /** Bearer token the owning bot sends. */
    token: string;
    /**
     * Where this number's inbound events go. Absent until one is configured —
     * a number can be paired before anyone has decided where its events belong,
     * and events are discarded (not queued) in the meantime.
     */
    webhookUrl?: string;
    /** Optional: pair with an 8-char code instead of a QR. Digits only. */
    pairPhone?: string;
    /** Outbound cap per minute. Absent means no cap at all. */
    sendRatePerMinute?: number;
    /** Meta-style stable numeric id for this number. */
    phoneNumberId: string;
}

/**
 * Pironman proxies only `/api/*` to an app's container; every other path is
 * answered by the static bundle without the container ever seeing it. So the
 * whole HTTP surface — every endpoint included — lives under
 * this prefix, and the bots' base URL carries it.
 *
 * The contract is unchanged *relative to the base URL*: a client builds every
 * request as `${BASE_URL}/messages/text` and friends, so pointing that at
 * `https://…/api` is a config value, not a code change.
 */
export const API_PREFIX = "/api";

const publicUrl = optional("WA_PUBLIC_URL", "")
    .replace(/\/+$/, "")
    // Defensive: WA_PUBLIC_URL is the app root, and media links append the API
    // prefix themselves. Someone who sets it to the bots' base URL (which does
    // end in /api) would otherwise get /api/api/media/… links that 404 inside
    // OpenAI's fetcher, where the failure is invisible.
    .replace(/\/api$/, "");

/**
 * The management key, or null when the gateway has not been configured yet.
 *
 * Everything else in this file fails fast on bad input, and this used to as
 * well. It can't: the deployment platform will not accept environment variables
 * for an app that has never produced a running container, so a gateway that
 * refuses to boot without its key can never *be* given one. The first deploy of
 * any fresh install necessarily happens unconfigured.
 *
 * So "unconfigured" is a state rather than a crash — but a fail-closed one. With
 * no key the management API is switched off entirely (503 on every route), which
 * is strictly safer than any default value could be, `/api/ready` refuses to go
 * green, and startup says so loudly. What it does not do is crash-loop a
 * container nobody can configure.
 */
function managementKeyOrNull(): string | null {
    const key = process.env.WA_MANAGEMENT_KEY || "";
    if (!key) return null;
    if (key.length < 16) {
        // Short keys still throw. Once you're configuring the thing, a guessable
        // key is a mistake worth stopping for — this one adds WhatsApp numbers
        // and reads every bot's token, from the public internet.
        throw new Error(
            "WA_MANAGEMENT_KEY must be at least 16 characters — generate one with `openssl rand -base64 32`"
        );
    }
    return key;
}

const managementKey = managementKeyOrNull();

/**
 * Mongo connection string. All sessions share it; state is namespaced by id.
 *
 * Falls back to `DATABASE_URL`, which is what Pironman injects for an app's
 * attached database — and it recomposes that string on every deploy, because the
 * database container's hostname changes whenever the resource is rebuilt.
 * Copying it into `WA_MONGO_URL` once would work right up until it didn't.
 */
function mongoUrl(): string {
    const url = process.env.WA_MONGO_URL || process.env.DATABASE_URL;
    if (!url) throw new Error("Missing required env var WA_MONGO_URL (or DATABASE_URL)");
    return url;
}

export const config = {
    mongoUrl: mongoUrl(),

    /**
     * Database name, or empty to use whatever the connection string names.
     *
     * Empty is the right default. A managed database hands you a URL whose user
     * is authorised for exactly one database — the one in the URL's path — so a
     * hardcoded name here doesn't fail at connect time, which would at least be
     * obvious. It connects fine and then throws `Unauthorized` on the first
     * index build, which reads like a broken schema rather than a wrong name.
     */
    mongoDb: optional("WA_MONGO_DB", ""),

    /** This gateway's public HTTPS base URL — the app root, no trailing slash. */
    publicUrl,

    /** Base for the media links handed to the bots, which fetch them server-side. */
    mediaBaseUrl: `${publicUrl}${API_PREFIX}/media`,

    /** Secret for the management console, or null until one is set. */
    managementKey,

    /**
     * Whether this gateway has everything it needs to actually be used. False on
     * a fresh install between the first deploy and someone setting the env vars.
     */
    configured: !!managementKey && !!publicUrl,

    /** What's missing, for the startup log and `/api/ready`. */
    missingConfig: [
        managementKey ? null : "WA_MANAGEMENT_KEY",
        publicUrl ? null : "WA_PUBLIC_URL",
    ].filter((x): x is string => x !== null),

    port: positiveInt("PORT", 8080),

    /**
     * Bind address. `::` is dual-stack in Node, which is what the platform
     * needs: the container's healthcheck runs *inside* against localhost (IPv6
     * first), while the proxy connects from outside over IPv4. Binding only one
     * family fails in one of two ways — a refused healthcheck that rolls the
     * deploy back, or, worse, a container that reports healthy while every
     * proxied request 502s.
     *
     * Overridable because a literal `::` throws EAFNOSUPPORT on a dev box with
     * no IPv6.
     */
    host: optional("HOST", "::"),

    /** How long downloaded media stays fetchable before cleanup. */
    mediaTtlHours: positiveInt("WA_MEDIA_TTL_HOURS", 48),
    mediaDir: optional("WA_MEDIA_DIR", "/tmp/wa-media"),

    /**
     * Telegram bot credentials for connection alerts.
     *
     * Reads the unprefixed names first, because these are shared platform-wide
     * variables injected into every app on the box — one bot, every service.
     * The `WA_`-prefixed names still win where they're set, so this gateway can
     * be pointed at a different chat without disturbing anything else.
     *
     * Both halves must be present or alerting stays off. A token with nowhere to
     * send isn't half-working, it's off, and treating it as configured would
     * hide the fact that nobody is being told anything.
     */
    telegramBotToken:
        optional("WA_TELEGRAM_BOT_TOKEN", "") || optional("TELEGRAM_BOT_TOKEN", "") || null,
    telegramChatId:
        optional("WA_TELEGRAM_CHAT_ID", "") || optional("TELEGRAM_CHAT_ID", "") || null,

    logLevel: optional("WA_LOG_LEVEL", "info"),
};

export type Config = typeof config;
