import express from "express";
import { API_PREFIX, config } from "./config.js";
import { captureConsole, logger } from "./log.js";
import { connectStores } from "./store.js";
import { MediaStore } from "./media.js";
import { SessionManager } from "./sessions.js";
import { makeApiRouter, makeGatewayRouter, makeManagementRouter } from "./routes.js";
import { ConnectionWatcher, TelegramNotifier } from "./alerts.js";

async function main() {
    // Before anything opens a socket: libsignal starts dumping session state to
    // console.info the moment sessions are in play.
    captureConsole();

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
    // Pironman terminates TLS and proxies to this container, so without this
    // every request appears to come from the proxy — and the management API's
    // per-address throttle would lock out everyone at once instead of the one
    // address guessing keys. One hop: the proxy's own X-Forwarded-For entry.
    app.set("trust proxy", 1);

    /**
     * Nothing under /api is cacheable.
     *
     * The edge in front of this will otherwise cache a response and serve it
     * back for later requests to the same path — including 404s, and including
     * for POSTs. That was observed: a path that 404'd before a deploy kept
     * returning the cached 404 afterwards, while the same path with a query
     * string returned 200 from the live container. A bot would experience that
     * as an endpoint that permanently stopped existing.
     *
     * Media sets its own cache-control afterwards and is exempt by being
     * mounted later — it is immutable content behind an unguessable URL, and
     * caching it is the point.
     */
    app.use(API_PREFIX, (_req, res, next) => {
        res.setHeader("cache-control", "no-store");
        next();
    });

    // Everything hangs off /api because that is the only prefix Pironman routes
    // to the container; the management console is the static bundle answering
    // every other path. Health and media first — they must stay reachable when
    // no number is paired, which is exactly when you need the console working.
    app.use(API_PREFIX, makeGatewayRouter(manager, media));
    app.use(`${API_PREFIX}/mgmt`, makeManagementRouter(manager));
    app.use(API_PREFIX, makeApiRouter(manager));

    app.use((_req, res) => res.status(404).json({ error: { message: "not found" } }));

    const server = app.listen(config.port, config.host, () => {
        logger.info(
            { port: config.port, host: config.host, publicUrl: config.publicUrl, apiPrefix: API_PREFIX },
            "wa-gateway listening"
        );
    });

    if (!config.configured) {
        // Deliberately shouty. This is a real, working process that cannot do
        // anything useful, and the only way out is an operator setting these —
        // so the log has to say exactly which ones and what it costs.
        logger.error(
            { missing: config.missingConfig },
            "NOT CONFIGURED — the management API is disabled until these environment " +
                "variables are set and the app redeployed"
        );
    }

    await manager.loadAll();

    // Started after loadAll so it seeds from real state, and a restart doesn't
    // announce every number as freshly recovered.
    const watcher = new ConnectionWatcher(
        manager,
        new TelegramNotifier(config.telegramBotToken, config.telegramChatId)
    );
    watcher.start();

    const shutdown = async (signal: string) => {
        logger.info({ signal }, "shutting down");
        server.close();
        watcher.stop();
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
