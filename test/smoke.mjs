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
import { connect } from "node:net";

const mongo = await MongoMemoryServer.create();
const PORT = Number(process.env.SMOKE_PORT || 8791);
const base = `http://127.0.0.1:${PORT}/api`;
const MGMT_KEY = "smoke-management-key-abcdefgh";

/**
 * Refuse to run if something already holds one of our ports.
 *
 * `boot()` waits for `/api/health` to answer and calls that success. If another
 * process owns the port, the wait succeeds against *that* server and every
 * check afterwards reports on software this repo did not build — which reads as
 * a pile of genuine-looking failures in the gateway. It cost a debugging round:
 * an unrelated app on 8791 answered /api/health with its own JSON, and the
 * suite dutifully reported that health was broken.
 */
async function requireFreePort(port, what) {
    // Probed by CONNECTING, not by binding. Binding is the obvious check and it
    // does not work: the squatter here listened on IPv6 `*`, and SO_REUSEADDR
    // then lets a second socket bind 127.0.0.1 quite happily — so the probe
    // said "free", the server said "listening", and every request still went to
    // the other process. A successful connect is the only thing that actually
    // proves someone is there.
    const free = await new Promise((resolve) => {
        const sock = connect({ port, host: "127.0.0.1" });
        const done = (result) => {
            sock.destroy();
            resolve(result);
        };
        sock.setTimeout(1000, () => done(true));
        sock.once("connect", () => done(false));
        sock.once("error", () => done(true));
    });
    if (!free) {
        console.error(
            `\nport ${port} (${what}) is already in use — something else is listening there.\n` +
                `Stop it, or run with a different base port:  SMOKE_PORT=9791 npm run test:smoke\n`
        );
        await mongo.stop();
        process.exit(1);
    }
}

await requireFreePort(PORT, "the gateway under test");
await requireFreePort(PORT + 1, "webhook sink A");
await requireFreePort(PORT + 2, "webhook sink B");

// Two webhook sinks, one per bot, so we can tell which number delivered what.
const hits = { a: 0, b: 0 };
const sinkA = createServer((_q, r) => (hits.a++, r.writeHead(200).end("{}"))).listen(PORT + 1);
const sinkB = createServer((_q, r) => (hits.b++, r.writeHead(200).end("{}"))).listen(PORT + 2);
const sinkAUrl = `http://127.0.0.1:${PORT + 1}`;
const sinkBUrl = `http://127.0.0.1:${PORT + 2}`;

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

