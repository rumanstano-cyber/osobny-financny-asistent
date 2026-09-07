import assert from 'node:assert/strict';
import test from 'node:test';
import { hasValidTelegramWebhookSecret } from './telegram-webhook-security.js';

const secret = 'a-secure-telegram-webhook-secret-value';

test('accepts only the exact Telegram webhook secret', () => {
  assert.equal(hasValidTelegramWebhookSecret(secret, secret), true);
  assert.equal(hasValidTelegramWebhookSecret(secret, `${secret}-wrong`), false);
  assert.equal(hasValidTelegramWebhookSecret(secret, undefined), false);
  assert.equal(hasValidTelegramWebhookSecret(undefined, secret), false);
});
