import { Jimp, JimpMime } from 'jimp';

const MAX_RECEIPT_IMAGE_SIDE_PX = 12_000;
const MAX_RECEIPT_IMAGE_PIXELS = 24_000_000;
const MAX_STORED_RECEIPT_SIDE_PX = 1600;
const RECEIPT_JPEG_QUALITY = 78;

export class InvalidReceiptImageError extends Error {
  readonly code = 'invalid_receipt_image';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidReceiptImageError';
  }
}

export type ReceiptImageMetadata = {
  format: 'jpeg' | 'png';
  width: number;
  height: number;
};

export type OptimizedReceiptImage = {
  bytes: Buffer;
  width: number;
  height: number;
  optimized: boolean;
};

function jpegDimensions(source: Buffer): { width: number; height: number } | null {
  if (source.length < 4 || source[0] !== 0xff || source[1] !== 0xd8) return null;
  if (source[source.length - 2] !== 0xff || source[source.length - 1] !== 0xd9) {
    throw new InvalidReceiptImageError('Receipt JPEG is truncated');
  }
  let offset = 2;
  while (offset + 4 <= source.length) {
    while (offset < source.length && source[offset] === 0xff) offset += 1;
    if (offset >= source.length) break;
    const marker = source[offset++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;
    if (offset + 2 > source.length) break;
    const length = source.readUInt16BE(offset);
    if (length < 2 || offset + length > source.length) throw new InvalidReceiptImageError('Receipt JPEG has an invalid segment');
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) throw new InvalidReceiptImageError('Receipt JPEG dimensions are invalid');
      return { height: source.readUInt16BE(offset + 3), width: source.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  throw new InvalidReceiptImageError('Receipt JPEG dimensions were not found');
}

function pngDimensions(source: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (source.length < 33 || !source.subarray(0, 8).equals(signature)) return null;
  if (source.toString('ascii', 12, 16) !== 'IHDR') throw new InvalidReceiptImageError('Receipt PNG header is invalid');
  const hasEndChunk = source.length >= 12 && source.toString('ascii', source.length - 8, source.length - 4) === 'IEND';
  if (!hasEndChunk) throw new InvalidReceiptImageError('Receipt PNG is truncated');
  return { width: source.readUInt32BE(16), height: source.readUInt32BE(20) };
}

export function inspectReceiptImage(source: Buffer): ReceiptImageMetadata {
  if (source.length < 64) throw new InvalidReceiptImageError('Receipt image is empty or too small');
  const jpeg = jpegDimensions(source);
  const png = jpeg ? null : pngDimensions(source);
  const dimensions = jpeg ?? png;
  const format = jpeg ? 'jpeg' : png ? 'png' : null;
  if (!dimensions || !format) throw new InvalidReceiptImageError('Receipt image format is not supported');
  const { width, height } = dimensions;
  if (!width || !height || width > MAX_RECEIPT_IMAGE_SIDE_PX || height > MAX_RECEIPT_IMAGE_SIDE_PX) {
    throw new InvalidReceiptImageError('Receipt image dimensions are outside the allowed range');
  }
  if (width * height > MAX_RECEIPT_IMAGE_PIXELS) throw new InvalidReceiptImageError('Receipt image exceeds the safe pixel limit');
  return { format, width, height };
}

/** Validates before decoding, then creates the single JPEG used by Storage and OCR. */
export async function optimizeReceiptImage(source: Buffer): Promise<OptimizedReceiptImage> {
  inspectReceiptImage(source);
  try {
    const image = await Jimp.read(source);
    const longestSide = Math.max(image.bitmap.width, image.bitmap.height);
    if (longestSide > MAX_STORED_RECEIPT_SIDE_PX) {
      if (image.bitmap.width >= image.bitmap.height) image.resize({ w: MAX_STORED_RECEIPT_SIDE_PX });
      else image.resize({ h: MAX_STORED_RECEIPT_SIDE_PX });
    }
    const bytes = await image.getBuffer(JimpMime.jpeg, { quality: RECEIPT_JPEG_QUALITY });
    if (!bytes.length) throw new InvalidReceiptImageError('Receipt image encoder returned an empty image');
    return { bytes, width: image.bitmap.width, height: image.bitmap.height, optimized: true };
  } catch (error) {
    if (error instanceof InvalidReceiptImageError) throw error;
    throw new InvalidReceiptImageError(`Receipt image could not be decoded: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}
