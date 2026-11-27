import { test } from "node:test";
import assert from "node:assert/strict";

const { safeLinkPreview } = await import("../dist/linkPreview.js");

test("link previews refuse links that resolve to internal addresses, so Baileys never fetches them", async () => {
    const lookups = [];
    const lookup = async (host) => {
        lookups.push(host);
        return [{ address: "169.254.169.254", family: 4 }];
    };
    assert.equal(await safeLinkPreview("see https://metadata.example.test/latest/meta-data", lookup), null);
    assert.deepEqual(lookups, ["metadata.example.test"]);
});

test("link previews refuse literal loopback and private IP links without a DNS lookup", async () => {
    const lookup = async () => assert.fail("no DNS lookup expected for a literal IP");
    for (const text of ["http://127.0.0.1:8080/admin", "https://10.0.0.5/", "https://[::1]/x"]) {
        assert.equal(await safeLinkPreview(text, lookup), null, text);
    }
});

test("text without a link gets no preview", async () => {
    assert.equal(await safeLinkPreview("hello there"), null);
});
