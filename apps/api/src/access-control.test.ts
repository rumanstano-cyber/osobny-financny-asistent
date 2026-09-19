import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AccessRevokedError,
  assertTelegramPrincipalAccess,
  deriveTelegramPrincipalAccess,
  type TelegramPrincipalAccess,
} from './access-control.js';
import { terminalAsyncJobErrorCode } from './async-jobs.js';

const account = (unlinkedAt: string | null = null) => ({ user_id: 'user-a', unlinked_at: unlinkedAt });
const user = (status = 'active', deletedAt: string | null = null) => ({ id: 'user-a', status, deleted_at: deletedAt });
const membership = (userId = 'user-a', status = 'active', removedAt: string | null = null) => ({
  user_id: userId,
  workspace_id: 'workspace-a',
  status,
  removed_at: removedAt,
});

test('active Telegram user with an active workspace keeps access', () => {
  assert.deepEqual(
    deriveTelegramPrincipalAccess([account()], [user()], [membership()], new Set(['workspace-a'])),
    { state: 'active', userId: 'user-a', activeWorkspaceIds: ['workspace-a'] },
  );
});

test('a historical unlinked account is revoked and never mistaken for onboarding', () => {
  assert.equal(
    deriveTelegramPrincipalAccess([account('2026-09-19T08:00:00Z')], [user()], [membership()], new Set(['workspace-a'])).state,
    'revoked',
  );
});

test('suspended/deleted users and removed memberships are denied', () => {
  assert.equal(deriveTelegramPrincipalAccess([account()], [user('suspended')], [membership()], new Set(['workspace-a'])).state, 'revoked');
  assert.equal(deriveTelegramPrincipalAccess([account()], [user('active', '2026-09-19T08:00:00Z')], [membership()], new Set(['workspace-a'])).state, 'revoked');
  assert.equal(deriveTelegramPrincipalAccess([account()], [user()], [membership('user-a', 'removed', '2026-09-19T08:00:00Z')], new Set(['workspace-a'])).state, 'revoked');
  assert.equal(deriveTelegramPrincipalAccess([account()], [user()], [membership()], new Set()).state, 'revoked');
});

test('deactivating one member does not revoke another member of the same workspace', () => {
  const result = deriveTelegramPrincipalAccess(
    [{ user_id: 'user-b', unlinked_at: null }],
    [{ id: 'user-a', status: 'suspended', deleted_at: null }, { id: 'user-b', status: 'active', deleted_at: null }],
    [membership(), { user_id: 'user-b', workspace_id: 'workspace-a', status: 'active', removed_at: null }],
    new Set(['workspace-a']),
  );
  assert.deepEqual(result, { state: 'active', userId: 'user-b', activeWorkspaceIds: ['workspace-a'] });
});

test('only a truly unknown Telegram ID may enter onboarding', async () => {
  const fresh: TelegramPrincipalAccess = { state: 'new', userId: null, activeWorkspaceIds: [] };
  await assert.doesNotReject(() => assertTelegramPrincipalAccess('new', { allowNew: true }, async () => fresh));
  await assert.rejects(() => assertTelegramPrincipalAccess('new', {}, async () => fresh), AccessRevokedError);
});

test('workspace-scoped access fails closed outside active memberships', async () => {
  const active: TelegramPrincipalAccess = { state: 'active', userId: 'user-a', activeWorkspaceIds: ['workspace-a'] };
  await assert.doesNotReject(() => assertTelegramPrincipalAccess('active', { workspaceId: 'workspace-a' }, async () => active));
  await assert.rejects(() => assertTelegramPrincipalAccess('active', { workspaceId: 'workspace-b' }, async () => active), AccessRevokedError);
});

test('a queued media job treats post-enqueue revocation as terminal', () => {
  assert.equal(terminalAsyncJobErrorCode(new AccessRevokedError()), 'access_revoked');
  assert.equal(terminalAsyncJobErrorCode(new Error('temporary provider outage')), null);
});

test('critical Telegram, reminder, report and web paths contain server-side revocation gates', async () => {
  const [telegram, reminders, reports, webRls] = await Promise.all([
    readFile(new URL('./telegram.ts', import.meta.url), 'utf8'),
    readFile(new URL('./receipt-purchase-protection.ts', import.meta.url), 'utf8'),
    readFile(new URL('./reports.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../supabase/migrations/20260811184000_add_web_auth_and_dashboard_rls.sql', import.meta.url), 'utf8'),
  ]);
  assert.match(telegram, /await assertTelegramPrincipalAccess\(telegramUserId, \{ allowNew: true \}\);/u);
  assert.match(telegram, /processQueuedTelegramMedia[\s\S]*assertTelegramPrincipalAccess/u);
  assert.match(reminders, /assertTelegramPrincipalAccess\(claim\.telegram_user_id\)/u);
  assert.match(reminders, /status: 'cancelled'/u);
  assert.match(reports, /\.eq\('status', 'active'\)[\s\S]*\.is\('deleted_at', null\)/u);
  assert.match(webRls, /u\.status = 'active'[\s\S]*u\.deleted_at is null/u);
  assert.match(webRls, /wm\.status = 'active'[\s\S]*wm\.removed_at is null/u);
});
