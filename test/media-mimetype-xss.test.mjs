import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WA_MONGO_URL ||= "mongodb://127.0.0.1:1/unused";

const { makeGatewayRouter } = await import("../dist/routes.js");

test("/media/:id refuses active content mimetypes (text/html, image/svg+xml) and sets nosniff, CSP, and attachment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-cand002-"));
    const htmlPath = join(dir, "payload.bin");
    const svgPath = join(dir, "payload.svg");
    const pngPath = join(dir, "valid.png");
    writeFileSync(htmlPath, "<script>alert(localStorage.getItem('wa-gateway:key'))</script>");
    writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));

    const docs = {
        html: { path: htmlPath, mimetype: "text/html" },
        svg: { path: svgPath, mimetype: "image/svg+xml" },
        png: { path: pngPath, mimetype: "text/html" },
    };

    const fakeManager = { ready: () => ({ ok: true }) };
    const fakeMedia = { get: async (id) => docs[id] ?? null };

    const app = express();
    app.use(makeGatewayRouter(fakeManager, fakeMedia));
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${srv.address().port}`;

    try {
        for (const id of ["html", "svg"]) {
            const res = await fetch(`${base}/media/${id}`);
            assert.equal(res.status, 200);
            assert.equal(res.headers.get("content-type"), "application/octet-stream");
            assert.equal(res.headers.get("x-content-type-options"), "nosniff");
            assert.match(res.headers.get("content-security-policy") || "", /default-src\s+'none'/i);
            assert.match(res.headers.get("content-security-policy") || "", /sandbox/i);
            assert.match(res.headers.get("content-disposition") || "", /attachment/i);
        }

        const pngRes = await fetch(`${base}/media/png`);
        assert.equal(pngRes.status, 200);
        assert.equal(pngRes.headers.get("content-type"), "image/png");
        assert.equal(pngRes.headers.get("x-content-type-options"), "nosniff");
        assert.match(pngRes.headers.get("content-security-policy") || "", /default-src\s+'none'/i);
    } finally {
        srv.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
