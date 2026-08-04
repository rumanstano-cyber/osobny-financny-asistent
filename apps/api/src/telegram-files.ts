import { config } from './config.js';

export async function downloadTelegramFile(fileId: string): Promise<{ bytes: Buffer; path: string }> {
  const fileResponse = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const fileJson = await fileResponse.json() as { ok: boolean; result?: { file_path: string } };
  if (!fileJson.ok || !fileJson.result?.file_path) throw new Error('Telegram file metadata unavailable');
  const content = await fetch(`https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${fileJson.result.file_path}`);
  if (!content.ok) throw new Error('Telegram file download failed');
  return { bytes: Buffer.from(await content.arrayBuffer()), path: fileJson.result.file_path };
}