/** A minimal valid Cloud API send body, for the routing checks. */
const cloudText = () =>
    JSON.stringify({
        messaging_product: "whatsapp",
        to: "12025550111",
        type: "text",
        text: { body: "hi" },
    });

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
/** An MCP access token from the OAuth checks, used again after the restart. */
let mcpToken;
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
        body: JSON.stringify({ id: "alpha-bot", webhookUrl: `${sinkAUrl}/webhook` }),
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
                webhookUrl: `${sinkBUrl}/webhook`,
                sendRatePerMinute: 5,
            }),
        })
    ).json();
    tokenB = secondJson?.number?.token || "";
    check("a second number gets its own token", !!tokenB && tokenB !== tokenA);

    // --- input the old env parsing used to refuse to boot on -----------------

    const badId = await mgmt("/numbers", {
        method: "POST",
        body: JSON.stringify({ id: "bad:id", webhookUrl: `${sinkAUrl}/webhook` }),
    });
    check(
        "an id that would break key namespacing is a 400",
        badId.status === 400,
        `status=${badId.status}`
    );

    const dupId = await mgmt("/numbers", {
        method: "POST",
        body: JSON.stringify({ id: "alpha-bot", webhookUrl: `${sinkAUrl}/webhook` }),
    });
    check("a duplicate id is refused", dupId.status === 400, `status=${dupId.status}`);

    const badUrl = await mgmt("/numbers", {
        method: "POST",
        body: JSON.stringify({ id: "third", webhookUrl: "not-a-url" }),
    });
    check("a malformed webhook URL is refused", badUrl.status === 400, `status=${badUrl.status}`);

    const badRate = await mgmt("/numbers", {
        method: "POST",
        body: JSON.stringify({ id: "third", webhookUrl: "http://x.test/webhook", sendRatePerMinute: "lots" }),
    });
    check(
        "a non-numeric send rate is refused rather than silently disabling the limiter",
        badRate.status === 400,
        `status=${badRate.status}`
    );

    // --- activity marker -----------------------------------------------------
    //
    // The console's "is this working?" line. Nothing has arrived on a freshly
    // added number, so it must say so rather than inventing a timestamp.

    const fresh = (await (await mgmt("/numbers")).json()).numbers.find((n) => n.id === "alpha-bot");
    check(
        "a new number reports no messages received yet",
        fresh?.lastMessage === undefined && fresh?.messagesReceived === 0,
        JSON.stringify({ lastMessage: fresh?.lastMessage, count: fresh?.messagesReceived })
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
        "a number is given a Meta-style phone_number_id",
        /^[1-9]\d{14}$/.test(noWebhookJson?.number?.phoneNumberId || ""),
        noWebhookJson?.number?.phoneNumberId
    );
    check(
        "there is no webhook dialect to choose any more",
        !("webhookFormat" in (noWebhookJson?.number || {})),
        JSON.stringify(Object.keys(noWebhookJson?.number || {}))
    );
    check(
        "…with no rate cap, since none was given",
        noWebhookJson?.number?.sendRatePerMinute === null,
        JSON.stringify(noWebhookJson?.number?.sendRatePerMinute)
    );

    // Adding one later must not require re-pairing.
    await mgmt("/numbers/later", {
        method: "PATCH",
        body: JSON.stringify({ webhookUrl: `${sinkAUrl}/added-later` }),
    });
    const afterAdd = await (await mgmt("/numbers")).json();
    check(
        "a webhook can be attached afterwards",
        afterAdd.numbers.find((n) => n.id === "later")?.webhookUrl === `${sinkAUrl}/added-later`
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

    const noAuth = await fetch(`${base}/1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: cloudText(),
    });
    check("unauthenticated API call is rejected", noAuth.status === 401, `status=${noAuth.status}`);

    const badToken = await fetch(`${base}/1/messages`, {
        method: "POST",
        headers: authOf("not-a-real-token"),
        body: cloudText(),
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
        const r = await fetch(`${base}/1/messages`, {
            method: "POST",
            headers: authOf(token),
            body: cloudText(),
        });
        return [r, await r.json()];
    };

    const [sendA, sendAJson] = await send(tokenA);
    check(
        "token A routes to session 'alpha-bot'",
        sendA.status === 502 && /session "alpha-bot" not connected/.test(sendAJson?.error?.message || ""),
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

    // --- request validation ---------------------------------------------------

    const badBody = await fetch(`${base}/1/messages`, {
        method: "POST",
        headers: authOf(tokenA),
        body: JSON.stringify({ messaging_product: "whatsapp", to: "12025550111", type: "text" }),
    });
    check("a missing text body is a 400, not a 500", badBody.status === 400, `status=${badBody.status}`);

    const badPoll = await fetch(`${base}/1/messages`, {
        method: "POST",
        headers: authOf(tokenA),
        body: JSON.stringify({
            messaging_product: "whatsapp", to: "12025550111", type: "poll",
            poll: { name: "q", options: ["only-one"] },
        }),
    });
    check("a one-option poll is a 400", badPoll.status === 400, `status=${badPoll.status}`);

    // The removed per-verb routes must be gone, not quietly still answering.
    for (const [method, path] of [
        ["POST", "/messages/text"], ["POST", "/messages/image"], ["POST", "/messages/poll"],
        ["PUT", "/messages/abc"], ["PUT", "/messages/abc/reaction"], ["PUT", "/presences/12025550111"],
    ]) {
        const r = await fetch(`${base}${path}`, { method, headers: authOf(tokenA), body: "{}" });
        check(`${method} ${path} is gone`, r.status === 404, `status=${r.status}`);
    }

    // --- editing ------------------------------------------------------------

    await mgmt("/numbers/second-bot", {
        method: "PATCH",
        body: JSON.stringify({ webhookUrl: `${sinkBUrl}/moved` }),
    });
    const afterEdit = await (await mgmt("/numbers")).json();
    check(
        "editing a webhook URL sticks",
        afterEdit.numbers.find((n) => n.id === "second-bot")?.webhookUrl === `${sinkBUrl}/moved`
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

    const credA = await db.collection("auth_creds").findOne({ _id: "alpha-bot:creds" });
    const credB = await db.collection("auth_creds").findOne({ _id: "second-bot:creds" });
    check("each session persists its own credentials", !!credA && !!credB);
    check(
        "the two sessions hold DIFFERENT credentials",
        !!credA && !!credB && credA.value !== credB.value,
        "identical creds would mean both numbers share one device slot"
    );

    const keysUnscoped = await db
        .collection("auth_keys")
        .countDocuments({ _id: { $not: { $regex: /^(alpha-bot|second-bot):/ } } });
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

    // --- documents ----------------------------------------------------------
    //
    // The bytes are never fetched here — nothing is paired, so there is nothing
    // to fetch. What these prove is that the two endpoints exist, are guarded,
    // and don't leak the difference between "no such id" and "not yours".

    const docMetaNoAuth = await fetch(`${base}/wamid.NOPE`, {
        headers: { authorization: "Bearer definitely-not-a-token" },
    });
    check(
        "a media lookup with a wrong token is a 401",
        docMetaNoAuth.status === 401,
        `status=${docMetaNoAuth.status}`
    );

    const docMetaUnknown = await fetch(`${base}/wamid.NOPE`, { headers: authOf(tokenA) });
    check(
        "an unknown media id is a 404, not a 500",
        docMetaUnknown.status === 404,
        `status=${docMetaUnknown.status}`
    );

    const docBytesNoAuth = await fetch(`${base}/documents/wamid.NOPE`);
    check(
        "downloading a document without a token is a 401",
        docBytesNoAuth.status === 401,
        `status=${docBytesNoAuth.status}`
    );

    const docBytesUnknown = await fetch(`${base}/documents/wamid.NOPE`, { headers: authOf(tokenA) });
    check(
        "downloading an unknown document is a 404",
        docBytesUnknown.status === 404,
        `status=${docBytesUnknown.status}`
    );

    // --- MCP over OAuth: discovery, registration, approval, PKCE, refresh -----

    const mcpPost = (token, body) =>
        fetch(`${base}/mcp`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                // Streamable HTTP requires a client to accept both.
                accept: "application/json, text/event-stream",
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify(body),
        });
    const rpc = (method, params = {}, id = 1) => ({ jsonrpc: "2.0", id, method, params });
    const init = rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0" },
    });
    const form = (o) => new URLSearchParams(o).toString();
    const tokenPost = (o) =>
        fetch(`${base}/oauth/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: form(o),
        });
    const { createHash, randomBytes } = await import("node:crypto");
    const pkce = () => {
        const verifier = randomBytes(32).toString("base64url");
        return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
    };
    const REDIRECT = "http://localhost:53682/callback";

    const beforeOn = (await (await mgmt("/numbers")).json()).numbers.find((n) => n.id === "alpha-bot");
    check("MCP access is off by default", beforeOn?.mcpEnabled === false);

    // Discovery, exactly as an MCP client walks it.
    const mcpNoAuth = await mcpPost(undefined, init);
    const wwwAuth = mcpNoAuth.headers.get("www-authenticate") || "";
    const prmUrl = /resource_metadata="([^"]+)"/.exec(wwwAuth)?.[1];
    check(
        "an unauthenticated MCP call is a 401 that points at the resource metadata",
        mcpNoAuth.status === 401 && prmUrl === `http://127.0.0.1:${PORT}/api/.well-known/oauth-protected-resource`,
        wwwAuth
    );
    const prm = await (await fetch(prmUrl)).json();
    check(
        "the resource metadata names /api/mcp and the gateway as its authorization server",
        prm.resource === `${base}/mcp` && prm.authorization_servers?.[0] === base,
        JSON.stringify(prm)
    );
    // The one discovery path of the three a client tries that reaches /api.
    const asm = await (await fetch(`${base}/.well-known/openid-configuration`)).json();
    check(
        "authorization server metadata is served under /api, with PKCE S256 and registration",
        asm.issuer === base &&
            asm.token_endpoint === `${base}/oauth/token` &&
            asm.registration_endpoint === `${base}/oauth/register` &&
            asm.code_challenge_methods_supported?.includes("S256") &&
            !!asm.jwks_uri,
        JSON.stringify(asm).slice(0, 160)
    );

    // Where the platform's `/.well-known/*` → `/api/.well-known/:splat` redirect
    // lands a client that rediscovers from the root without a fresh 401.
    const mirroredPrm = await (await fetch(`${base}/.well-known/oauth-protected-resource/api/mcp`)).json().catch(() => null);
    const mirroredAs = await (await fetch(`${base}/.well-known/oauth-authorization-server/api`)).json().catch(() => null);
    check(
        "discovery documents also answer at the root-style paths the platform redirect produces",
        mirroredPrm?.resource === `${base}/mcp` && mirroredAs?.issuer === base
    );

    const badReg = await fetch(`${base}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
    });
    check("registration refuses a non-loopback http redirect", badReg.status === 400, `status=${badReg.status}`);

    const reg = await (
        await fetch(`${base}/oauth/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ client_name: "Smoke Assistant", redirect_uris: [REDIRECT] }),
        })
    ).json();
    const clientId = reg.client_id;
    check("an assistant can register itself", !!clientId && reg.token_endpoint_auth_method === "none");

    /** Start an authorization and return the approval request id the browser would land on. */
    const startAuth = async (challenge, extra = {}) => {
        const q = new URLSearchParams({
            response_type: "code",
            client_id: clientId,
            redirect_uri: REDIRECT,
            code_challenge: challenge,
            code_challenge_method: "S256",
            state: "st4te",
            resource: `${base}/mcp`,
            ...extra,
        });
        const r = await fetch(`${base}/oauth/authorize?${q}`, { redirect: "manual" });
        const loc = r.headers.get("location") || "";
        return { status: r.status, loc, request: new URL(loc, "http://x").searchParams.get("request") };
    };

    const noPkce = await startAuth("", { code_challenge_method: "plain" });
    check(
        "authorize without S256 PKCE bounces back with an error",
        noPkce.status === 302 && noPkce.loc.startsWith(REDIRECT) && /error=invalid_request/.test(noPkce.loc),
        noPkce.loc
    );
    const wrongRedirect = await fetch(
        `${base}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("https://other.example/cb")}`,
        { redirect: "manual" }
    );
    check(
        "authorize never redirects to an unregistered URI",
        wrongRedirect.status === 400 && !wrongRedirect.headers.get("location"),
        `status=${wrongRedirect.status}`
    );

    const p1 = pkce();
    const a1 = await startAuth(p1.challenge);
    check(
        "authorize sends the browser to the sign-in page",
        a1.status === 302 && a1.loc.startsWith(`http://127.0.0.1:${PORT}/authorize.html?request=`) && !!a1.request,
        a1.loc
    );

    const reqNoKey = await fetch(`${base}/mgmt/oauth/requests/${a1.request}`);
    check("the approval request needs the management key", reqNoKey.status === 401, `status=${reqNoKey.status}`);
    const reqInfo = await (await mgmt(`/oauth/requests/${a1.request}`)).json();
    check(
        "the approval page is told who is asking and which numbers exist",
        reqInfo.client?.name === "Smoke Assistant" &&
            reqInfo.client?.redirectHost === "localhost:53682" &&
            reqInfo.numbers?.some((n) => n.id === "alpha-bot")
    );

    const approveOff = await mgmt(`/oauth/requests/${a1.request}/approve`, {
        method: "POST",
        body: JSON.stringify({ number: "alpha-bot" }),
    });
    check("a number with MCP off cannot be approved", approveOff.status === 400, `status=${approveOff.status}`);

    await mgmt("/numbers/alpha-bot", { method: "PATCH", body: JSON.stringify({ mcp: true }) });
    const approved = await (
        await mgmt(`/oauth/requests/${a1.request}/approve`, { method: "POST", body: JSON.stringify({ number: "alpha-bot" }) })
    ).json();
    const back = new URL(approved.redirect || "http://x/");
    const code1 = back.searchParams.get("code");
    check(
        "approving returns the client's redirect with a code, its state and our issuer",
        approved.redirect?.startsWith(REDIRECT) && !!code1 && back.searchParams.get("state") === "st4te" && back.searchParams.get("iss") === base,
        approved.redirect
    );
    const replayApprove = await mgmt(`/oauth/requests/${a1.request}/approve`, {
        method: "POST",
        body: JSON.stringify({ number: "alpha-bot" }),
    });
    check("an approval request answers only once", replayApprove.status === 404, `status=${replayApprove.status}`);

    const badVerifier = await tokenPost({
        grant_type: "authorization_code",
        code: code1,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: pkce().verifier,
    });
    check(
        "a wrong PKCE verifier is refused",
        badVerifier.status === 400 && (await badVerifier.json()).error === "invalid_grant",
        `status=${badVerifier.status}`
    );
    const afterBad = await tokenPost({
        grant_type: "authorization_code",
        code: code1,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: p1.verifier,
    });
    check("…and that burns the code (single use)", afterBad.status === 400, `status=${afterBad.status}`);

    // A clean second round to get tokens.
    const p2 = pkce();
    const a2 = await startAuth(p2.challenge);
    const ok2 = await (
        await mgmt(`/oauth/requests/${a2.request}/approve`, { method: "POST", body: JSON.stringify({ number: "alpha-bot" }) })
    ).json();
    const tokRes = await tokenPost({
        grant_type: "authorization_code",
        code: new URL(ok2.redirect).searchParams.get("code"),
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: p2.verifier,
    });
    const tok = await tokRes.json();
    check(
        "the code exchanges for an access and a refresh token",
        tokRes.status === 200 && tok.token_type === "Bearer" && !!tok.access_token && !!tok.refresh_token && tok.expires_in > 0,
        `status=${tokRes.status}`
    );
    mcpToken = tok.access_token;

    const initRes = await mcpPost(mcpToken, init);
    const initJson = await initRes.json().catch(() => null);
    check(
        "MCP initialize works with the access token",
        initRes.status === 200 && initJson?.result?.serverInfo?.name === "whatsapp",
        `status=${initRes.status}`
    );
    const listRes = await (await mcpPost(mcpToken, rpc("tools/list", {}, 2))).json().catch(() => null);
    const toolNames = (listRes?.result?.tools || []).map((t) => t.name);
    const expected = [
        "list_chats", "search_contacts", "read_chat", "search_chat", "get_media", "group_info",
        "check_number", "send_message", "send_media", "prepare_upload", "react", "mark_read", "edit_message", "delete_message",
    ];
    check(
        "MCP lists every tool",
        expected.every((n) => toolNames.includes(n)),
        `missing: ${expected.filter((n) => !toolNames.includes(n)).join(",") || "none"}`
    );
    const callRes = await (
        await mcpPost(mcpToken, rpc("tools/call", { name: "list_chats", arguments: {} }, 3))
    ).json().catch(() => null);
    check(
        "list_chats works before pairing, from the index alone",
        callRes?.result?.content?.[0]?.text === "No chats seen yet.",
        JSON.stringify(callRes?.result || callRes?.error).slice(0, 120)
    );
    const sendRes = await (
        await mcpPost(mcpToken, rpc("tools/call", { name: "send_message", arguments: { to: "40700000000", text: "x" } }, 4))
    ).json().catch(() => null);
    check(
        "an MCP send on an unpaired number is a tool error, not a crash",
        sendRes?.result?.isError === true && /not connected/.test(sendRes?.result?.content?.[0]?.text || ""),
        JSON.stringify(sendRes?.result || sendRes?.error).slice(0, 120)
    );

    // --- uploads: a local file reaches send_media without passing through the model

    const callTool = async (name, args, id = 10) =>
        (await (await mcpPost(mcpToken, rpc("tools/call", { name, arguments: args }, id))).json().catch(() => null))?.result;
    const prep = await callTool("prepare_upload", { filename: "pic.png" });
    const prepText = prep?.content?.[0]?.text || "";
    const uploadId = /upload_id: (\S+)/.exec(prepText)?.[1];
    const uploadUrl = /'(http[^']+\/uploads\/[^']+)'/.exec(prepText)?.[1];
    check(
        "prepare_upload returns an id and a one-time link on this host",
        !!uploadId && uploadUrl === `${base}/uploads/${uploadId}`,
        prepText.slice(0, 120)
    );
    const { default: sharp } = await import("sharp");
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#25d366" } }).png().toBuffer();
    const put = (url, body, type = "application/octet-stream") =>
        fetch(url, { method: "PUT", headers: { "content-type": type }, body });
    const up1 = await put(uploadUrl, png);
    const up1Json = await up1.json().catch(() => null);
    check(
        "the file uploads, and its type comes from its bytes",
        up1.status === 201 && up1Json?.mime_type === "image/png" && up1Json?.bytes === png.length,
        `status=${up1.status} ${JSON.stringify(up1Json)}`
    );
    const up2 = await put(uploadUrl, png);
    check("an upload link works only once", up2.status === 409, `status=${up2.status}`);
    const upUnknown = await put(`${base}/uploads/not-a-real-upload-id`, png);
    check("an unknown upload link is a 404", upUnknown.status === 404, `status=${upUnknown.status}`);
    const upJson = await fetch(`${base}/uploads/${uploadId}x`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{}",
    });
    check("a JSON body is refused with a hint, not silently stored", upJson.status === 415, `status=${upJson.status}`);

    const sendUp = await callTool("send_media", { to: "40700000000", upload_id: uploadId });
    const sendUpAgain = await callTool("send_media", { to: "40700000000", upload_id: uploadId });
    check(
        "a send that fails keeps the upload for a retry",
        /not connected/.test(sendUp?.content?.[0]?.text || "") && /not connected/.test(sendUpAgain?.content?.[0]?.text || ""),
        `${sendUp?.content?.[0]?.text} | ${sendUpAgain?.content?.[0]?.text}`
    );
    const sendBogus = await callTool("send_media", { to: "40700000000", upload_id: "nope" });
    check(
        "an unknown upload_id is a clear tool error",
        sendBogus?.isError && /unknown, expired/.test(sendBogus?.content?.[0]?.text || ""),
        sendBogus?.content?.[0]?.text
    );
    const sendTwo = await callTool("send_media", { to: "40700000000", upload_id: uploadId, url: "https://example.com/a.png" });
    check("send_media wants exactly one source", sendTwo?.isError && /exactly one/.test(sendTwo?.content?.[0]?.text || ""));

    // Over the per-file cap: cut off while streaming, not buffered first.
    const bigPrep = (await callTool("prepare_upload", {}, 50))?.content?.[0]?.text || "";
    const bigUrl = /'(http[^']+\/uploads\/[^']+)'/.exec(bigPrep)?.[1];
    const tooBig = await put(bigUrl, Buffer.alloc(65 * 1024 * 1024, 1)).catch((e) => ({ status: `error: ${e.cause?.code || e.message}` }));
    const aliveAfter = await fetch(`${base}/health`);
    check(
        "a file over the per-file cap is refused, and the server carries on",
        (tooBig.status === 413 || /EPIPE|ECONNRESET|UND_ERR_SOCKET/.test(String(tooBig.status))) && aliveAfter.status === 200,
        `upload=${tooBig.status} health=${aliveAfter.status}`
    );

    // The disk can't be filled by asking: links per number are capped.
    let capHit = "";
    for (let i = 0; i < 25 && !capHit; i++) {
        const r = await callTool("prepare_upload", {}, 100 + i);
        if (r?.isError) capHit = r.content?.[0]?.text || "";
    }
    check("open upload links per number are capped", /already open/.test(capHit), capHit.slice(0, 80));

    const mcpBotToken = await mcpPost(tokenA, init);
    const mcpBotTokenJson = await mcpBotToken.json();
    check(
        "MCP rejects the bot token, and says so",
        mcpBotToken.status === 401 && /bot token/.test(mcpBotTokenJson?.error?.message || ""),
        `status=${mcpBotToken.status}`
    );
    const [cloudWithMcp] = await send(mcpToken);
    check("an MCP access token cannot drive the Cloud API", cloudWithMcp.status === 401, `status=${cloudWithMcp.status}`);
    const mgmtWithMcp = await fetch(`${base}/mgmt/numbers`, { headers: { authorization: `Bearer ${mcpToken}` } });
    check("an MCP access token cannot reach the management API", mgmtWithMcp.status === 401, `status=${mgmtWithMcp.status}`);
    const mcpGet = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${mcpToken}` } });
    check("GET /api/mcp is a 405 (stateless), not a media lookup", mcpGet.status === 405, `status=${mcpGet.status}`);

    const listed = (await (await mgmt("/numbers")).json()).numbers.find((n) => n.id === "alpha-bot");
    check(
        "the console lists the connected assistant",
        listed?.mcpClients?.length === 1 && listed.mcpClients[0].name === "Smoke Assistant",
        JSON.stringify(listed?.mcpClients)
    );

    // Refresh rotates: the new pair works, the old refresh token is spent.
    const refreshed = await (
        await tokenPost({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: clientId })
    ).json();
    const reuse = await tokenPost({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: clientId });
    const viaRefreshed = await mcpPost(refreshed.access_token, init);
    check(
        "refresh issues a working token and spends the old refresh token",
        !!refreshed.access_token && viaRefreshed.status === 200 && reuse.status === 400,
        `refreshed=${viaRefreshed.status} reuse=${reuse.status}`
    );
    const stillOne = (await (await mgmt("/numbers")).json()).numbers.find((n) => n.id === "alpha-bot");
    check("refreshing does not count as a second assistant", stillOne?.mcpClients?.length === 1);

    const disc = await (await mgmt("/numbers/alpha-bot/disconnect-mcp", { method: "POST" })).json();
    const afterDisc = await mcpPost(refreshed.access_token, init);
    check(
        "disconnecting revokes the assistant at once",
        disc.disconnected > 0 && afterDisc.status === 401,
        `status=${afterDisc.status}`
    );

    // One more approval, kept for the restart check below — and turning MCP
    // off on second-bot proves off revokes.
    const p3 = pkce();
    const a3 = await startAuth(p3.challenge);
    const ok3 = await (
        await mgmt(`/oauth/requests/${a3.request}/approve`, { method: "POST", body: JSON.stringify({ number: "alpha-bot" }) })
    ).json();
    mcpToken = (
        await (
            await tokenPost({
                grant_type: "authorization_code",
                code: new URL(ok3.redirect).searchParams.get("code"),
                redirect_uri: REDIRECT,
                client_id: clientId,
                code_verifier: p3.verifier,
            })
        ).json()
    ).access_token;

    await mgmt("/numbers/second-bot", { method: "PATCH", body: JSON.stringify({ mcp: true }) });
    const p4 = pkce();
    const a4 = await startAuth(p4.challenge);
    const ok4 = await (
        await mgmt(`/oauth/requests/${a4.request}/approve`, { method: "POST", body: JSON.stringify({ number: "second-bot" }) })
    ).json();
    const tokB = await (
        await tokenPost({
            grant_type: "authorization_code",
            code: new URL(ok4.redirect).searchParams.get("code"),
            redirect_uri: REDIRECT,
            client_id: clientId,
            code_verifier: p4.verifier,
        })
    ).json();
    await mgmt("/numbers/second-bot", { method: "PATCH", body: JSON.stringify({ mcp: false }) });
    const offB = await mcpPost(tokB.access_token, init);
    const refreshOffB = await tokenPost({ grant_type: "refresh_token", refresh_token: tokB.refresh_token, client_id: clientId });
    check(
        "turning MCP off revokes its access and refresh tokens",
        offB.status === 401 && refreshOffB.status === 400,
        `access=${offB.status} refresh=${refreshOffB.status}`
    );

    const deniedP = pkce();
    const aDeny = await startAuth(deniedP.challenge);
    const denied = await (await mgmt(`/oauth/requests/${aDeny.request}/deny`, { method: "POST" })).json();
    check(
        "denying sends the client access_denied with its state",
        /error=access_denied/.test(denied.redirect || "") && /state=st4te/.test(denied.redirect || ""),
        denied.redirect
    );

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
        list.numbers.map((n) => n.id).sort().join(",") === "alpha-bot,second-bot",
        list.numbers.map((n) => n.id).join(",")
    );
    check(
        "and their tokens still route after the restart",
        list.numbers.find((n) => n.id === "alpha-bot")?.token === tokenA
    );
    const mcpAfter = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${mcpToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    check("an MCP access token still works after the restart", mcpAfter.status === 200, `status=${mcpAfter.status}`);

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
    const survivorCreds = await db.collection("auth_creds").countDocuments({ _id: /^alpha-bot:/ });
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
