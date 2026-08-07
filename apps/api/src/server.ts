import Fastify from 'fastify';
import { config } from './config.js';
import { startMonthlyReportScheduler } from './monthly-report-scheduler.js';
import { currentMonthSummary, sendMonthlyReports } from './reports.js';
import { createTelegramBot } from './telegram.js';

const app = Fastify({ logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' } });
const telegramBot = createTelegramBot();
await telegramBot.init();
startMonthlyReportScheduler(telegramBot);
type TelegramUpdate = Parameters<typeof telegramBot.handleUpdate>[0];

app.get('/health', async () => ({ status: 'ok' }));

app.post<{ Params: { telegramUserId: string } }>('/internal/reports/monthly/:telegramUserId', async (request, reply) => {
  if (request.headers['x-internal-cron-secret'] !== config.INTERNAL_CRON_SECRET) return reply.code(401).send({ error: 'unauthorized' });
  return { summary: await currentMonthSummary(request.params.telegramUserId) };
});

app.post('/internal/reports/monthly/run', async (request, reply) => {
  if (request.headers['x-internal-cron-secret'] !== config.INTERNAL_CRON_SECRET) return reply.code(401).send({ error: 'unauthorized' });
  return sendMonthlyReports(telegramBot);
});

app.post<{ Body: unknown }>('/api/telegram/webhook', async (request, reply) => {
  // Acknowledge the update before any OCR, AI, or database work. Telegram must
  // never retry an update just because downstream processing failed or was slow.
  reply.code(200).send({ ok: true });

  try {
    void telegramBot.handleUpdate(request.body as TelegramUpdate).catch((error: unknown) => {
      app.log.error({ error }, 'Telegram update processing failed after acknowledgement');
    });
  } catch (error) {
    // Protect against a synchronous failure while scheduling the bot middleware.
    app.log.error({ error }, 'Telegram update could not be scheduled');
  }
});

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
