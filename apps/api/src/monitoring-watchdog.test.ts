import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../../../.github/workflows/production-watchdog.yml', import.meta.url), 'utf8');
const server = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
const config = readFileSync(new URL('./config.ts', import.meta.url), 'utf8');
const trust = readFileSync(new URL('../../../infrastructure/aws/watchdog-role-trust-policy.json', import.meta.url), 'utf8');
const permissions = readFileSync(new URL('../../../infrastructure/aws/watchdog-role-permissions-policy.json', import.meta.url), 'utf8');

test('watchdog is prepared for a bounded 30-minute schedule and three-step health confirmation', () => {
  assert.match(workflow, /cron: '\*\/30 \* \* \* \*'/u);
  assert.match(workflow, /timeout-minutes: 10/u);
  assert.match(workflow, /production-watchdog\.mjs/u);
  assert.match(readFileSync(new URL('../scripts/production-watchdog.mjs', import.meta.url), 'utf8'), /attempts: 3/u);
});

test('monitoring endpoint is disabled without its secret and rejects invalid callers', () => {
  assert.match(config, /MONITORING_WATCHDOG_SECRET: z\.string\(\)\.min\(32\)\.optional\(\)/u);
  assert.match(server, /if \(!config\.MONITORING_WATCHDOG_SECRET\) return reply\.code\(404\)/u);
  assert.match(server, /hasValidMonitoringSecret/u);
  assert.match(server, /reply\.code\(401\)/u);
});

test('watchdog IAM proposal is repository-bound and can read only its dedicated secret', () => {
  const trustDocument = JSON.parse(trust) as { Statement: Array<{ Condition: { StringEquals: Record<string, string> } }> };
  assert.equal(
    trustDocument.Statement[0]?.Condition.StringEquals['token.actions.githubusercontent.com:sub'],
    'repo:rumanstano-cyber@313154210/osobny-financny-asistent@1323407617:ref:refs/heads/main',
  );
  const permissionDocument = JSON.parse(permissions) as { Statement: Array<{ Action: string; Resource: string }> };
  assert.equal(permissionDocument.Statement.length, 1);
  assert.equal(permissionDocument.Statement[0]?.Action, 'secretsmanager:GetSecretValue');
  assert.match(permissionDocument.Statement[0]?.Resource ?? '', /secret:ofa\/prod\/watchdog-source-\*/u);
  assert.doesNotMatch(permissions, /s3:|PutObject|DeleteObject/u);
});

test('workflow never places application provider credentials directly in GitHub configuration', () => {
  assert.doesNotMatch(workflow, /SUPABASE_SERVICE_ROLE_KEY|TELEGRAM_BOT_TOKEN|RESEND_API_KEY/u);
  assert.match(workflow, /::add-mask::\$value/u);
  assert.match(workflow, /issues: write/u);
});
