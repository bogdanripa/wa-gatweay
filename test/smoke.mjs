/**
 * Boot smoke test: starts a real mongod, boots the actual server process with
 * NO numbers configured, then adds two through the management API — which is how
 * a real deployment now starts life.
 *
 * It deliberately does NOT pair with WhatsApp — that needs a phone. What it
 * proves is that the process starts empty and stays healthy (a deployment that
 * can't go green with zero numbers can never be given its first one), that the
 * management key actually gates the console's API, that numbers added at runtime
 * are routed by token and isolated from each other in Mongo, that they survive a
 * restart, and that a misconfigured gateway refuses to start rather than
 * half-working.
 */
import { MongoMemoryServer } from "mongodb-memory-server";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "node:http";

const mongo = await MongoMemoryServer.create();
const PORT = 8791;
const base = `http://127.0.0.1:${PORT}/api`;
const MGMT_KEY = "smoke-management-key-abcdefgh";

// Two webhook sinks, one per bot, so we can tell which number delivered what.
const hits = { a: 0, b: 0 };
const sinkA = createServer((_q, r) => (hits.a++, r.writeHead(200).end("{}"))).listen(8792);
const sinkB = createServer((_q, r) => (hits.b++, r.writeHead(200).end("{}"))).listen(8793);

const baseEnv = {
    ...process.env,
    WA_MONGO_URL: mongo.getUri(),
    WA_MONGO_DB: "smoke",
    WA_PUBLIC_URL: `http://127.0.0.1:${PORT}`,
    WA_MANAGEMENT_KEY: MGMT_KEY,
    PORT: String(PORT),
    WA_LOG_LEVEL: "error",
    WA_BAILEYS_LOG_LEVEL: "silent",
};

