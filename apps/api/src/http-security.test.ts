import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Fastify from 'fastify';
import { registerHttpSecurity } from './http-security.js';

const productionOrigin = 'https://osobny-financny-asistent-web.onrender.com';

function createApp(nodeEnv: 'development' | 'test' | 'production' = 'production') {
  const app = Fastify();
  registerHttpSecurity(app, { nodeEnv, webOrigin: productionOrigin });
  app.get('/health', async () => ({ status: 'ok' }));
  app.post('/api/telegram/webhook', async () => ({ ok: true }));
  app.post('/internal/test', async () => ({ ok: true }));
  return app;
}

test('production permits only the exact configured browser origin', async () => {
  const app = createApp();
  const allowed = await app.inject({ method: 'GET', url: '/health', headers: { origin: productionOrigin } });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers['access-control-allow-origin'], productionOrigin);
  assert.equal(allowed.headers.vary, 'Origin');

  for (const origin of ['https://attacker.onrender.com', 'http://localhost:5173', 'https://example.com']) {
    const rejected = await app.inject({ method: 'GET', url: '/health', headers: { origin } });
    assert.equal(rejected.statusCode, 403);
    assert.equal(rejected.headers['access-control-allow-origin'], undefined);
  }
  await app.close();
});

test('development permits only the expected Vite localhost origins', async () => {
  const app = createApp('development');
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
    const response = await app.inject({ method: 'GET', url: '/health', headers: { origin } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['access-control-allow-origin'], origin);
  }
  const wrongPort = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://localhost:3000' } });
  assert.equal(wrongPort.statusCode, 403);
  await app.close();
});

test('preflight is bounded and does not expose privileged internal headers', async () => {
  const app = createApp();
  const response = await app.inject({ method: 'OPTIONS', url: '/health', headers: { origin: productionOrigin } });
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['access-control-allow-methods'], 'GET, POST, OPTIONS');
  assert.equal(response.headers['access-control-allow-headers'], 'Content-Type, Authorization');
  assert.equal(response.headers['access-control-allow-credentials'], undefined);

  const missingOrigin = await app.inject({ method: 'OPTIONS', url: '/health' });
  assert.equal(missingOrigin.statusCode, 403);
  await app.close();
});

test('requests without Origin remain available for Telegram and server-to-server callers', async () => {
  const app = createApp();
  const webhook = await app.inject({ method: 'POST', url: '/api/telegram/webhook', payload: {} });
  const internal = await app.inject({ method: 'POST', url: '/internal/test', payload: {} });
  assert.equal(webhook.statusCode, 200);
  assert.equal(internal.statusCode, 200);

  const browserSpoof = await app.inject({
    method: 'POST',
    url: '/api/telegram/webhook',
    headers: { origin: 'https://attacker.onrender.com' },
    payload: {},
  });
  assert.equal(browserSpoof.statusCode, 403);
  await app.close();
});

test('API responses include restrictive security headers', async () => {
  const production = createApp();
  const response = await production.inject({ method: 'GET', url: '/health' });
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.match(String(response.headers['permissions-policy'] ?? ''), /camera=\(\)/);
  assert.equal(response.headers['content-security-policy'], "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  assert.equal(response.headers['strict-transport-security'], 'max-age=31536000');
  await production.close();

  const development = createApp('development');
  const developmentResponse = await development.inject({ method: 'GET', url: '/health' });
  assert.equal(developmentResponse.headers['strict-transport-security'], undefined);
  await development.close();
});

test('Render static site config applies a CSP compatible with Supabase and no unsafe directives', async () => {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const renderYaml = await readFile(resolve(currentDirectory, '../../..', 'render.yaml'), 'utf8');
  assert.match(renderYaml, /name: osobny-financny-asistent-web[\s\S]*headers:/);
  assert.match(renderYaml, /connect-src 'self' https:\/\/\*\.supabase\.co wss:\/\/\*\.supabase\.co/);
  assert.match(renderYaml, /frame-ancestors 'none'/);
  assert.doesNotMatch(renderYaml, /unsafe-inline|unsafe-eval/);
});
