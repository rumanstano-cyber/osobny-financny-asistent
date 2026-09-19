import assert from 'node:assert/strict';
import test from 'node:test';
import { TelegramFileDownloadError, readBoundedBody } from './telegram-files.js';

test('bounded Telegram download rejects declared and streamed oversize bodies', async () => {
  await assert.rejects(
    readBoundedBody(new Response('small', { headers: { 'content-length': '1000' } }), 10),
    (error: unknown) => error instanceof TelegramFileDownloadError && !error.retryable,
  );
  await assert.rejects(
    readBoundedBody(new Response(Buffer.alloc(11)), 10),
    (error: unknown) => error instanceof TelegramFileDownloadError && !error.retryable,
  );
});

test('bounded Telegram download accepts a non-empty body within the limit', async () => {
  const bytes = await readBoundedBody(new Response('receipt'), 20);
  assert.equal(bytes.toString(), 'receipt');
});
