import { Jimp, JimpMime } from 'jimp';

const MAX_RECEIPT_IMAGE_SIDE_PX = 1600;
const RECEIPT_JPEG_QUALITY = 78;

export type OptimizedReceiptImage = {
  bytes: Buffer;
  width: number;
  height: number;
  optimized: boolean;
};

/**
 * Creates the single JPEG version that is persisted and sent to QR/OCR providers.
 * Telegram photos are normally JPEGs, but re-encoding also makes the pipeline
 * predictable when Telegram supplies another supported image format.
 */
export async function optimizeReceiptImage(source: Buffer): Promise<OptimizedReceiptImage> {
  try {
    const image = await Jimp.read(source);
    const longestSide = Math.max(image.bitmap.width, image.bitmap.height);

    if (!image.bitmap.width || !image.bitmap.height) {
      throw new Error('Receipt image has invalid dimensions');
    }

    if (longestSide > MAX_RECEIPT_IMAGE_SIDE_PX) {
      if (image.bitmap.width >= image.bitmap.height) {
        image.resize({ w: MAX_RECEIPT_IMAGE_SIDE_PX });
      } else {
        image.resize({ h: MAX_RECEIPT_IMAGE_SIDE_PX });
      }
    }

    const bytes = await image.getBuffer(JimpMime.jpeg, { quality: RECEIPT_JPEG_QUALITY });
    console.info('Receipt image optimized', {
      sourceBytes: source.length,
      storedBytes: bytes.length,
      width: image.bitmap.width,
      height: image.bitmap.height,
      quality: RECEIPT_JPEG_QUALITY,
    });

    return {
      bytes,
      width: image.bitmap.width,
      height: image.bitmap.height,
      optimized: true,
    };
  } catch (error) {
    // A failure to optimize must never prevent receipt storage and OCR. Telegram
    // supplies JPEG photos, so this is only a defensive fallback for malformed input.
    console.warn('Receipt image optimization failed; using original image', {
      error: error instanceof Error ? error.message : String(error),
      sourceBytes: source.length,
    });
    return { bytes: source, width: 0, height: 0, optimized: false };
  }
}
