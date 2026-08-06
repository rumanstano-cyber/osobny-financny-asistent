import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { config } from './config.js';
import { currentMonthSummary } from './reports.js';
import { createTelegramBot } from './telegram.js';

const app = Fastify({ logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' } });
const telegramBot = createTelegramBot();
type TelegramUpdate = Parameters<typeof telegramBot.handleUpdate>[0];

function verifyWebhookSecret(candidate: string | string[] | undefined): { valid: boolean; reason?: string } {
  if (!config.TELEGRAM_WEBHOOK_SECRET) {
    return { valid: false, reason: 'missing TELEGRAM_WEBHOOK_SECRET environment variable' };
  }
  if (typeof candidate === 'undefined') {
    return { valid: false, reason: 'missing X-Telegram-Bot-Api-Secret-Token header' };
  }
  if (Array.isArray(candidate)) {
    return { valid: false, reason: 'multiple X-Telegram-Bot-Api-Secret-Token header values received' };
  }
  const expected = Buffer.from(config.TELEGRAM_WEBHOOK_SECRET);
  const received = Buffer.from(candidate);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { valid: false, reason: 'X-Telegram-Bot-Api-Secret-Token does not match TELEGRAM_WEBHOOK_SECRET' };
  }
  return { valid: true };
}

app.get('/health', async () => ({ status: 'ok' }));

app.post<{ Params: { telegramUserId: string } }>('/internal/reports/monthly/:telegramUserId', async (request, reply) => {
  if (request.headers['x-internal-cron-secret'] !== config.INTERNAL_CRON_SECRET) return reply.code(401).send({ error: 'unauthorized' });
  return { summary: await currentMonthSummary(request.params.telegramUserId) };
});

app.post<{ Body: unknown }>('/api/telegram/webhook', async (request, reply) => {
  const secret = request.headers['x-telegram-bot-api-secret-token'];
  const verification = verifyWebhookSecret(secret);
  if (!verification.valid) {
    console.log('Telegram webhook authentication rejected', {
      reason: verification.reason,
      requestId: request.id,
    });
    return reply.code(401).send({ error: 'unauthorized' });
  }

  await telegramBot.handleUpdate(request.body as TelegramUpdate);
  return reply.code(200).send({ ok: true });
});

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
