import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { supabase } from './supabase.js';

export type WatchdogIncident = {
  code: string;
  fingerprint: string;
  observedAt: string;
  autoResolve: boolean;
};

export type OperationalWatchdogSnapshot = {
  version: 1;
  generatedAt: string;
  incidents: WatchdogIncident[];
};

type DatabaseSnapshot = { generatedAt?: string; incidents?: unknown };
type TelegramWebhookInfo = {
  url?: unknown;
  pending_update_count?: unknown;
  last_error_date?: unknown;
  last_error_message?: unknown;
};

const telegramTimeoutMs = 15_000;
const pendingUpdateAlertThreshold = 20;

function incident(code: string, discriminator = code): WatchdogIncident {
  return {
    code,
    fingerprint: createHash('sha256').update(`ofa-watchdog:${code}:${discriminator}`).digest('hex'),
    observedAt: new Date().toISOString(),
    autoResolve: true,
  };
}

function isIncident(value: unknown): value is WatchdogIncident {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WatchdogIncident>;
  return typeof candidate.code === 'string'
    && /^[a-z0-9_]{3,96}$/u.test(candidate.code)
    && typeof candidate.fingerprint === 'string'
    && /^[a-f0-9]{64}$/u.test(candidate.fingerprint)
    && typeof candidate.observedAt === 'string'
    && Number.isFinite(Date.parse(candidate.observedAt))
    && typeof candidate.autoResolve === 'boolean';
}

export function hasValidMonitoringSecret(expected: string | undefined, received: string | string[] | undefined): boolean {
  if (!expected || typeof received !== 'string') return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const receivedBytes = Buffer.from(received, 'utf8');
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}

export async function buildOperationalWatchdogSnapshot(
  dependencies: {
    databaseSnapshot?: () => Promise<DatabaseSnapshot>;
    fetchTelegram?: typeof fetch;
    baseUrl?: string;
    telegramToken?: string;
  } = {},
): Promise<OperationalWatchdogSnapshot> {
  const databaseSnapshot = dependencies.databaseSnapshot ?? (async () => {
    const { data, error } = await supabase.rpc('get_operational_watchdog_snapshot');
    if (error) throw new Error('Operational watchdog database snapshot failed');
    return (data ?? {}) as DatabaseSnapshot;
  });
  const fetchTelegram = dependencies.fetchTelegram ?? fetch;
  const baseUrl = (dependencies.baseUrl ?? config.BASE_URL).replace(/\/$/u, '');
  const telegramToken = dependencies.telegramToken ?? config.TELEGRAM_BOT_TOKEN;
  const incidents: WatchdogIncident[] = [];

  const database = await databaseSnapshot();
  if (!Array.isArray(database.incidents) || !database.incidents.every(isIncident)) {
    throw new Error('Operational watchdog database snapshot is invalid');
  }
  incidents.push(...database.incidents);

  try {
    const response = await fetchTelegram(`https://api.telegram.org/bot${telegramToken}/getWebhookInfo`, {
      signal: AbortSignal.timeout(telegramTimeoutMs),
    });
    const payload = await response.json() as { ok?: unknown; result?: TelegramWebhookInfo };
    if (!response.ok || payload.ok !== true || !payload.result) {
      incidents.push(incident('telegram_webhook_api_unavailable'));
    } else {
      const expectedUrl = `${baseUrl}/api/telegram/webhook`;
      if (payload.result.url !== expectedUrl) incidents.push(incident('telegram_webhook_url_mismatch'));
      if (typeof payload.result.last_error_message === 'string' && payload.result.last_error_message.length > 0) {
        incidents.push(incident('telegram_webhook_delivery_error'));
      }
      const pending = typeof payload.result.pending_update_count === 'number' ? payload.result.pending_update_count : 0;
      if (pending > pendingUpdateAlertThreshold) incidents.push(incident('telegram_webhook_pending_updates_high'));
    }
  } catch {
    incidents.push(incident('telegram_webhook_api_unavailable'));
  }

  return {
    version: 1,
    generatedAt: typeof database.generatedAt === 'string' && Number.isFinite(Date.parse(database.generatedAt))
      ? database.generatedAt
      : new Date().toISOString(),
    incidents,
  };
}
