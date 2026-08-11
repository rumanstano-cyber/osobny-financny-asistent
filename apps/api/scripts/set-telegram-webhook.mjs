const baseUrl = process.env.BASE_URL?.replace(/\/$/, '');
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!baseUrl || !token) throw new Error('BASE_URL and TELEGRAM_BOT_TOKEN are required');
if (!baseUrl.startsWith('https://')) throw new Error('BASE_URL must be a public HTTPS URL');
const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `${baseUrl}/api/telegram/webhook`, ...(secret ? { secret_token: secret } : {}), allowed_updates: ['message'] }) });
if (!response.ok) throw new Error(await response.text());
console.log('Telegram webhook configured.');
