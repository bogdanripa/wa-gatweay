import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import type { LookupAddress } from "node:dns";
import { CloudRequestError } from "./cloud.js";

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 3;

function isBlockedIpv4Parts(a: number, b: number, c: number): boolean {
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a === 127) return true; // 127.0.0.0/8 (loopback)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
    if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
    if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
    if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
    if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved/broadcast
    return false;
}

function parseIpv6Groups(ip: string): number[] | null {
    // Handle embedded IPv4 suffix (e.g. ::ffff:127.0.0.1)
    let work = ip;
    const lastColon = work.lastIndexOf(":");
    const dot = work.indexOf(".", lastColon + 1);
    if (dot !== -1) {
        const v4Part = work.slice(lastColon + 1);
        if (net.isIPv4(v4Part) === false) return null;
        const octets = v4Part.split(".").map(Number);
        const hi = ((octets[0] << 8) | octets[1]).toString(16);
        const lo = ((octets[2] << 8) | octets[3]).toString(16);
        work = `${work.slice(0, lastColon + 1)}${hi}:${lo}`;
    }

    const halves = work.split("::");
    if (halves.length > 2) return null;

    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

    if (halves.length === 1 && left.length !== 8) return null;
    if (halves.length === 2 && left.length + right.length >= 8) return null;

    const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
    const parts = [...left, ...Array<string>(zeros).fill("0"), ...right];
    if (parts.length !== 8) return null;

    const groups: number[] = [];
    for (const p of parts) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
        groups.push(parseInt(p, 16));
    }
    return groups;
}

/**
 * Returns true if the given IP address is loopback, private, link-local,
 * CGNAT, ULA, multicast, unspecified, or unparseable.
 */
export function isBlockedIp(rawIp: string): boolean {
    const ip = rawIp.split("%")[0].trim();
    const kind = net.isIP(ip);
    if (kind === 4) {
        const [a, b, c] = ip.split(".").map(Number);
        return isBlockedIpv4Parts(a, b, c);
    }
    if (kind === 6) {
        const g = parseIpv6Groups(ip);
        if (!g) return true;
        // :: (unspecified) and ::1 (loopback)
        const allZeroPrefix = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
        if (allZeroPrefix && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true;
        // ::ffff:0:0/96 (IPv4-mapped IPv6)
        if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
            return isBlockedIpv4Parts((g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff);
        }
        // 64:ff9b::/96 (NAT64)
        if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
            return isBlockedIpv4Parts((g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff);
        }
        // 100::/64 (discard)
        if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;
        // fc00::/7 (ULA)
        if ((g[0] & 0xfe00) === 0xfc00) return true;
        // fe80::/10 (link-local)
        if ((g[0] & 0xffc0) === 0xfe80) return true;
        // ff00::/8 (multicast)
        if ((g[0] & 0xff00) === 0xff00) return true;
        return false;
    }
    return true;
}

export type LookupFn = (hostname: string, options: { all: true }) => Promise<LookupAddress[]>;

export async function validateMediaUrl(
    rawUrl: string,
    lookupFn: LookupFn = (h, o) => dns.lookup(h, o)
): Promise<{ url: URL; addresses: LookupAddress[] }> {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new CloudRequestError("(#100) Invalid media URL", 100, "Media URL is not a valid URL.");
    }

    if (url.protocol !== "https:") {
        throw new CloudRequestError(
            "(#100) Invalid media URL protocol",
            100,
            "Only https:// media URLs are allowed."
        );
    }

    if (url.username || url.password) {
        throw new CloudRequestError("(#100) Invalid media URL", 100, "Credentials in media URLs are not allowed.");
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
        throw new CloudRequestError("(#100) Media URL host is not allowed", 100, "Refusing loopback or local media URL.");
    }

    const ipKind = net.isIP(hostname);
    if (ipKind !== 0) {
        if (isBlockedIp(hostname)) {
            throw new CloudRequestError(
                "(#100) Media URL IP is blocked",
                100,
                "Refusing private, loopback, or link-local media URL."
            );
        }
        return { url, addresses: [{ address: hostname, family: ipKind }] };
    }

    let addresses: LookupAddress[];
    try {
        addresses = await lookupFn(hostname, { all: true });
    } catch {
        throw new CloudRequestError("(#100) Media URL host could not be resolved", 100, "DNS lookup failed.");
    }

    if (!addresses || addresses.length === 0 || addresses.some((a) => isBlockedIp(a.address))) {
        throw new CloudRequestError(
            "(#100) Media URL resolves to a blocked IP",
            100,
            "Refusing media URL resolving to private, loopback, or link-local address."
        );
    }

    return { url, addresses };
}

export interface SafeFetchOptions {
    maxBytes?: number;
    timeoutMs?: number;
    maxRedirects?: number;
    lookup?: LookupFn;
}

export interface SafeFetchResponse {
    /** The URL that answered, after redirects. */
    url: string;
    contentType: string;
    body: Buffer;
}

export async function fetchSafeMedia(rawUrl: string, opts: SafeFetchOptions = {}): Promise<Buffer> {
    return (await fetchSafe(rawUrl, opts)).body;
}

/** GET over https with every hop's address checked and pinned (see validateMediaUrl). */
export async function fetchSafe(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

    let currentUrl = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
        const { url, addresses } = await validateMediaUrl(currentUrl, opts.lookup);
        const chosen = addresses[0];

        const result = await new Promise<{ status: number; location?: string; contentType?: string; body?: Buffer }>((resolve, reject) => {
            const req = https.request(
                url,
                {
                    method: "GET",
                    timeout: timeoutMs,
                    lookup: (_host, _opts, cb: any) => {
                        if (_opts && typeof _opts === "object" && _opts.all) {
                            cb(null, addresses);
                        } else {
                            cb(null, chosen.address, chosen.family);
                        }
                    },
                },
                (res) => {
                    const status = res.statusCode ?? 0;
                    if (status >= 300 && status < 400 && res.headers.location) {
                        res.resume();
                        resolve({ status, location: res.headers.location });
                        return;
                    }
                    if (status < 200 || status >= 300) {
                        res.resume();
                        reject(new CloudRequestError(`(#100) Media fetch failed with HTTP ${status}`, 100));
                        return;
                    }

                    const chunks: Buffer[] = [];
                    let total = 0;
                    res.on("data", (chunk: Buffer) => {
                        total += chunk.length;
                        if (total > maxBytes) {
                            req.destroy(new CloudRequestError("(#100) Media exceeds maximum allowed size", 100));
                            return;
                        }
                        chunks.push(chunk);
                    });
                    res.on("end", () => resolve({ status, contentType: res.headers["content-type"], body: Buffer.concat(chunks) }));
                    res.on("error", reject);
                }
            );
            req.on("timeout", () => {
                req.destroy(new CloudRequestError("(#100) Media fetch timed out", 100));
            });
            req.on("error", reject);
            req.end();
        });

        if (result.location) {
            currentUrl = new URL(result.location, url).toString();
            continue;
        }
        return { url: url.toString(), contentType: result.contentType ?? "", body: result.body ?? Buffer.alloc(0) };
    }

    throw new CloudRequestError("(#100) Too many redirects fetching media URL", 100);
}
