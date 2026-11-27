import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import express from "express";

process.env.WA_MONGO_URL ||= "mongodb://127.0.0.1:1/unused";

const { makeMcpRouter } = await import("../dist/mcp.js");

test("MCP prepare_upload single-quote escapes filename so shell metacharacters cannot execute", async () => {
    const fakeSession = { id: "s1", displayPhoneNumber: "15550001111" };
    const fakeManager = { byTokenOrNull: () => null };
    const fakeOauth = { sessionForAccessToken: async () => fakeSession };
    const fakeUploads = {
        create: (_sid, _filename) => ({ id: "up-1", url: "https://gw.example/api/upload/up-1" }),
    };

    const app = express();
    app.use(express.json());
    app.use(makeMcpRouter(fakeManager, fakeOauth, fakeUploads));
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${srv.address().port}`;

    try {
        const payloads = [
            "$(echo PWNED)",
            "`echo PWNED`",
            "$HOME/secret.txt",
            "a'b$(echo PWNED).jpg",
            'file"$(echo PWNED).pdf',
        ];

        for (const filename of payloads) {
            const res = await fetch(`${base}/mcp`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    accept: "application/json, text/event-stream",
                    authorization: "Bearer tok",
                },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/call",
                    params: { name: "prepare_upload", arguments: { filename } },
                }),
            });
            assert.equal(res.status, 200);
            const json = await res.json();
            const outText = json?.result?.content?.[0]?.text || "";
            const curlLine = outText.split("\n").find((l) => l.startsWith("curl "));
            assert.ok(curlLine, `Expected curl line in response: ${outText}`);

            // Extract the --data-binary @<arg> portion before the URL
            const m = /--data-binary @(.+) 'https:\/\/gw\.example\/api\/upload\/up-1'$/.exec(curlLine);
            assert.ok(m, `Unexpected curl line format: ${curlLine}`);
            const arg = m[1];

            // Must be single-quoted, never double-quoted
            assert.ok(arg.startsWith("'") && arg.endsWith("'"), `Expected single-quoted arg, got: ${arg}`);

            // Verify in a real POSIX shell that evaluating the arg produces the literal filename without expansion
            const evaluated = execFileSync("sh", ["-c", `printf '%s' ${arg}`], { encoding: "utf8" });
            assert.equal(evaluated, filename);
        }
    } finally {
        srv.close();
    }
});
