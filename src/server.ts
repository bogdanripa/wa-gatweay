import express from "express";
import { config } from "./config.js";
import { logger } from "./log.js";
import { connectStores } from "./store.js";
import { MediaStore } from "./media.js";
import { SessionManager } from "./sessions.js";
import { makeAdminRouter, makeApiRouter } from "./routes.js";

async function main() {
    const stores = await connectStores();

    const media = new MediaStore(stores);
    await media.init();
    media.startCleanup();

    const manager = new SessionManager(stores, media);

    const app = express();
    // Images arrive as base64 data URIs from the bots' image generation, which
    // blows well past Express's 100kb default.
    app.use(express.json({ limit: "25mb" }));
    app.disable("x-powered-by");

    // Admin/health/media first — they must stay reachable while unpaired, which is
    // exactly when you need the QR page.
    app.use(makeAdminRouter(manager, media));
    app.use(makeApiRouter(manager));

    app.use((_req, res) => res.status(404).json({ error: { message: "not found" } }));

    const server = app.listen(config.port, () => {
        logger.info(
            { port: config.port, publicUrl: config.publicUrl, sessions: config.sessions.length },
            "wa-gateway listening"
        );
    });

    await manager.startAll();

    const shutdown = async (signal: string) => {
        logger.info({ signal }, "shutting down");
        server.close();
        await manager.stopAll();
        await stores.close();
        process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));

    // A crash loop that silently drops messages is worse than a visible restart:
    // let the container die and let Pironman restart it.
    process.on("unhandledRejection", (e) => logger.error({ e }, "unhandled rejection"));
    process.on("uncaughtException", (e) => {
        logger.fatal({ e }, "uncaught exception — exiting");
        process.exit(1);
    });
}

main().catch((e) => {
    logger.fatal({ e }, "failed to start");
    process.exit(1);
});
