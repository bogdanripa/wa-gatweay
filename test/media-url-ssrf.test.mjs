import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.WA_MONGO_URL ||= "mongodb://127.0.0.1:1/unused";

const { Session } = await import("../dist/session.js");
const { isBlockedIp, validateMediaUrl } = await import("../dist/ssrf.js");

function makeFakeSession() {
    const sent = [];
    const fakeStores = {
        messageKeys: { findOne: async () => null, updateOne: async () => {} },
        lidMap: { findOne: async () => null },
        chatlog: { insertOne: async () => {} },
    };
    const fakeMedia = {};
    const fakeDoc = {
        _id: "test-session",
        displayPhoneNumber: "15550001111",
        wabaId: "waba",
        webhookUrl: "",
        sendRatePerMinute: 60,
    };
    const session = new Session(fakeDoc, fakeStores, fakeMedia);
    session.status = "connected";
    session.sock = {
        sendMessage: async (jid, content, opts) => {
            sent.push({ jid, content, opts });
            return { key: { id: "msg-1" } };
        },
    };
    return { session, sent };
}

test("sendCloud rejects loopback, metadata, and private media URLs without calling sock.sendMessage", async () => {
    let hitInternal = false;
    const srv = http.createServer((_req, res) => {
        hitInternal = true;
        res.end("SECRET_METADATA");
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    try {
        const { session, sent } = makeFakeSession();
        const ssrfUrls = [
            `http://127.0.0.1:${port}/secret.png`,
            `https://127.0.0.1:${port}/secret.png`,
            "http://169.254.169.254/latest/meta-data/",
            "https://169.254.169.254/latest/meta-data/",
            "http://10.0.0.1/internal.pdf",
            "http://192.168.1.1/admin.png",
            "http://[::1]/secret.png",
            "http://localhost/secret.png",
        ];

        for (const url of ssrfUrls) {
            await assert.rejects(
                () =>
                    session.sendCloud({
                        to: "15551234567",
                        kind: { type: "image", media: url },
                    }),
                /blocked|https|invalid|private|loopback|not allowed|refused/i,
                `Expected sendCloud(image) to reject SSRF URL: ${url}`
            );

            await assert.rejects(
                () =>
                    session.sendCloud({
                        to: "15551234567",
                        kind: { type: "document", media: url, filename: "doc.pdf" },
                    }),
                /blocked|https|invalid|private|loopback|not allowed|refused/i,
                `Expected sendCloud(document) to reject SSRF URL: ${url}`
            );
        }

        assert.equal(sent.length, 0, "sock.sendMessage must not be called for SSRF URLs");
        assert.equal(hitInternal, false, "internal HTTP server must not be contacted");
    } finally {
        srv.close();
    }
});

test("isBlockedIp and validateMediaUrl block private IPv4, IPv6, IPv4-mapped, CGNAT, ULA, and DNS-resolved private IPs", async () => {
    for (const ip of [
        "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254",
        "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1",
        "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254",
    ]) {
        assert.equal(isBlockedIp(ip), true, `Expected ${ip} to be blocked`);
    }
    assert.equal(isBlockedIp("93.184.216.34"), false);
    assert.equal(isBlockedIp("2606:2800:220:1:248:1893:25c8:1946"), false);

    // DNS resolving to private IP must be rejected
    await assert.rejects(
        () => validateMediaUrl("https://evil.example/img.png", async () => [{ address: "10.0.0.5", family: 4 }]),
        /blocked/i
    );
    // DNS resolving to public IP passes
    const res = await validateMediaUrl("https://good.example/img.png", async () => [{ address: "93.184.216.34", family: 4 }]);
    assert.equal(res.addresses[0].address, "93.184.216.34");
});
