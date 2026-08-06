import Fastify from 'fastify';
import { config } from './config.js';
import { currentMonthSummary } from './reports.js';
import { createTelegramBot } from './telegram.js';

const app = Fastify({ logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' } });
const telegramBot = createTelegramBot();
type TelegramUpdate = Parameters<typeof telegramBot.handleUpdate>[0];
let telegramBotInitialization: Promise<unknown> | undefined;

async function ensureTelegramBotInitialized(): Promise<void> {
  if (telegramBot.botInfo) return;
  telegramBotInitialization ??= telegramBot.init();
  try {
    await telegramBotInitialization;
  } catch (error) {
    telegramBotInitialization = undefined;
    throw error;
  }
}

app.get('/health', async () => ({ status: 'ok' }));

app.post<{ Params: { telegramUserId: string } }>('/internal/reports/monthly/:telegramUserId', async (request, reply) => {
  if (request.headers['x-internal-cron-secret'] !== config.INTERNAL_CRON_SECRET) return reply.code(401).send({ error: 'unauthorized' });
  return { summary: await currentMonthSummary(request.params.telegramUserId) };
});

app.post<{ Body: unknown }>('/api/telegram/webhook', async (request, reply) => {
  await ensureTelegramBotInitialized();
  await telegramBot.handleUpdate(request.body as TelegramUpdate);
  return reply.code(200).send({ ok: true });
});

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