const results = [];
const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const mgmt = (path, options = {}) =>
    fetch(`${base}/mgmt${path}`, {
        ...options,
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${MGMT_KEY}`,
            ...(options.headers || {}),
        },
    });

const authOf = (token) => ({ "content-type": "application/json", authorization: `Bearer ${token}` });

/** Boot with an env override and keep it running; resolves once /api/health answers. */
function bootWith(envOverride, port) {
    const p = spawn(process.execPath, ["dist/server.js"], {
        env: { ...baseEnv, ...envOverride, PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    return p;
}

/** Boot the server with an env override; resolves { code, out } once it exits. */
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

let out = "";
function boot() {
    const child = spawn(process.execPath, ["dist/server.js"], {
        env: baseEnv,
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    return child;
}

async function waitForBoot() {
    for (let i = 0; i < 60; i++) {
        try {
            const r = await fetch(`${base}/health`);
            if (r.ok) return true;
        } catch {}
        await sleep(500);
    }
    return false;
}

let child = boot();
let tokenA = "";
let tokenB = "";

try {
    check("server boots with no numbers configured", await waitForBoot());

    // --- health vs readiness -----------------------------------------------

    const health = await fetch(`${base}/health`);
    const hj = await health.json();
    check(
        "/api/health is 200 with zero numbers (a deploy could never go green otherwise)",
        health.status === 200 && hj.total === 0,
        `status=${health.status} total=${hj.total}`
    );
    // The point is that nothing identifying leaks from an unauthenticated
    // endpoint — this used to return every session's full state, pairing code
    // included. Assert the shape by what must be ABSENT, so adding a harmless
    // counter later doesn't fail the test that guards a security property.
    check(
        "/api/health exposes counts only, never per-session detail",
        !("sessions" in hj) &&
            !JSON.stringify(hj).match(/token|pairingCode|webhookUrl|qr/i) &&
            Object.keys(hj).sort().join(",") === "configured,connected,ok,total",
        Object.keys(hj).join(",")
    );

    const ready = await fetch(`${base}/ready`);
    check("/api/ready is 503 with nothing paired", ready.status === 503, `status=${ready.status}`);

    // --- management auth ----------------------------------------------------

    const mgmtNoKey = await fetch(`${base}/mgmt/numbers`);
    check("management API rejects a missing key", mgmtNoKey.status === 401, `status=${mgmtNoKey.status}`);

    const mgmtBadKey = await fetch(`${base}/mgmt/numbers`, {
        headers: { authorization: "Bearer not-the-management-key" },
    });
    check("management API rejects a wrong key", mgmtBadKey.status === 401, `status=${mgmtBadKey.status}`);

    const emptyList = await (await mgmt("/numbers")).json();
    check("management API lists no numbers to begin with", emptyList.numbers.length === 0);
    check(
        "management API advertises no gateway-wide rate default",
        emptyList.defaults === undefined,
        JSON.stringify(emptyList.defaults)
    );
    check(
        "management API tells you the bots' base URL, /api prefix included",
        emptyList.apiBaseUrl === `http://127.0.0.1:${PORT}/api`,
        emptyList.apiBaseUrl
    );

    // --- creating numbers ---------------------------------------------------

    const created = await mgmt("/numbers", {
        method: "POST",
        body: JSON.stringify({ id: "gepetel", webhookUrl: "http://127.0.0.1:8792/whapi" }),
    });
    const createdJson = await created.json();
    tokenA = createdJson?.number?.token || "";
    check("a number can be added over the API", created.status === 201 && !!tokenA, `status=${created.status}`);
    check("the generated token is not guessable", tokenA.length >= 32, `${tokenA.length} chars`);

    const secondJson = await (
        await mgmt("/numbers", {
            method: "POST",
            body: JSON.stringify({
                id: "second-bot",
                webhookUrl: "http://127.0.0.1:8793/whapi",
                sendRatePerMinute: 5,
            }),
        })
    ).json();
    tokenB = secondJson?.number?.token || "";
    check("a second number gets its own token", !!tokenB && tokenB !== tokenA);

    // --- input the old env parsing used to refuse to boot on -----------------

    const badId = await mgmt("/numbers", {
        method: "POST",
        body: JSON.stringify({ id: "bad:id", webhookUrl: "http://127.0.0.1:8792/whapi" }),
    });
    check(
        "an id that would break key namespacing is a 400",
        badId.status === 400,
        `status=${badId.status}`
    );

    const dupId = await mgmt("/numbers", {
        method: "POST",
        body: JSON.stringify({ id: "gepetel", webhookUrl: "http://127.0.0.1:8792/whapi" }),
    });
    check("a duplicate id is refused", dupId.status === 400, `status=${dupId.status}`);

    const badUrl = await mgmt("/numbers", {
        method: "POST",
        body: JSON.stringify({ id: "third", webhookUrl: "not-a-url" }),
    });
    check("a malformed webhook URL is refused", badUrl.status === 400, `status=${badUrl.status}`);

    const badRate = await mgmt("/numbers", {
        method: "POST",
        body: JSON.stringify({ id: "third", webhookUrl: "http://x.test/whapi", sendRatePerMinute: "lots" }),
    });
    check(
        "a non-numeric send rate is refused rather than silently disabling the limiter",
        badRate.status === 400,
        `status=${badRate.status}`
    );

    // --- pair first, configure the webhook later -----------------------------
    //
    // Pairing is the slow, physical step. Requiring a webhook URL up front would
    // block it on a bot that may not exist yet.

    const noWebhook = await mgmt("/numbers", {
        method: "POST",
        body: JSON.stringify({ id: "later" }),
    });
    const noWebhookJson = await noWebhook.json();
    check(
        "a number can be added with no webhook at all",
        noWebhook.status === 201,
        `status=${noWebhook.status}`
    );
    check(
        "…and reports the webhook as unset rather than omitting it",
        noWebhookJson?.number?.webhookUrl === null,
        JSON.stringify(noWebhookJson?.number?.webhookUrl)
    );
    check(
        "…with no rate cap, since none was given",
        noWebhookJson?.number?.sendRatePerMinute === null,
        JSON.stringify(noWebhookJson?.number?.sendRatePerMinute)
    );

    // Adding one later must not require re-pairing.
    await mgmt("/numbers/later", {
        method: "PATCH",
        body: JSON.stringify({ webhookUrl: "http://127.0.0.1:8792/added-later" }),
    });
    const afterAdd = await (await mgmt("/numbers")).json();
    check(
        "a webhook can be attached afterwards",
        afterAdd.numbers.find((n) => n.id === "later")?.webhookUrl === "http://127.0.0.1:8792/added-later"
    );

    // And removed again by clearing the field.
    await mgmt("/numbers/later", { method: "PATCH", body: JSON.stringify({ webhookUrl: "" }) });
    const afterClear = await (await mgmt("/numbers")).json();
    check(
        "clearing the webhook unsets it rather than storing an empty string",
        afterClear.numbers.find((n) => n.id === "later")?.webhookUrl === null
    );

    await mgmt("/numbers/later", { method: "DELETE" });

    const missing = await mgmt("/numbers/nope/restart", { method: "POST" });
    check("acting on an unknown number is a 404", missing.status === 404, `status=${missing.status}`);

    const missingDelete = await mgmt("/numbers/nope", { method: "DELETE" });
    check("deleting an unknown number is a 404", missingDelete.status === 404, `status=${missingDelete.status}`);

    // --- token routing ------------------------------------------------------

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

    // A session token must not be able to enumerate or edit the other numbers.
    const escalate = await fetch(`${base}/mgmt/numbers`, { headers: authOf(tokenA) });
    check(
        "a bot's own token cannot reach the management API",
        escalate.status === 401,
        `status=${escalate.status}`
    );

    // The "not connected" error names the session, which is how we prove the
    // token selected the right one without needing a paired account.
    const send = async (token) => {
        const r = await fetch(`${base}/messages/text`, {
            method: "POST",
            headers: authOf(token),
            body: JSON.stringify({ to: "40700000000", body: "hi" }),
        });
        return [r, await r.json()];
    };

    const [sendA, sendAJson] = await send(tokenA);
    check(
        "token A routes to session 'gepetel'",
        sendA.status === 502 && /session "gepetel" not connected/.test(sendAJson?.error?.message || ""),
        sendAJson?.error?.message
    );

    const [sendB, sendBJson] = await send(tokenB);
    check(
        "token B routes to session 'second-bot'",
        sendB.status === 502 && /session "second-bot" not connected/.test(sendBJson?.error?.message || ""),
        sendBJson?.error?.message
    );

    check(
        "the two tokens reach different sessions",
        sendAJson?.error?.message !== sendBJson?.error?.message
    );

    // --- whapi request validation -------------------------------------------

    const badBody = await fetch(`${base}/messages/text`, {
        method: "POST",
        headers: authOf(tokenA),
        body: JSON.stringify({ to: "40700000000" }),
    });
    check("missing body is a 400, not a 500", badBody.status === 400, `status=${badBody.status}`);

    const badPoll = await fetch(`${base}/messages/poll`, {
        method: "POST",
        headers: authOf(tokenA),
        body: JSON.stringify({ to: "40700000000", poll: { name: "q", options: ["only-one"] } }),
    });
    check("a one-option poll is a 400", badPoll.status === 400, `status=${badPoll.status}`);

    // --- editing ------------------------------------------------------------

    await mgmt("/numbers/second-bot", {
        method: "PATCH",
        body: JSON.stringify({ webhookUrl: "http://127.0.0.1:8793/moved" }),
    });
    const afterEdit = await (await mgmt("/numbers")).json();
    check(
        "editing a webhook URL sticks",
        afterEdit.numbers.find((n) => n.id === "second-bot")?.webhookUrl === "http://127.0.0.1:8793/moved"
    );

    const rotated = await (await mgmt("/numbers/second-bot/rotate-token", { method: "POST" })).json();
    const [afterRotate] = await send(tokenB);
    check("a rotated token revokes the old one immediately", afterRotate.status === 401, `status=${afterRotate.status}`);
    const [withNew, withNewJson] = await send(rotated.token);
    check(
        "the rotated token reaches the same session",
        withNew.status === 502 && /second-bot/.test(withNewJson?.error?.message || "")
    );
    tokenB = rotated.token;

    // --- both numbers reach a pairable state --------------------------------

    let qrCount = 0;
    for (let i = 0; i < 25; i++) {
        const list = await (await mgmt("/numbers")).json();
        qrCount = list.numbers.filter((n) => n.qrDataUrl?.startsWith("data:image/png;base64")).length;
        if (qrCount >= 2) break;
        await sleep(1000);
    }
    check(
        "both numbers offer their own pairing QR",
        qrCount >= 2,
        `${qrCount} QR(s) — needs outbound WS to WhatsApp`
    );

    // --- storage isolation ---------------------------------------------------

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

    const keysUnscoped = await db
        .collection("auth_keys")
        .countDocuments({ _id: { $not: { $regex: /^(gepetel|second-bot):/ } } });
    check("no auth key escapes its session namespace", keysUnscoped === 0, `unscoped=${keysUnscoped}`);

    const idx = await db.collection("message_keys").indexes();
    check(
        "TTL index created on message_keys",
        idx.some((i) => i.expireAfterSeconds !== undefined),
        JSON.stringify(idx.map((i) => i.name))
    );
    check("sessionId index created on message_keys", idx.some((i) => i.key?.sessionId === 1));

    const sessionIdx = await db.collection("sessions").indexes();
    check(
        "sessions.token is uniquely indexed, so two numbers can't share a token",
        sessionIdx.some((i) => i.key?.token === 1 && i.unique),
        JSON.stringify(sessionIdx.map((i) => i.name))
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
    await sleep(500);
}

// --- numbers outlive the container ------------------------------------------
//
// The whole point of moving sessions out of env vars was that a redeploy must
// not lose them. Pironman replaces the container; this is that, in miniature.

try {
    child = boot();
    check("server boots again against the same database", await waitForBoot());

    const list = await (await mgmt("/numbers")).json();
    check(
        "numbers added at runtime survive a restart",
        list.numbers.map((n) => n.id).sort().join(",") === "gepetel,second-bot",
        list.numbers.map((n) => n.id).join(",")
    );
    check(
        "and their tokens still route after the restart",
        list.numbers.find((n) => n.id === "gepetel")?.token === tokenA
    );

    // Deleting must take the credentials with it: a leftover auth document means
    // recreating the id later silently adopts a dead account's device slot.
    const del = await mgmt("/numbers/second-bot", { method: "DELETE" });
    check("a number can be deleted", del.status === 200, `status=${del.status}`);

    const { MongoClient } = await import("mongodb");
    const mc = new MongoClient(mongo.getUri());
    await mc.connect();
    const db = mc.db("smoke");
    const leftoverCreds = await db.collection("auth_creds").countDocuments({ _id: /^second-bot:/ });
    const leftoverKeys = await db.collection("auth_keys").countDocuments({ _id: /^second-bot:/ });
    const survivorCreds = await db.collection("auth_creds").countDocuments({ _id: /^gepetel:/ });
    await mc.close();

    check(
        "deleting a number purges its credentials",
        leftoverCreds === 0 && leftoverKeys === 0,
        `creds=${leftoverCreds} keys=${leftoverKeys}`
    );
    check("deleting one number leaves the other's state alone", survivorCreds > 0);
} finally {
    child.kill("SIGTERM");
    await sleep(500);
}

// --- the unconfigured first boot --------------------------------------------
//
// Every fresh install passes through this state: the platform will not accept
// environment variables for an app that has never produced a running container,
// so the very first deploy necessarily happens with no management key. It has to
// come up healthy — otherwise it can never be configured — while refusing to
// administer anything.

{
    const PORT2 = 8794;
    const unconfigured = bootWith({ WA_MANAGEMENT_KEY: "", WA_PUBLIC_URL: "" }, PORT2);
    const base2 = `http://127.0.0.1:${PORT2}/api`;
    try {
        let up = false;
        for (let i = 0; i < 40; i++) {
            try {
                if ((await fetch(`${base2}/health`)).ok) { up = true; break; }
            } catch {}
            await sleep(500);
        }
        check("an unconfigured gateway still boots (or it could never be configured)", up);

        if (up) {
            const h = await (await fetch(`${base2}/health`)).json();
            check("…and reports itself unconfigured", h.configured === false, JSON.stringify(h));

            const r = await fetch(`${base2}/ready`);
            const rj = await r.json();
            check(
                "…/ready refuses to go green and names the missing variables",
                r.status === 503 && rj.missingConfig?.includes("WA_MANAGEMENT_KEY"),
                JSON.stringify(rj.missingConfig)
            );

            // The dangerous failure mode: an empty expected key matching an empty
            // bearer token, handing the console to anyone who asks.
            const openDoor = await fetch(`${base2}/mgmt/numbers`);
            check(
                "…the management API is switched off, not left open",
                openDoor.status === 503,
                `status=${openDoor.status}`
            );
            const emptyBearer = await fetch(`${base2}/mgmt/numbers`, {
                headers: { authorization: "Bearer " },
            });
            check(
                "…and an empty bearer token does not unlock it",
                emptyBearer.status === 503,
                `status=${emptyBearer.status}`
            );
        }
    } finally {
        unconfigured.kill("SIGTERM");
        await sleep(500);
    }
}

// --- config validation (separate boots, must refuse to start) ---------------

try {
    // The console is on the public internet and this key adds WhatsApp numbers.
    const shortKey = await bootExpectingExit({ WA_MANAGEMENT_KEY: "short" });
    check(
        "a guessable management key refuses to start",
        shortKey.code === 1 && /at least 16 characters/.test(shortKey.out),
        `exit=${shortKey.code}`
    );

    // NaN used to sail through here too and silently disable a limit.
    const badTtl = await bootExpectingExit({ WA_MEDIA_TTL_HOURS: "two days" });
    check(
        "a non-numeric media TTL refuses to start rather than breaking the sweep",
        badTtl.code === 1 && /must be a positive integer/.test(badTtl.out),
        `exit=${badTtl.code}`
    );

    const noMongo = await bootExpectingExit({ WA_MONGO_URL: "", DATABASE_URL: "" });
    check(
        "a missing Mongo URL refuses to start",
        noMongo.code === 1 && /WA_MONGO_URL/.test(noMongo.out),
        `exit=${noMongo.code}`
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
