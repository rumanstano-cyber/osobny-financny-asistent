export const MAX_RECEIPT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VOICE_BYTES = 20 * 1024 * 1024;
export const MAX_VOICE_DURATION_SECONDS = 5 * 60;

export function receiptImageIsWithinLimits(fileSize: number | undefined): boolean {
  return fileSize === undefined || (Number.isSafeInteger(fileSize) && fileSize >= 0 && fileSize <= MAX_RECEIPT_IMAGE_BYTES);
}

export function voiceIsWithinLimits(fileSize: number | undefined, durationSeconds: number | undefined): boolean {
  const sizeIsValid = fileSize === undefined
    || (Number.isSafeInteger(fileSize) && fileSize >= 0 && fileSize <= MAX_VOICE_BYTES);
  const durationIsValid = durationSeconds === undefined
    || (Number.isSafeInteger(durationSeconds) && durationSeconds >= 0 && durationSeconds <= MAX_VOICE_DURATION_SECONDS);
  return sizeIsValid && durationIsValid;
}
