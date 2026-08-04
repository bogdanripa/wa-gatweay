/**
 * Boot smoke test: starts a real mongod, boots the actual server process with
 * TWO WhatsApp numbers configured, and exercises the HTTP surface the bots hit.
 *
 * It deliberately does NOT pair with WhatsApp — that needs a phone. What it
 * proves is that the process starts, Mongo wiring and TTL indexes are valid,
 * token-based routing sends each bot to its own number, session state is
 * namespaced so numbers can't see each other, and an unpaired gateway fails
 * safely (503 / clear errors) instead of hanging or crashing.
 */
import { MongoMemoryServer } from "mongodb-memory-server";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "node:http";

const mongo = await MongoMemoryServer.create();
const PORT = 8791;
const base = `http://127.0.0.1:${PORT}`;

const TOKEN_A = "token-alpha-aaaaaaaa";
const TOKEN_B = "token-beta-bbbbbbbb";

// Two webhook sinks, one per bot, so we can tell which number delivered what.
const hits = { a: 0, b: 0 };
const sinkA = createServer((_q, r) => (hits.a++, r.writeHead(200).end("{}"))).listen(8792);
const sinkB = createServer((_q, r) => (hits.b++, r.writeHead(200).end("{}"))).listen(8793);

const baseEnv = {
    ...process.env,
    WA_MONGO_URL: mongo.getUri(),
    WA_MONGO_DB: "smoke",
    WA_PUBLIC_URL: base,
    WA_ADMIN_PASSWORD: "adminpw",
    PORT: String(PORT),
    WA_LOG_LEVEL: "error",
    WA_BAILEYS_LOG_LEVEL: "silent",

    WA_SESSION_1_ID: "gepetel",
    WA_SESSION_1_TOKEN: TOKEN_A,
    WA_SESSION_1_WEBHOOK_URL: "http://127.0.0.1:8792/whapi",

    WA_SESSION_2_ID: "second-bot",
    WA_SESSION_2_TOKEN: TOKEN_B,
    WA_SESSION_2_WEBHOOK_URL: "http://127.0.0.1:8793/whapi",
};

const results = [];
const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

