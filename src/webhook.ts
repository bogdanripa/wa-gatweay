import { logger } from "./log.js";

/**
 * Delivers events to one bot. Each session has its own instance, so
 * a slow or down bot backs up only its own number.
 *
 * Two properties matter here and both come from how the bots behave:
 *
 * 1. ORDERING. A bot that threads a conversation — through a model's previous
 *    response id, or its own state — is corrupted by messages arriving out of
 *    order. Deliveries are therefore serialised through a single queue rather
 *    than fired concurrently.
 *
 * 2. AT-LEAST-ONCE. Retries mean a consumer can see the same message twice, so
 *    handlers must dedupe on message id. That is the same guarantee the hosted
 *    APIs give — they redeliver on any timeout or 5xx — so a bot written against
 *    one already does it, and the requirement is documented rather than hidden.
 */
export class WebhookSender {
    private queue: Promise<void> = Promise.resolve();
    private depth = 0;
    private log;

    /**
     * Last delivery outcome, surfaced in the console.
     *
     * A webhook that fails every time used to be visible only as log lines
     * nobody reads: the number showed `connected`, the bot received nothing, and
     * there was no way to tell from the outside which end was broken. This is
     * the difference between "it's not working" and "it's returning 401".
     */
    lastDeliveryAt?: Date;
    lastFailure?: { at: Date; message: string };

    constructor(
        private url: string | undefined,
        private token: string,
        sessionId: string
    ) {
        this.log = logger.child({ session: sessionId, mod: "webhook" });
    }

    /**
     * Point deliveries at a new URL or token, keeping the queue intact.
     *
     * Replacing the sender outright would drop whatever is still queued, and the
     * ordering guarantee above only holds because that queue is never discarded —
     * anything already enqueued is delivered to the new target, in order.
     */
    retarget(url: string | undefined, token: string) {
        this.url = url;
        this.token = token;
    }

    /** Enqueue a payload. Resolves once this payload has been attempted. */
    send(payload: Record<string, any>): Promise<void> {
        // A number can be paired before its webhook is configured. Discard, don't
        // queue: holding events until a URL appears would mean a number paired
        // and left alone for a week floods its bot with stale conversation the
        // moment someone sets one, and the bots act on what they receive.
        if (!this.url) {
            this.log.info(
                { keys: Object.keys(payload), id: firstMessageId(payload) },
                "no webhook configured, event discarded"
            );
            return Promise.resolve();
        }

        this.depth++;
        const task = this.queue.then(() => this.deliver(payload)).finally(() => {
            this.depth--;
        });
        // Keep the chain alive even if one delivery rejects.
        this.queue = task.catch(() => {});
        return task;
    }

    get pending() {
        return this.depth;
    }

    private async deliver(payload: Record<string, any>, attempt = 1): Promise<void> {
        const MAX_ATTEMPTS = 4;
        const startedAt = Date.now();
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30_000);
            let res: Response;
            try {
                res = await fetch(this.url!, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        // Deliberately NOT `Authorization`. A webhook URL often
                        // points at something that owns that header for its own
                        // auth — ntfy.sh, for one, reads it and returns 401 for
                        // any credential it doesn't recognise, which silently
                        // failed every delivery. The receiver can still verify
                        // the caller; it just reads a header nobody else claims.
                        "x-wa-gateway-token": this.token,
                    },
                    body: JSON.stringify(payload),
                    signal: controller.signal,
                });
            } finally {
                clearTimeout(timer);
            }

            if (!res.ok) {
                // The body usually explains it far better than the status does —
                // ntfy's 401 comes with a link to its auth docs, for instance.
                const detail = (await res.text().catch(() => "")).slice(0, 200).trim();
                throw new Error(`webhook returned ${res.status}${detail ? `: ${detail}` : ""}`);
            }
            this.lastDeliveryAt = new Date();
            this.lastFailure = undefined;
            // `info`, not `debug`: this and the "message received" line either
            // side of it are what makes "did the bot get it?" answerable from
            // the logs alone. It is one line per event, which a WhatsApp number
            // generates at human speed — the volume is fine and the alternative
            // is reading Mongo to trace anything.
            this.log.info(
                {
                    status: res.status,
                    ms: Date.now() - startedAt,
                    attempt,
                    // Field names only. The payload carries message bodies.
                    keys: Object.keys(payload),
                    id: firstMessageId(payload),
                },
                "webhook delivered"
            );
        } catch (e) {
            if (attempt >= MAX_ATTEMPTS) {
                this.lastFailure = {
                    at: new Date(),
                    message: e instanceof Error ? e.message : String(e),
                };
                this.log.error(
                    { e, attempt, id: firstMessageId(payload), url: redactUrl(this.url) },
                    "webhook delivery failed, giving up"
                );
                return;
            }
            // 1s, 4s, 9s — quadratic keeps the tail short while still backing off.
            const waitMs = attempt * attempt * 1000;
            this.log.warn(
                { e, attempt, waitMs, id: firstMessageId(payload), url: redactUrl(this.url) },
                "webhook delivery failed, retrying"
            );
            await new Promise((r) => setTimeout(r, waitMs));
            return this.deliver(payload, attempt + 1);
        }
    }
}

/**
 * The message id inside a Cloud API envelope, for the log line.
 *
 * Every trace of an event through this gateway keys on this id — it is what the
 * webhook carries, what a bot quotes back, and what names a document. Digging it
 * out of the nesting once here is what lets a delivery line be matched to the
 * "message received" line that produced it.
 */
function firstMessageId(payload: Record<string, any>): string | undefined {
    const value = payload?.entry?.[0]?.changes?.[0]?.value;
    return value?.messages?.[0]?.id ?? value?.messages_updates?.[0]?.id ?? undefined;
}

/**
 * A webhook URL with its query string dropped.
 *
 * Webhook URLs routinely carry a shared secret in the query — logging one on
 * every failed delivery would write it into the container logs, which is the
 * same mistake as the pairing code on /health.
 */
function redactUrl(url: string | undefined): string | undefined {
    if (!url) return undefined;
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    } catch {
        return undefined;
    }
}
