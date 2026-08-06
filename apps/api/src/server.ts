import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { config } from './config.js';
import { currentMonthSummary } from './reports.js';
import { createTelegramBot } from './telegram.js';

const app = Fastify({ logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' } });
const telegramBot = createTelegramBot();
type TelegramUpdate = Parameters<typeof telegramBot.handleUpdate>[0];

function hasValidWebhookSecret(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(config.TELEGRAM_WEBHOOK_SECRET);
  const received = Buffer.from(candidate);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

app.get('/health', async () => ({ status: 'ok' }));

app.post<{ Params: { telegramUserId: string } }>('/internal/reports/monthly/:telegramUserId', async (request, reply) => {
  if (request.headers['x-internal-cron-secret'] !== config.INTERNAL_CRON_SECRET) return reply.code(401).send({ error: 'unauthorized' });
  return { summary: await currentMonthSummary(request.params.telegramUserId) };
});

app.post<{ Body: unknown }>('/api/telegram/webhook', async (request, reply) => {
  const secret = request.headers['x-telegram-bot-api-secret-token'];
  if (typeof secret !== 'string' || !hasValidWebhookSecret(secret)) {
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
