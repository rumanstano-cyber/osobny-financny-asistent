const baseUrl = process.env.BASE_URL?.replace(/\/$/, '');
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!baseUrl || !token) throw new Error('BASE_URL and TELEGRAM_BOT_TOKEN are required');
if (!baseUrl.startsWith('https://')) throw new Error('BASE_URL must be a public HTTPS URL');
let response;
try {
  response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `${baseUrl}/api/telegram/webhook`, ...(secret ? { secret_token: secret } : {}), allowed_updates: ['message'] }) });
} catch {
  throw new Error('Telegram setWebhook request failed');
}
if (!response.ok) throw new Error(`Telegram setWebhook returned HTTP ${response.status}`);
console.log('Telegram webhook configured.');
