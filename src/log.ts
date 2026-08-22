import { format } from "node:util";
import pino from "pino";
import { config } from "./config.js";

/**
 * `e` is serialised as an error, not as a plain object.
 *
 * Without this, `logger.error({ e }, "...")` writes `"e":{}` for any ordinary
 * Error, because `message` and `stack` are non-enumerable. Boom errors happened
 * to survive — they carry enumerable properties — which made the gap look like
 * it wasn't there. It cost a debugging round: a poll vote failed twice and both
 * lines said only `"e":{}`.
 */
export const logger = pino({
    level: config.logLevel,
    serializers: { e: pino.stdSerializers.err, err: pino.stdSerializers.err },
});

/**
 * A much quieter child logger handed to Baileys itself — it logs a great deal at
 * debug/trace and would drown out the gateway's own lines in `apps_logs`.
 */
export const baileysLogger = logger.child(
    { mod: "baileys" },
    { level: process.env.WA_BAILEYS_LOG_LEVEL || "warn" }
);

/**
 * Route dependencies' bare `console.*` calls through the logger.
 *
 * `baileysLogger` only governs what Baileys logs *through the logger it was
 * given*. Bundled libsignal doesn't use it — it calls `console.info` directly,
 * and one of those dumps an entire `SessionEntry`: ratchet state, chain keys,
 * and private key buffers. Measured on the live box, that was 56 of 63 log
 * lines. It made `apps_logs` useless exactly when it was needed, because the
 * tail was consumed before reaching anything real, and it wrote key material
 * into container logs besides.
 *
 * Routed by severity rather than silenced wholesale: the same library reports
 * genuine trouble this way — "Failed to decrypt message with any known session"
 * is a real symptom — so warn and error keep their level and only the routine
 * chatter drops to debug, recoverable with WA_LOG_LEVEL=debug.
 */
export function captureConsole() {
    const routes: Array<[keyof Console, "debug" | "warn" | "error"]> = [
        ["log", "debug"],
        ["info", "debug"],
        ["debug", "debug"],
        ["trace", "debug"],
        ["warn", "warn"],
        ["error", "error"],
    ];

    for (const [method, level] of routes) {
        (console as any)[method] = (...args: unknown[]) => {
            // pino writes via process.stdout directly, so this cannot recurse.
            logger[level]({ via: `console.${String(method)}` }, format(...args));
        };
    }
}
