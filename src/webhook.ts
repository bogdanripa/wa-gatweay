import { logger } from "./log.js";

/**
 * Delivers whapi-shaped events to one bot. Each session has its own instance, so
 * a slow or down bot backs up only its own number.
 *
 * Two properties matter here and both come from how the bots behave:
 *
 * 1. ORDERING. gepetel threads conversations through OpenAI response ids
 *    (`previousMessageId`), so messages arriving out of order corrupt the thread.
 *    Deliveries are therefore serialised through a single queue rather than
 *    fired concurrently.
 *
 * 2. AT-LEAST-ONCE. gepetel already dedupes on message id
 *    (`markMessageProcessed`), which is exactly the guarantee whapi gave it —
 *    whapi redelivers on any timeout or 5xx. So retrying here is safe, and
 *    matching that behaviour means gepetel's idempotency code keeps earning its
 *    keep instead of going stale.
 */
export class WebhookSender {
    private queue: Promise<void> = Promise.resolve();
    private depth = 0;
    private log;

    constructor(
        private url: string,
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
    retarget(url: string, token: string) {
        this.url = url;
        this.token = token;
    }

    /** Enqueue a payload. Resolves once this payload has been attempted. */
    send(payload: Record<string, any>): Promise<void> {
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
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30_000);
            let res: Response;
            try {
                res = await fetch(this.url, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        // The bot doesn't check this today, but sending it means it
                        // *can* verify the caller without another migration.
                        authorization: `Bearer ${this.token}`,
                    },
                    body: JSON.stringify(payload),
                    signal: controller.signal,
                });
            } finally {
                clearTimeout(timer);
            }

            if (!res.ok) throw new Error(`webhook returned ${res.status}`);
            this.log.debug({ keys: Object.keys(payload) }, "webhook delivered");
        } catch (e) {
            if (attempt >= MAX_ATTEMPTS) {
                this.log.error({ e, attempt }, "webhook delivery failed, giving up");
                return;
            }
            // 1s, 4s, 9s — quadratic keeps the tail short while still backing off.
            const waitMs = attempt * attempt * 1000;
            this.log.warn({ e, attempt, waitMs }, "webhook delivery failed, retrying");
            await new Promise((r) => setTimeout(r, waitMs));
            return this.deliver(payload, attempt + 1);
        }
    }
}
