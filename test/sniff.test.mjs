import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveMime, sendKindFor, sniffMime } from "../dist/sniff.js";

/** File types for MCP uploads, from magic bytes as each format's spec defines them. */

const bytes = (...xs) => Uint8Array.from(xs.flatMap((x) => (typeof x === "string" ? [...x].map((c) => c.charCodeAt(0)) : [x])));

test("magic bytes identify the common photo, video, audio and document formats", () => {
    assert.equal(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
    assert.equal(sniffMime(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a)), "image/png");
    assert.equal(sniffMime(bytes("GIF89a")), "image/gif");
    assert.equal(sniffMime(bytes("RIFF", 0, 0, 0, 0, "WEBP")), "image/webp");
    assert.equal(sniffMime(bytes("%PDF-1.7")), "application/pdf");
    assert.equal(sniffMime(bytes(0, 0, 0, 0x18, "ftypisom")), "video/mp4");
    assert.equal(sniffMime(bytes(0, 0, 0, 0x18, "ftypqt  ")), "video/quicktime");
    assert.equal(sniffMime(bytes(0, 0, 0, 0x18, "ftypheic")), "image/heic");
    assert.equal(sniffMime(bytes(0, 0, 0, 0x18, "ftypM4A ")), "audio/mp4");
    assert.equal(sniffMime(bytes("OggS")), "audio/ogg");
    assert.equal(sniffMime(bytes("ID3")), "audio/mpeg");
    assert.equal(sniffMime(bytes("hello")), undefined);
});

test("content beats the file name, the name beats the hint, curl's default type is ignored", () => {
    assert.equal(resolveMime(bytes(0xff, 0xd8, 0xff), "photo.png", "text/plain"), "image/jpeg");
    assert.equal(resolveMime(bytes("PK", 3, 4), "report.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    assert.equal(resolveMime(bytes("abc"), undefined, "text/csv; charset=utf-8"), "text/csv");
    assert.equal(resolveMime(bytes("abc"), undefined, "application/x-www-form-urlencoded"), "application/octet-stream");
    assert.equal(resolveMime(bytes("abc")), "application/octet-stream");
});

test("photos go as images, HEIC and unknowns as documents", () => {
    assert.equal(sendKindFor("image/jpeg"), "image");
    assert.equal(sendKindFor("image/png"), "image");
    assert.equal(sendKindFor("image/heic"), "document");
    assert.equal(sendKindFor("video/mp4"), "video");
    assert.equal(sendKindFor("audio/mpeg"), "audio");
    assert.equal(sendKindFor("application/pdf"), "document");
});
