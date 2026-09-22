import Fastify from 'fastify';
import { config } from './config.js';
import { currentMonthSummary, previousClosedMonthReference, sendMonthlyReports, sendWeeklyReports } from './reports.js';
import { createTelegramBot } from './telegram.js';
import { telegramWebhookAuthHook } from './telegram-webhook-security.js';
import { previousClosedWeekReference, startWeeklyReportScheduler } from './weekly-report-scheduler.js';
import { startTelegramMediaJobWorker } from './async-jobs.js';
import { notifyQueuedTelegramMediaFailure, processQueuedTelegramMedia } from './telegram.js';
import { runReceiptPurchaseProtectionMaintenance, startReceiptPurchaseProtectionScheduler } from './receipt-purchase-protection.js';
import { safeErrorLog, safeRequestPath } from './safe-log.js';
import { buildOperationalWatchdogSnapshot, hasValidMonitoringSecret } from './monitoring.js';
import { registerHttpSecurity } from './http-security.js';

const app = Fastify({
  logger: {
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        "req.headers['x-telegram-bot-api-secret-token']",
        "req.headers['x-internal-cron-secret']",
        "req.headers['x-monitoring-watchdog-secret']",
        "res.headers['set-cookie']",
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      req: (request: { method?: string; url?: string }) => ({
        method: request.method,
        url: safeRequestPath(request.url),
      }),
      res: (response: { statusCode?: number }) => ({ statusCode: response.statusCode }),
    },
  },
  bodyLimit: 256 * 1024,
});
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
  // Supabase Cron is the production source of truth. Keep the in-process
  // scheduler only for local development where it is useful without pg_cron.
  if (config.NODE_ENV !== 'production') startWeeklyReportScheduler(telegramBot);
  if (config.NODE_ENV !== 'production') startReceiptPurchaseProtectionScheduler(telegramBot);
  startTelegramMediaJobWorker(
    (payload) => processQueuedTelegramMedia(telegramBot, payload),
    (payload, error) => notifyQueuedTelegramMediaFailure(telegramBot, payload, error),
  );
  reportSchedulersStarted = true;
}

registerHttpSecurity(app, {
  nodeEnv: config.NODE_ENV,
  webOrigin: config.WEB_APP_URL,
});

app.get('/health', async () => ({ status: 'ok' }));

app.get('/internal/monitoring/snapshot', async (request, reply) => {
  if (!config.MONITORING_WATCHDOG_SECRET) return reply.code(404).send({ error: 'not_found' });
  if (!hasValidMonitoringSecret(config.MONITORING_WATCHDOG_SECRET, request.headers['x-monitoring-watchdog-secret'])) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  return buildOperationalWatchdogSnapshot();
});

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

app.post('/internal/receipt-purchase-protection/run', async (request, reply) => {
  if (request.headers['x-internal-cron-secret'] !== config.INTERNAL_CRON_SECRET) return reply.code(401).send({ error: 'unauthorized' });
  await ensureTelegramBotInitialized();
  return runReceiptPurchaseProtectionMaintenance(telegramBot);
});

app.post<{ Body: unknown }>('/api/telegram/webhook', { onRequest: telegramWebhookAuthHook(config.TELEGRAM_WEBHOOK_SECRET) }, async (request, reply) => {
  // Acknowledge the update before any OCR, AI, or database work. Telegram must
  // never retry an update just because downstream processing failed or was slow.
  reply.code(200).send({ ok: true });

  try {
    void ensureTelegramBotInitialized().then(() => {
      startSchedulerOnce();
      return telegramBot.handleUpdate(request.body as TelegramUpdate);
    }).catch((error: unknown) => {
      app.log.error({ error: safeErrorLog(error) }, 'Telegram update processing failed after acknowledgement');
    });
  } catch (error) {
    // Protect against a synchronous failure while scheduling the bot middleware.
    app.log.error({ error: safeErrorLog(error) }, 'Telegram update could not be scheduled');
  }
});

try {
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info({ baseUrl: config.BASE_URL, port: config.PORT }, 'Server is listening');

  try {
    await ensureTelegramBotInitialized();
    startSchedulerOnce();
  } catch (error) {
    app.log.error({ error: safeErrorLog(error) }, 'Telegram bot initialization failed; HTTP service remains available and will retry on a webhook update');
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
        // Grammy's error object includes the complete setWebhook payload, which
        // may contain TELEGRAM_WEBHOOK_SECRET. Never serialize that object.
        app.log.error({ error: safeErrorLog(error) }, 'Telegram webhook registration failed');
      }
    }
  }
} catch (error) {
  app.log.error({ error: safeErrorLog(error) }, 'Server startup failed');
  process.exit(1);
}