/** Boot the server with an env override; resolves { code, output } once it exits. */
function bootExpectingExit(envOverride, timeoutMs = 15000) {
    return new Promise((resolve) => {
        const p = spawn(process.execPath, ["dist/server.js"], {
            env: { ...baseEnv, ...envOverride },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (out += d));
        const t = setTimeout(() => {
            p.kill("SIGKILL");
            resolve({ code: null, out });
        }, timeoutMs);
        p.on("exit", (code) => {
            clearTimeout(t);
            resolve({ code, out });
        });
    });
}

const child = spawn(process.execPath, ["dist/server.js"], {
    env: baseEnv,
    stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

const adminHeaders = { authorization: "Basic " + Buffer.from("x:adminpw").toString("base64") };
const authOf = (token) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });

try {
    let up = false;
    for (let i = 0; i < 60; i++) {
        try {
            await fetch(`${base}/health`);
            up = true;
            break;
        } catch {
            await sleep(500);
        }
    }
    check("server boots with two numbers configured", up);
    if (!up) throw new Error("server never came up:\n" + out);

    // --- health ------------------------------------------------------------

    const health = await fetch(`${base}/health`);
    const hj = await health.json();
    check("/health returns 503 while unpaired", health.status === 503, `status=${health.status}`);
    check("/health reports both sessions", hj.total === 2 && hj.sessions.length === 2, `total=${hj.total}`);
    check(
        "/health names each session",
        hj.sessions.map((s) => s.id).sort().join(",") === "gepetel,second-bot",
        hj.sessions.map((s) => s.id).join(",")
    );
    check(
        "/health exposes each session's own webhook target",
        hj.sessions.find((s) => s.id === "gepetel")?.webhookUrl?.endsWith("8792/whapi") &&
            hj.sessions.find((s) => s.id === "second-bot")?.webhookUrl?.endsWith("8793/whapi")
    );

    // --- token routing -----------------------------------------------------

    const noAuth = await fetch(`${base}/messages/text`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "40700000000", body: "hi" }),
    });
    check("unauthenticated API call is rejected", noAuth.status === 401, `status=${noAuth.status}`);

    const badToken = await fetch(`${base}/messages/text`, {
        method: "POST",
        headers: authOf("not-a-real-token"),
        body: JSON.stringify({ to: "40700000000", body: "hi" }),
    });
    check("an unknown token is rejected", badToken.status === 401, `status=${badToken.status}`);

    // The "not connected" error names the session, which is how we prove the
    // token selected the right one without needing a paired account.
    const sendA = await fetch(`${base}/messages/text`, {
        method: "POST",
        headers: authOf(TOKEN_A),
        body: JSON.stringify({ to: "40700000000", body: "hi" }),
    });
    const sendAJson = await sendA.json();
    check(
        "token A routes to session 'gepetel'",
        sendA.status === 502 && /session "gepetel" not connected/.test(sendAJson?.error?.message || ""),
        sendAJson?.error?.message
    );

    const sendB = await fetch(`${base}/messages/text`, {
        method: "POST",
        headers: authOf(TOKEN_B),
        body: JSON.stringify({ to: "40700000000", body: "hi" }),
    });
    const sendBJson = await sendB.json();
    check(
        "token B routes to session 'second-bot'",
        sendB.status === 502 && /session "second-bot" not connected/.test(sendBJson?.error?.message || ""),
        sendBJson?.error?.message
    );

    check(
        "the two tokens reach different sessions",
        sendAJson?.error?.message !== sendBJson?.error?.message
    );

    // --- validation --------------------------------------------------------

    const badBody = await fetch(`${base}/messages/text`, {
        method: "POST",
        headers: authOf(TOKEN_A),
        body: JSON.stringify({ to: "40700000000" }),
    });
    check("missing body is a 400, not a 500", badBody.status === 400, `status=${badBody.status}`);

    const badPoll = await fetch(`${base}/messages/poll`, {
        method: "POST",
        headers: authOf(TOKEN_A),
        body: JSON.stringify({ to: "40700000000", poll: { name: "q", options: ["only-one"] } }),
    });
    check("a one-option poll is a 400", badPoll.status === 400, `status=${badPoll.status}`);

    // --- admin -------------------------------------------------------------

    const adminNoAuth = await fetch(`${base}/admin`);
    check("admin page requires basic auth", adminNoAuth.status === 401, `status=${adminNoAuth.status}`);

    const adminOk = await fetch(`${base}/admin`, { headers: adminHeaders });
    const html = await adminOk.text();
    check(
        "admin page lists both numbers",
        adminOk.status === 200 && html.includes("gepetel") && html.includes("second-bot")
    );
    check("admin page shows a per-session unlink action", html.includes("/admin/gepetel/logout"));

    const unknownLogout = await fetch(`${base}/admin/nope/logout`, {
        method: "POST",
        headers: adminHeaders,
        redirect: "manual",
    });
    check("unlinking an unknown session is a 404", unknownLogout.status === 404, `status=${unknownLogout.status}`);

    // Both numbers must independently reach a pairable state.
    let qrCount = 0;
    for (let i = 0; i < 25; i++) {
        const r = await fetch(`${base}/admin`, { headers: adminHeaders });
        const h = await r.text();
        qrCount = (h.match(/data:image\/png;base64/g) || []).length;
        if (qrCount >= 2) break;
        await sleep(1000);
    }
    check(
        "both numbers offer their own pairing QR",
        qrCount >= 2,
        `${qrCount} QR(s) — needs outbound WS to WhatsApp`
    );

    // --- storage isolation --------------------------------------------------

    const { MongoClient } = await import("mongodb");
    const mc = new MongoClient(mongo.getUri());
    await mc.connect();
    const db = mc.db("smoke");

    const credA = await db.collection("auth_creds").findOne({ _id: "gepetel:creds" });
    const credB = await db.collection("auth_creds").findOne({ _id: "second-bot:creds" });
    check("each session persists its own credentials", !!credA && !!credB);
    check(
        "the two sessions hold DIFFERENT credentials",
        !!credA && !!credB && credA.value !== credB.value,
        "identical creds would mean both numbers share one device slot"
    );

    const keysA = await db.collection("auth_keys").countDocuments({ _id: { $regex: /^gepetel:/ } });
    const keysB = await db.collection("auth_keys").countDocuments({ _id: { $regex: /^second-bot:/ } });
    const keysUnscoped = await db
        .collection("auth_keys")
        .countDocuments({ _id: { $not: { $regex: /^(gepetel|second-bot):/ } } });
    check("no auth key escapes its session namespace", keysUnscoped === 0, `unscoped=${keysUnscoped} a=${keysA} b=${keysB}`);

    const idx = await db.collection("message_keys").indexes();
    check(
        "TTL index created on message_keys",
        idx.some((i) => i.expireAfterSeconds !== undefined),
        JSON.stringify(idx.map((i) => i.name))
    );
    check(
        "sessionId index created on message_keys",
        idx.some((i) => i.key?.sessionId === 1)
    );
    await mc.close();

    // --- misc ---------------------------------------------------------------

    const traversal = await fetch(`${base}/media/..%2f..%2fetc%2fpasswd`);
    check("media path traversal is refused", traversal.status === 404, `status=${traversal.status}`);

    const nope = await fetch(`${base}/does-not-exist`);
    check("unknown route is a clean 404", nope.status === 404, `status=${nope.status}`);

    check("no webhook fired while unpaired", hits.a === 0 && hits.b === 0, `a=${hits.a} b=${hits.b}`);
} finally {
    child.kill("SIGTERM");
}

