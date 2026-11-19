import { test } from "node:test";
import assert from "node:assert/strict";

import { isAllowedRedirectUri, pkceMatches, redirectWith } from "../dist/oauthRules.js";

/**
 * The OAuth rules that decide security outcomes. PKCE is checked against the
 * worked example in RFC 7636 Appendix B, not against our own output.
 */

test("PKCE S256 accepts RFC 7636's worked example", () => {
    assert.equal(
        pkceMatches("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"),
        true
    );
});

test("PKCE rejects a wrong verifier, a malformed one, and a missing challenge", () => {
    const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    assert.equal(pkceMatches("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXl", challenge), false);
    // Too short for RFC 7636 (43-128 chars), whatever it hashes to.
    assert.equal(pkceMatches("short", challenge), false);
    // Outside the unreserved character set.
    assert.equal(pkceMatches("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEj/k", challenge), false);
    assert.equal(pkceMatches("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", ""), false);
});

test("redirect URIs: https anywhere, http only on loopback, no fragments", () => {
    assert.equal(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback"), true);
    assert.equal(isAllowedRedirectUri("http://localhost:33418/callback"), true);
    assert.equal(isAllowedRedirectUri("http://127.0.0.1:9000/cb"), true);
    assert.equal(isAllowedRedirectUri("http://[::1]:9000/cb"), true);
    assert.equal(isAllowedRedirectUri("http://evil.example/cb"), false);
    assert.equal(isAllowedRedirectUri("https://app.example/cb#frag"), false);
    assert.equal(isAllowedRedirectUri("javascript:alert(1)"), false);
    assert.equal(isAllowedRedirectUri("not a url"), false);
});

test("response parameters are appended, keeping the client's own query", () => {
    const u = new URL(redirectWith("https://app.example/cb?keep=1", { code: "abc", state: "x y", iss: undefined }));
    assert.equal(u.searchParams.get("keep"), "1");
    assert.equal(u.searchParams.get("code"), "abc");
    assert.equal(u.searchParams.get("state"), "x y");
    assert.equal(u.searchParams.has("iss"), false);
});
