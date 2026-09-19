import { config } from './config.js';

export class TelegramFileDownloadError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'TelegramFileDownloadError';
  }
}

export async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new TelegramFileDownloadError('Telegram file exceeds the allowed size', false);
  }
  if (!response.body) throw new TelegramFileDownloadError('Telegram file response has no body', true);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TelegramFileDownloadError('Telegram file exceeds the allowed size', false);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new TelegramFileDownloadError('Telegram returned an empty file', false);
  return Buffer.concat(chunks, total);
}

export async function downloadTelegramFile(fileId: string, maxBytes: number): Promise<{ bytes: Buffer; path: string }> {
  if (!fileId || fileId.length > 512) throw new TelegramFileDownloadError('Telegram file identifier is invalid', false);
  let fileResponse: Response;
  try {
    fileResponse = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new TelegramFileDownloadError('Telegram file metadata request failed', true);
  }
  if (!fileResponse.ok) throw new TelegramFileDownloadError('Telegram file metadata unavailable', fileResponse.status >= 500);
  const fileJson = await fileResponse.json() as { ok: boolean; result?: { file_path: string } };
  if (!fileJson.ok || !fileJson.result?.file_path) throw new TelegramFileDownloadError('Telegram file metadata unavailable', false);
  if (!/^[A-Za-z0-9_./-]{1,512}$/u.test(fileJson.result.file_path) || fileJson.result.file_path.includes('..')) {
    throw new TelegramFileDownloadError('Telegram returned an invalid file path', false);
  }
  let content: Response;
  try {
    content = await fetch(`https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${fileJson.result.file_path}`, {
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new TelegramFileDownloadError('Telegram file download timed out', true);
  }
  if (!content.ok) throw new TelegramFileDownloadError('Telegram file download failed', content.status >= 500);
  return { bytes: await readBoundedBody(content, maxBytes), path: fileJson.result.file_path };
}
