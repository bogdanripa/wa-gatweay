import { config } from "./config.js";
import { logger } from "./log.js";
import type { SessionManager } from "./sessions.js";
import type { Session, SessionStatus } from "./session.js";

/**
 * Tells you when a number stops working.
 *
 * A gateway that silently loses a session is the failure that actually costs
 * you: the bot goes quiet, nobody notices for a day, and the first sign is a
 * person asking why they were ignored. `/api/ready` reports it, but only to
 * something that asks.
 *
 * The whole design problem here is noise. WhatsApp drops sockets constantly and
 * Baileys reconnects within seconds — alerting on every `connection: close`
 * would train you to ignore the alerts within an hour, which is worse than
 * having none. So:
 *
 *   - a routine drop is given GRACE_MS to fix itself, and never alerts if it does
 *   - `logged-out` and `conflict` alert immediately, because they never self-heal
 *   - a number that has never connected is not an incident, it's an unpaired
 *     number waiting for someone to scan a QR
 *   - recovery is announced too, so a resolved alert doesn't leave you wondering
 */

/** How long a number may be disconnected before it's worth telling you about. */
const GRACE_MS = 3 * 60_000;
const SWEEP_MS = 30_000;

/** These don't recover on their own, so waiting out the grace period helps nobody. */
const TERMINAL: ReadonlySet<SessionStatus> = new Set(["logged-out", "conflict"]);

export class TelegramNotifier {
    constructor(
        private botToken: string | null,
        private chatId: string | null
    ) {}

    get enabled(): boolean {
        return !!this.botToken && !!this.chatId;
    }

    async send(text: string): Promise<void> {
        if (!this.enabled) return;
        try {
            const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    chat_id: this.chatId,
                    text,
                    // The alert names a WhatsApp number and a status; nothing in it
                    // benefits from being a link preview.
                    disable_web_page_preview: true,
                }),
                signal: AbortSignal.timeout(15_000),
            });
            if (!res.ok) {
                logger.error(
                    { status: res.status, body: (await res.text()).slice(0, 200) },
                    "telegram alert rejected"
                );
            }
        } catch (e) {
            // Never let a failed alert take down the thing it is watching.
            logger.error({ e }, "telegram alert failed to send");
        }
    }
}

interface Tracked {
    /** When it stopped being connected. Absent while healthy. */
    downSince?: number;
    /** Whether we've already told them about this outage. */
    alerted: boolean;
    /** A number that has never connected is unpaired, not broken. */
    everConnected: boolean;
    lastStatus?: SessionStatus;
}

export class ConnectionWatcher {
    private state = new Map<string, Tracked>();
    private timer?: NodeJS.Timeout;

    constructor(
        private manager: SessionManager,
        private notifier: TelegramNotifier
    ) {}

    start() {
        if (!this.notifier.enabled) {
            logger.info("connection alerts disabled — set WA_TELEGRAM_BOT_TOKEN and WA_TELEGRAM_CHAT_ID");
            return;
        }
        // Seed from the current state so a restart doesn't announce every number
        // as freshly recovered.
        for (const s of this.manager.all()) this.track(s);
        this.timer = setInterval(() => this.sweep(), SWEEP_MS);
        this.timer.unref();
        logger.info({ graceSeconds: GRACE_MS / 1000 }, "connection alerts enabled");
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    private track(session: Session): Tracked {
        let t = this.state.get(session.id);
        if (!t) {
            t = { alerted: false, everConnected: session.status === "connected" };
            this.state.set(session.id, t);
        }
        return t;
    }

    private sweep() {
        const now = Date.now();
        const live = new Set<string>();

        for (const session of this.manager.all()) {
            live.add(session.id);
            const t = this.track(session);
            const status = session.status;

            if (status === "connected") {
                t.everConnected = true;
                if (t.alerted) {
                    const downFor = t.downSince ? Math.round((now - t.downSince) / 60_000) : 0;
                    void this.notifier.send(
                        `✅ ${session.id} is back\n` +
                            `WhatsApp number reconnected after about ${downFor} minute${downFor === 1 ? "" : "s"}.`
                    );
                }
                t.alerted = false;
                t.downSince = undefined;
                t.lastStatus = status;
                continue;
            }

            // Never connected — it's waiting to be paired, which is not a fault.
            if (!t.everConnected) {
                t.lastStatus = status;
                continue;
            }

            if (t.downSince === undefined) t.downSince = now;

            const terminal = TERMINAL.has(status);
            const overdue = now - t.downSince >= GRACE_MS;

            // Re-alert if it degrades from "reconnecting" into something terminal,
            // because the advice changes: one resolves itself, the other needs you.
            const escalated = t.alerted && terminal && !TERMINAL.has(t.lastStatus ?? "starting");

            if ((!t.alerted && (terminal || overdue)) || escalated) {
                t.alerted = true;
                void this.notifier.send(this.describeOutage(session, now - t.downSince));
            }

            t.lastStatus = status;
        }

        // Forget numbers that were deleted, so their state can't leak into a
        // later number that happens to reuse the id.
        for (const id of [...this.state.keys()]) if (!live.has(id)) this.state.delete(id);
    }

    private describeOutage(session: Session, downMs: number): string {
        const mins = Math.max(1, Math.round(downMs / 60_000));
        const console_ = `${config.publicUrl}/console.html`;

        if (session.status === "logged-out") {
            return (
                `🔴 ${session.id} was unlinked from WhatsApp\n\n` +
                `Its credentials are gone, so it will not reconnect on its own. ` +
                `Open the console and use "Unlink & re-pair" to scan a fresh QR.\n${console_}`
            );
        }
        if (session.status === "conflict") {
            return (
                `🔴 ${session.id} lost its device slot\n\n` +
                `Another client connected with the same credentials, so this session stopped ` +
                `rather than fight over it. Check for a second gateway instance, then hit ` +
                `"Restart" in the console.\n${console_}`
            );
        }
        return (
            `⚠️ ${session.id} has been disconnected for ~${mins} minute${mins === 1 ? "" : "s"}\n\n` +
            `Status: ${session.status}${session.lastError ? `\nLast error: ${session.lastError}` : ""}\n` +
            `It is still retrying. You'll get another message when it recovers.\n${console_}`
        );
    }
}
