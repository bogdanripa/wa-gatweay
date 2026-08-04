/**
 * Local stand-in for Pironman, so the console can be worked on without a deploy.
 *
 * It reproduces the one thing about the platform that shapes this codebase: the
 * proxy routes `/api/*` to the container and answers everything else from the
 * static bundle. Getting that wrong locally means shipping something that only
 * fails once it's live, which is a slow way to find a path bug.
 *
 *     npm run dev:console          # http://127.0.0.1:8080
 *
 * Sessions you create here are real — the gateway opens a real WebSocket to
 * WhatsApp and the QR is a real pairing QR. Nothing is linked until you scan it.
 * State goes to an in-memory mongod that is thrown away on exit.
 */
import { MongoMemoryServer } from "mongodb-memory-server";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM = PORT + 1;
const ROOT = new URL("../frontend/", import.meta.url).pathname;

const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
};

const mongo = await MongoMemoryServer.create();

const gateway = spawn(process.execPath, ["dist/server.js"], {
    env: {
        ...process.env,
        WA_MONGO_URL: mongo.getUri(),
        WA_MONGO_DB: "dev",
        WA_PUBLIC_URL: `http://127.0.0.1:${PORT}`,
        WA_MANAGEMENT_KEY: process.env.WA_MANAGEMENT_KEY || "dev-management-key-0123456789",
        PORT: String(UPSTREAM),
        WA_LOG_LEVEL: process.env.WA_LOG_LEVEL || "info",
        WA_BAILEYS_LOG_LEVEL: "error",
    },
    stdio: ["ignore", "inherit", "inherit"],
});

const proxy = createServer(async (req, res) => {
    try {
        if (req.url === "/api" || req.url.startsWith("/api/")) {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const upstream = await fetch(`http://127.0.0.1:${UPSTREAM}${req.url}`, {
                method: req.method,
                headers: { ...req.headers, host: `127.0.0.1:${UPSTREAM}` },
                body: chunks.length ? Buffer.concat(chunks) : undefined,
            });
            res.writeHead(upstream.status, {
                "content-type": upstream.headers.get("content-type") || "application/octet-stream",
            });
            res.end(Buffer.from(await upstream.arrayBuffer()));
            return;
        }

        const path = new URL(req.url, "http://x").pathname;
        const file = path === "/" ? "index.html" : normalize(path).replace(/^(\.\.[/\\])+/, "");
        try {
            const body = await readFile(join(ROOT, file));
            res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
            res.end(body);
        } catch {
            res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
            res.end(await readFile(join(ROOT, "404.html")));
        }
    } catch (e) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(String(e));
    }
});

proxy.listen(PORT, () => {
    console.log(`\n  console  http://127.0.0.1:${PORT}`);
    console.log(`  key      ${process.env.WA_MANAGEMENT_KEY || "dev-management-key-0123456789"}\n`);
});

const shutdown = async () => {
    gateway.kill("SIGTERM");
    proxy.close();
    await sleep(300);
    await mongo.stop();
    process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