// --- config validation (separate boots, must refuse to start) ---------------

try {
    // Two sessions sharing an id would share auth state — both numbers fighting
    // over one device slot, which ends with both logged out.
    const dupId = await bootExpectingExit({ WA_SESSION_2_ID: "gepetel" });
    check(
        "duplicate session id refuses to start",
        dupId.code === 1 && /Duplicate session id/.test(dupId.out),
        `exit=${dupId.code}`
    );

    // Duplicate tokens would make routing ambiguous — one bot would silently
    // drive the wrong number.
    const dupToken = await bootExpectingExit({ WA_SESSION_2_TOKEN: TOKEN_A });
    check(
        "duplicate session token refuses to start",
        dupToken.code === 1 && /Duplicate session token/.test(dupToken.out),
        `exit=${dupToken.code}`
    );

    const noSessions = await bootExpectingExit({
        WA_SESSION_1_ID: "",
        WA_SESSION_2_ID: "",
    });
    check(
        "no configured sessions refuses to start",
        noSessions.code === 1 && /No sessions configured/.test(noSessions.out),
        `exit=${noSessions.code}`
    );

    const missingWebhook = await bootExpectingExit({ WA_SESSION_2_WEBHOOK_URL: "" });
    check(
        "a session missing its webhook URL refuses to start",
        missingWebhook.code === 1 && /WEBHOOK_URL is required/.test(missingWebhook.out),
        `exit=${missingWebhook.code}`
    );

    // A colon in an id would collide with the "<session>:<key>" document scheme.
    const badId = await bootExpectingExit({ WA_SESSION_2_ID: "bad:id" });
    check(
        "an id that would break key namespacing refuses to start",
        badId.code === 1 && /is invalid/.test(badId.out),
        `exit=${badId.code}`
    );
} finally {
    sinkA.close();
    sinkB.close();
    await mongo.stop();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed`);
if (failed.length) {
    console.log("\n--- server output ---\n" + out.slice(-3000));
    process.exit(1);
}
