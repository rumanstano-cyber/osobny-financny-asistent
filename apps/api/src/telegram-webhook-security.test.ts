import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { hasValidTelegramWebhookSecret, telegramWebhookAuthHook } from './telegram-webhook-security.js';

const secret = 'a-secure-telegram-webhook-secret-value';

test('accepts only the exact Telegram webhook secret', () => {
  assert.equal(hasValidTelegramWebhookSecret(secret, secret), true);
  assert.equal(hasValidTelegramWebhookSecret(secret, `${secret}-wrong`), false);
  assert.equal(hasValidTelegramWebhookSecret(secret, undefined), false);
  assert.equal(hasValidTelegramWebhookSecret(undefined, secret), false);
});

function createWebhookTestApp() {
  const app = Fastify({ bodyLimit: 256 * 1024 });
  let bodyPipelineEntries = 0;
  let processedUpdates = 0;

  app.addHook('preParsing', async (_request, _reply, payload) => {
    bodyPipelineEntries += 1;
    return payload;
  });
  app.post('/api/telegram/webhook', { onRequest: telegramWebhookAuthHook(secret) }, async (request) => {
    processedUpdates += 1;
    return { ok: true, update: request.body };
  });

  return { app, counts: () => ({ bodyPipelineEntries, processedUpdates }) };
}

test('valid Telegram secret reaches the existing update processing path', async () => {
  const { app, counts } = createWebhookTestApp();
  const update = { update_id: 123, message: { text: 'Káva 3 €' } };
  const response = await app.inject({
    method: 'POST', url: '/api/telegram/webhook',
    headers: { 'x-telegram-bot-api-secret-token': secret }, payload: update,
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true, update });
  assert.deepEqual(counts(), { bodyPipelineEntries: 1, processedUpdates: 1 });
  await app.close();
});

test('missing and incorrect secrets never enter body parsing or the update handler', async () => {
  const { app, counts } = createWebhookTestApp();
  for (const headers of [{}, { 'x-telegram-bot-api-secret-token': 'incorrect' }]) {
    const response = await app.inject({
      method: 'POST', url: '/api/telegram/webhook', headers,
      payload: '{not valid JSON',
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'unauthorized' });
    assert.doesNotMatch(response.body, /incorrect|a-secure-telegram/u);
  }
  assert.deepEqual(counts(), { bodyPipelineEntries: 0, processedUpdates: 0 });
  await app.close();
});

test('an unauthorized large body is rejected before body parsing and the 256 KB limit still applies to authorized requests', async () => {
  const { app, counts } = createWebhookTestApp();
  const largeBody = JSON.stringify({ data: 'x'.repeat(256 * 1024) });
  const unauthorized = await app.inject({
    method: 'POST', url: '/api/telegram/webhook',
    headers: { 'content-type': 'application/json' }, payload: largeBody,
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.deepEqual(counts(), { bodyPipelineEntries: 0, processedUpdates: 0 });

  const authorized = await app.inject({
    method: 'POST', url: '/api/telegram/webhook',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, payload: largeBody,
  });
  assert.equal(authorized.statusCode, 413);
  assert.equal(counts().processedUpdates, 0);
  await app.close();
});
