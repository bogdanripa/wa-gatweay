import sharp from "sharp";

/**
 * Claude refuses an image over 5 MB and downsamples anything past ~1568 px on
 * the long edge anyway, so a bigger one costs bytes for nothing. Images over
 * either line are re-encoded to fit before they go back to the model.
 */
export const MODEL_IMAGE_MAX_BYTES = 3_500_000;
export const MODEL_IMAGE_MAX_EDGE = 1568;

export async function fitForModel(data: Buffer, mime: string): Promise<{ data: Buffer; mime: string; resized: boolean }> {
    const meta = await sharp(data).metadata().catch(() => null);
    const edge = Math.max(meta?.width || 0, meta?.height || 0);
    if (data.length <= MODEL_IMAGE_MAX_BYTES && edge <= MODEL_IMAGE_MAX_EDGE) return { data, mime, resized: false };
    const out = await sharp(data)
        .rotate() // honour EXIF orientation before the metadata is dropped
        .resize({ width: MODEL_IMAGE_MAX_EDGE, height: MODEL_IMAGE_MAX_EDGE, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
    return { data: out, mime: "image/jpeg", resized: true };
}
