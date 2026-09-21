import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSensitiveLogText, safeErrorLog, safeRequestPath } from './safe-log.js';

test('redacts credentials, signed URL parameters, linking codes and contact data', () => {
  const sensitive = [
    'Authorization: Bearer top-secret-token',
    'OPENAI_API_KEY=sk-sensitive',
    'TELEGRAM_WEBHOOK_SECRET="webhook-sensitive"',
    'MONITORING_WATCHDOG_SECRET=watchdog-sensitive',
    'https://api.telegram.org/bot123:secret/getMe',
    'https://storage.example/object?token=signed-token&x-amz-signature=signature-value',
    '{"password":"secret","cookie":"session=value"}',
    'Link code AABBCCDDEEFF00112233445566778899',
    'customer@example.com',
  ].join(' ');
  const redacted = redactSensitiveLogText(sensitive, 10_000);
  for (const secret of ['top-secret-token', 'sk-sensitive', 'webhook-sensitive', 'watchdog-sensitive', '123:secret', 'signed-token', 'signature-value', 'session=value', 'AABBCCDDEEFF00112233445566778899', 'customer@example.com']) {
    assert.equal(redacted.includes(secret), false, secret);
  }
  assert.match(redacted, /\[REDACTED/u);
});

test('safe error logging allow-lists diagnostics and drops request and response payloads', () => {
  const error = Object.assign(new Error('Request failed for customer@example.com with Bearer secret-value'), {
    code: 'provider_error',
    status: 401,
    request_id: 'req-safe-123',
    request: { headers: { authorization: 'Bearer secret-value' }, body: 'private Telegram text' },
    response: { data: { ocrText: 'private receipt contents' } },
  });
  const logged = safeErrorLog(error);
  const serialized = JSON.stringify(logged);
  assert.deepEqual({ code: logged.code, status: logged.status, requestId: logged.requestId }, {
    code: 'provider_error',
    status: 401,
    requestId: 'req-safe-123',
  });
  for (const sensitive of ['customer@example.com', 'secret-value', 'private Telegram text', 'private receipt contents']) {
    assert.equal(serialized.includes(sensitive), false, sensitive);
  }
  assert.equal('request' in logged, false);
  assert.equal('response' in logged, false);
  assert.match(logged.message, /\[REDACTED_EMAIL\]/u);
});

test('request logging drops query parameters and personal route identifiers', () => {
  assert.equal(
    safeRequestPath('/internal/reports/monthly/123456789?token=sensitive'),
    '/internal/reports/monthly/:telegramUserId',
  );
  assert.equal(
    safeRequestPath('/internal/reports/monthly/run/8d215909-a1aa-47ca-a065-550f21520f53?secret=value'),
    '/internal/reports/monthly/run/:workspaceId',
  );
  assert.equal(safeRequestPath('/api/telegram/webhook?secret=value'), '/api/telegram/webhook');
});
