const baseUrl = process.env.WEBHOOK_PUBLIC_URL?.replace(/\/$/, '');
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!baseUrl || !token || !secret) throw new Error('WEBHOOK_PUBLIC_URL, TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET are required');
const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: `${baseUrl}/webhooks/telegram`, secret_token: secret, allowed_updates: ['message'] }) });
if (!response.ok) throw new Error(await response.text());
console.log('Telegram webhook configured.');
