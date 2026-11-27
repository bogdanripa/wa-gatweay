import { extractImageThumb, extractUrlFromText, type WAUrlInfo } from "baileys";
import { getPreviewFromContent } from "link-preview-js";
import { fetchSafe, fetchSafeMedia, type LookupFn } from "./ssrf.js";

// Baileys' own defaults for the preview it would otherwise build.
const THUMBNAIL_WIDTH_PX = 192;
const FETCH_TIMEOUT_MS = 3000;
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const THUMBNAIL_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The link preview for an outgoing text, built here rather than by Baileys.
 *
 * Baileys fetches the linked page and its thumbnail image without checking
 * where either resolves, so any text a client sends could make this container
 * fetch loopback, LAN or cloud-metadata URLs. Here both fetches go through
 * ssrf.ts (https only, every hop's address checked and pinned), and
 * link-preview-js only parses the page that came back.
 *
 * Returns null when there is no link or no safe preview, so callers can pass
 * the result straight to Baileys as `linkPreview` (null stops Baileys from
 * building its own).
 */
export async function safeLinkPreview(text: string, lookup?: LookupFn): Promise<WAUrlInfo | null> {
    const matched = extractUrlFromText(text);
    if (!matched) return null;
    const url = /^https?:\/\//i.test(matched) ? matched : `https://${matched}`;

    const page = await fetchSafe(url, { maxBytes: PAGE_MAX_BYTES, timeoutMs: FETCH_TIMEOUT_MS, lookup }).catch(() => null);
    if (!page || !page.contentType.includes("text/html")) return null;

    const info = await getPreviewFromContent({
        url: page.url,
        headers: { "content-type": page.contentType },
        data: page.body.toString("utf8"),
    }).catch(() => null);
    if (!info || !("title" in info) || !info.title) return null;

    const image = info.images[0];
    let jpegThumbnail: Buffer | undefined;
    if (image) {
        try {
            const bytes = await fetchSafeMedia(image, { maxBytes: THUMBNAIL_MAX_BYTES, timeoutMs: FETCH_TIMEOUT_MS, lookup });
            jpegThumbnail = (await extractImageThumb(bytes, THUMBNAIL_WIDTH_PX)).buffer;
        } catch {
            // A preview without a thumbnail is still a preview.
        }
    }

    return {
        "canonical-url": info.url,
        "matched-text": matched,
        title: info.title,
        description: info.description,
        originalThumbnailUrl: image,
        jpegThumbnail,
    };
}
