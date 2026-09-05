import Fastify from 'fastify';
import { config } from './config.js';
import { currentMonthSummary, previousClosedMonthReference, sendMonthlyReports, sendWeeklyReports } from './reports.js';
import { createTelegramBot } from './telegram.js';
import { previousClosedWeekReference, startWeeklyReportScheduler } from './weekly-report-scheduler.js';

const app = Fastify({ logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug' } });
const telegramBot = createTelegramBot();
type TelegramUpdate = Parameters<typeof telegramBot.handleUpdate>[0];

let telegramInitialization: Promise<void> | null = null;
let reportSchedulersStarted = false;

/**
 * Telegram's getMe call is external I/O. Do not let a temporary Telegram
 * outage or a Render secret mistake prevent the web service from listening on
 * its assigned port. Failed attempts are retried by the first webhook update.
 */
async function ensureTelegramBotInitialized(): Promise<void> {
  if (!telegramInitialization) {
    telegramInitialization = telegramBot.init().catch((error: unknown) => {
      telegramInitialization = null;
      throw error;
    });
  }
  await telegramInitialization;
}

function startSchedulerOnce(): void {
  if (reportSchedulersStarted) return;
  startWeeklyReportScheduler(telegramBot);
  reportSchedulersStarted = true;
}

function isAllowedCorsOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const isRenderDomain = url.protocol === 'https:' && url.hostname.endsWith('.onrender.com');
    return isRenderDomain || (isLocalhost && (url.protocol === 'http:' || url.protocol === 'https:'));
  } catch {
    return false;
  }
}

app.addHook('onRequest', async (request, reply) => {
  const origin = request.headers.origin;
  if (origin && isAllowedCorsOrigin(origin)) {
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
    reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
    reply.header('access-control-allow-headers', 'Content-Type, Authorization, X-Internal-Cron-Secret');
  }

  if (request.method === 'OPTIONS') {
    if (!origin || !isAllowedCorsOrigin(origin)) return reply.code(403).send({ error: 'CORS origin not allowed' });
    return reply.code(204).send();
  }
});

app.get('/health', async () => ({ status: 'ok' }));

app.post<{ Params: { telegramUserId: string } }>('/internal/reports/monthly/:telegramUserId', async (request, reply) => {
  if (request.headers['x-internal-cron-secret'] !== config.INTERNAL_CRON_SECRET) return reply.code(401).send({ error: 'unauthorized' });
  return { summary: await currentMonthSummary(request.params.telegramUserId) };
});

app.post('/internal/reports/monthly/run', async (request, reply) => {
  if (request.headers['x-internal-cron-secret'] !== config.INTERNAL_CRON_SECRET) return reply.code(401).send({ error: 'unauthorized' });
  await ensureTelegramBotInitialized();
  return sendMonthlyReports(telegramBot, previousClosedMonthReference());
});

// A deliberately scoped, secret-protected operational route. It is useful for
// support-triggered deliveries without exposing reports from other workspaces.
app.post<{ Params: { workspaceId: string } }>('/internal/reports/monthly/run/:workspaceId', async (request, reply) => {
  if (request.headers['x-internal-cron-secret'] !== config.INTERNAL_CRON_SECRET) return reply.code(401).send({ error: 'unauthorized' });
  await ensureTelegramBotInitialized();
  return sendMonthlyReports(telegramBot, previousClosedMonthReference(), request.params.workspaceId);
});

app.post('/internal/reports/weekly/run', async (request, reply) => {
  if (request.headers['x-internal-cron-secret'] !== config.INTERNAL_CRON_SECRET) return reply.code(401).send({ error: 'unauthorized' });
  await ensureTelegramBotInitialized();
  return sendWeeklyReports(telegramBot, previousClosedWeekReference());
});

app.post<{ Body: unknown }>('/api/telegram/webhook', async (request, reply) => {
  // Acknowledge the update before any OCR, AI, or database work. Telegram must
  // never retry an update just because downstream processing failed or was slow.
  reply.code(200).send({ ok: true });

  try {
    void ensureTelegramBotInitialized().then(() => {
      startSchedulerOnce();
      return telegramBot.handleUpdate(request.body as TelegramUpdate);
    }).catch((error: unknown) => {
      app.log.error({ error }, 'Telegram update processing failed after acknowledgement');
    });
  } catch (error) {
    // Protect against a synchronous failure while scheduling the bot middleware.
    app.log.error({ error }, 'Telegram update could not be scheduled');
  }
});

try {
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info({ baseUrl: config.BASE_URL, port: config.PORT }, 'Server is listening');

  try {
    await ensureTelegramBotInitialized();
    startSchedulerOnce();
  } catch (error) {
    app.log.error({ error }, 'Telegram bot initialization failed; HTTP service remains available and will retry on a webhook update');
  }

  if (config.REGISTER_TELEGRAM_WEBHOOK && telegramInitialization) {
    if (!config.BASE_URL.startsWith('https://')) {
      app.log.warn({ baseUrl: config.BASE_URL }, 'Telegram webhook was not registered because BASE_URL must use HTTPS');
    } else {
      try {
        await telegramBot.api.setWebhook(`${config.BASE_URL}/api/telegram/webhook`, {
          allowed_updates: ['message', 'callback_query'],
          ...(config.TELEGRAM_WEBHOOK_SECRET ? { secret_token: config.TELEGRAM_WEBHOOK_SECRET } : {}),
        });
        app.log.info({ webhookUrl: `${config.BASE_URL}/api/telegram/webhook` }, 'Telegram webhook registered');
      } catch (error) {
        // Keep the web service healthy if Telegram is temporarily unavailable.
        app.log.error({ error }, 'Telegram webhook registration failed');
      }
    }
  }
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
