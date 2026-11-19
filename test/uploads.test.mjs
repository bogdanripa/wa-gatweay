import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

/**
 * Upload cleanup and caps, with the limits shrunk so expiry takes
 * milliseconds and the disk budget is bytes, not hundreds of MB. The point is
 * that nothing accumulates on the Pi: used or not, an upload's file goes.
 */

// uploads.ts reads config at import; give it the one required variable.
process.env.WA_MONGO_URL ||= "mongodb://unused";
const { UploadStore } = await import("../dist/uploads.js");
const { fitForModel, MODEL_IMAGE_MAX_EDGE } = await import("../dist/imageFit.js");
const { default: sharp } = await import("sharp");

/** A request-shaped stream carrying `body`. */
function req(body, type = "application/octet-stream") {
    const r = Readable.from([Buffer.from(body)]);
    r.get = (h) => (h.toLowerCase() === "content-type" ? type : undefined);
    return r;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function store(limits = {}) {
    const dir = await mkdtemp(join(tmpdir(), "wa-uploads-"));
    const s = new UploadStore({ dir, ...limits });
    await s.init({ sweepEveryMs: 0 });
    return { s, dir };
}

test("an upload nobody sends is deleted when it expires", async () => {
    const { s, dir } = await store({ ttlMs: 30 });
    const { id } = s.create("me", "a.txt");
    await s.receive(id, req("hello"));
    assert.equal((await readdir(dir)).length, 1);
    await sleep(50);
    await s.sweep();
    assert.equal((await readdir(dir)).length, 0);
    assert.equal(s.heldBytes, 0);
    assert.equal(await s.read("me", id), null);
});

test("a sent upload is deleted at once", async () => {
    const { s, dir } = await store();
    const { id } = s.create("me");
    await s.receive(id, req("bytes"));
    assert.ok(await s.read("me", id));
    await s.done("me", id);
    assert.equal((await readdir(dir)).length, 0);
    assert.equal(s.heldBytes, 0);
});

test("a link never uploaded to is forgotten at expiry, and stops counting toward the cap", async () => {
    const { s } = await store({ ttlMs: 20, maxOpenPerSession: 1 });
    s.create("me");
    assert.throws(() => s.create("me"), /already open/);
    await sleep(40);
    await s.sweep();
    assert.ok(s.create("me").id);
});

test("files the store lost track of are swept by age", async () => {
    const { s, dir } = await store({ orphanAgeMs: 1000 });
    const stray = join(dir, "left-behind");
    await writeFile(stray, "x");
    const old = new Date(Date.now() - 5000);
    await utimes(stray, old, old);
    await writeFile(join(dir, "recent"), "y");
    await s.sweep();
    assert.deepEqual(await readdir(dir), ["recent"]);
});

test("a boot clears whatever the previous process left", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-uploads-"));
    await writeFile(join(dir, "from-last-run"), "x");
    await new UploadStore({ dir }).init({ sweepEveryMs: 0 });
    assert.deepEqual(await readdir(dir), []);
});

test("one file over the per-file cap is refused and leaves nothing on disk", async () => {
    const { s, dir } = await store({ maxUploadBytes: 10 });
    const { id } = s.create("me");
    await assert.rejects(s.receive(id, req("x".repeat(11))), /over/);
    assert.equal((await readdir(dir)).length, 0);
    assert.equal(s.heldBytes, 0);
});

test("the total held on disk is capped across uploads", async () => {
    const { s, dir } = await store({ maxPendingBytes: 15 });
    const a = s.create("me");
    const b = s.create("me");
    await s.receive(a.id, req("x".repeat(10)));
    await assert.rejects(s.receive(b.id, req("y".repeat(10))), /too many files are waiting/);
    assert.equal((await readdir(dir)).length, 1);
    assert.equal(s.heldBytes, 10);
    // Sending the first frees room for the second.
    await s.done("me", a.id);
    await s.receive(b.id, req("y".repeat(10)));
    assert.equal(s.heldBytes, 10);
});

test("an upload belongs to its number and is used once", async () => {
    const { s } = await store();
    const { id } = s.create("me");
    await s.receive(id, req("z"));
    assert.equal(await s.read("someone-else", id), null);
    await assert.rejects(s.receive(id, req("again")), /already been used/);
});

test("images too big for the model are shrunk to fit; small ones are untouched", async () => {
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#123456" } }).jpeg().toBuffer();
    const fit = await fitForModel(big, "image/jpeg");
    const meta = await sharp(fit.data).metadata();
    assert.equal(fit.resized, true);
    assert.equal(Math.max(meta.width, meta.height), MODEL_IMAGE_MAX_EDGE);

    const small = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#123456" } }).png().toBuffer();
    const same = await fitForModel(small, "image/png");
    assert.equal(same.resized, false);
    assert.equal(same.data, small);
    assert.equal(same.mime, "image/png");
});
