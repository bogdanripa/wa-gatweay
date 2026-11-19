/**
 * What a file is, from its first bytes — pure, so it is unit-tested directly.
 *
 * Used for files uploaded through an MCP upload link: the client says nothing
 * reliable about them (curl sends whatever content-type it was told to), and
 * WhatsApp needs the right type to show a photo as a photo and a PDF as a PDF.
 * Magic bytes first, then the file name, then the caller's hint.
 */

const EXT_TYPES: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic",
    mp4: "video/mp4", mov: "video/quicktime", "3gp": "video/3gpp",
    mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", aac: "audio/aac",
    pdf: "application/pdf", txt: "text/plain", csv: "text/csv", zip: "application/zip", ics: "text/calendar",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/** Type from content alone, or undefined when the bytes don't say. */
export function sniffMime(head: Uint8Array): string | undefined {
    if (starts(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
    if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
    if (ascii(head, 0, 4) === "GIF8") return "image/gif";
    if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return "image/webp";
    if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WAVE") return "audio/wav";
    if (ascii(head, 0, 5) === "%PDF-") return "application/pdf";
    if (ascii(head, 0, 4) === "OggS") return "audio/ogg";
    if (ascii(head, 0, 3) === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return "audio/mpeg";
    if (ascii(head, 4, 8) === "ftyp") {
        const brand = ascii(head, 8, 12);
        if (/^(heic|heix|mif1|msf1)$/.test(brand)) return "image/heic";
        if (/^M4A/.test(brand)) return "audio/mp4";
        if (brand === "qt  ") return "video/quicktime";
        return "video/mp4";
    }
    return undefined;
}

/** Content wins; then the file name; then the hint; then a plain binary. */
export function resolveMime(head: Uint8Array, filename?: string, hint?: string): string {
    const sniffed = sniffMime(head);
    if (sniffed) return sniffed;
    const ext = String(filename || "").toLowerCase().split(".").pop() || "";
    if (filename && EXT_TYPES[ext]) return EXT_TYPES[ext];
    const h = String(hint || "").split(";")[0].trim().toLowerCase();
    if (/^[a-z]+\/[a-z0-9.+-]+$/.test(h) && h !== "application/octet-stream" && h !== "application/x-www-form-urlencoded") return h;
    return "application/octet-stream";
}

/** How WhatsApp should carry a file of this type when the caller didn't say. */
export function sendKindFor(mime: string): "image" | "video" | "audio" | "document" {
    // HEIC is not something every recipient's phone renders inline; as a
    // document it at least arrives intact.
    if (/^image\/(jpeg|png|webp|gif)$/.test(mime)) return "image";
    if (/^video\/(mp4|quicktime|3gpp)$/.test(mime)) return "video";
    if (mime.startsWith("audio/")) return "audio";
    return "document";
}
