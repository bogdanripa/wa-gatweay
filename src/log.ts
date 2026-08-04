import pino from "pino";
import { config } from "./config.js";

export const logger = pino({ level: config.logLevel });

/**
 * A much quieter child logger handed to Baileys itself — it logs a great deal at
 * debug/trace and would drown out the gateway's own lines in `apps_logs`.
 */
export const baileysLogger = logger.child(
    { mod: "baileys" },
    { level: process.env.WA_BAILEYS_LOG_LEVEL || "warn" }
);
