import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The OAuth rules that decide security outcomes, kept pure — no config, no
 * I/O — so they are unit-tested directly, the way `jid.ts` is. `oauth.ts`
 * does the storage and HTTP around them.
 */

/**
 * Redirect URIs a public client may register: https anywhere, or http on the
 * loopback (where Claude Code and other local clients listen for the callback).
 * Plain http elsewhere would carry the code in the clear.
 */
export function isAllowedRedirectUri(raw: string): boolean {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return false;
    }
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    return false;
}

/** PKCE S256: base64url(SHA-256(verifier)) must equal the challenge. Constant-time. */
export function pkceMatches(verifier: string, challenge: string): boolean {
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
    const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
    const expected = Buffer.from(challenge);
    return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/** Append OAuth response parameters to a redirect URI, keeping any query it already had. */
export function redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
}

