import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOperationalWatchdogSnapshot, hasValidMonitoringSecret } from './monitoring.js';

const goodDatabaseSnapshot = async () => ({ generatedAt: '2026-09-21T10:00:00.000Z', incidents: [] });

function telegramResponse(result: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

test('healthy operational state contains no incidents', async () => {
  const snapshot = await buildOperationalWatchdogSnapshot({
    databaseSnapshot: goodDatabaseSnapshot,
    baseUrl: 'https://example.onrender.com',
    telegramToken: 'secret-token-not-logged',
    fetchTelegram: () => telegramResponse({
      url: 'https://example.onrender.com/api/telegram/webhook',
      pending_update_count: 0,
    }),
  });
  assert.deepEqual(snapshot.incidents, []);
});

test('wrong Telegram webhook, provider error and excessive backlog become sanitized incidents', async () => {
  const snapshot = await buildOperationalWatchdogSnapshot({
    databaseSnapshot: goodDatabaseSnapshot,
    baseUrl: 'https://example.onrender.com',
    telegramToken: 'secret-token-not-logged',
    fetchTelegram: () => telegramResponse({
      url: 'https://wrong.example/webhook',
      pending_update_count: 21,
      last_error_message: 'request contained private details',
    }),
  });
  assert.deepEqual(snapshot.incidents.map((value) => value.code).sort(), [
    'telegram_webhook_delivery_error',
    'telegram_webhook_pending_updates_high',
    'telegram_webhook_url_mismatch',
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-token|private details|wrong\.example/u);
});

test('Telegram API failure creates a generic incident without leaking request details', async () => {
  const snapshot = await buildOperationalWatchdogSnapshot({
    databaseSnapshot: goodDatabaseSnapshot,
    baseUrl: 'https://example.onrender.com',
    telegramToken: 'secret-token-not-logged',
    fetchTelegram: async () => { throw new Error('https://api.telegram.org/botsecret-token-not-logged/getWebhookInfo'); },
  });
  assert.equal(snapshot.incidents[0]?.code, 'telegram_webhook_api_unavailable');
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-token/u);
});

test('monitoring secret comparison fails closed and uses exact values', () => {
  const secret = 'watchdog-secret-at-least-thirty-two-characters';
  assert.equal(hasValidMonitoringSecret(secret, secret), true);
  assert.equal(hasValidMonitoringSecret(secret, `${secret}x`), false);
  assert.equal(hasValidMonitoringSecret(secret, undefined), false);
  assert.equal(hasValidMonitoringSecret(undefined, secret), false);
});

test('invalid database payload fails closed', async () => {
  await assert.rejects(
    () => buildOperationalWatchdogSnapshot({
      databaseSnapshot: async () => ({ incidents: [{ code: 'terminal_async_job_failed', fingerprint: 'raw-id' }] }),
      fetchTelegram: () => telegramResponse({}),
    }),
    /snapshot is invalid/u,
  );
});
