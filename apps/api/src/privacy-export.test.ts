import assert from 'node:assert/strict';
import test from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import type { supabase } from './supabase.js';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role';
process.env.INTERNAL_CRON_SECRET ??= 'test-internal-cron-secret-32-chars';

const { PrivacyAccessError, inActiveWorkspace, resolveVerifiedWebUser, streamPrivateExport } = await import('./privacy-export.js');

type ExportClient = typeof supabase;
const userId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';

function authClient(confirmed = true, status = 'active'): ExportClient {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'auth-user', email_confirmed_at: confirmed ? '2026-01-01' : null } }, error: null }) },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { id: userId, auth_user_id: 'auth-user', status, deleted_at: null }, error: null }) }),
      }),
    }),
  } as unknown as ExportClient;
}

function streamClient(options: { active?: boolean; membership?: boolean } = {}) {
  let downloads = 0;
  const active = options.active ?? true;
  const membership = options.membership ?? true;
  const client = {
    from: (table: string) => ({
      select: () => {
        const query = {
          eq: () => query,
          is: () => query,
          single: async () => ({ data: table === 'ofa_users' ? { status: active ? 'active' : 'deleted', deleted_at: null } : null, error: null }),
          maybeSingle: async () => ({ data: membership ? { workspace_id: workspaceId } : null, error: null }),
        };
        return query;
      },
    }),
    storage: { from: () => ({ download: async () => {
      downloads += 1;
      return { data: new Blob(['receipt']), error: null };
    } }) },
  } as unknown as ExportClient;
  return { client, getDownloads: () => downloads };
}

test('export requires a server-verified, confirmed Supabase Auth user with an active profile', async () => {
  await assert.rejects(resolveVerifiedWebUser(undefined, false, authClient()), PrivacyAccessError);
  await assert.rejects(resolveVerifiedWebUser('Bearer token', false, authClient(false)), PrivacyAccessError);
  await assert.rejects(resolveVerifiedWebUser('Bearer token', false, authClient(true, 'deleted')), PrivacyAccessError);
  const profile = await resolveVerifiedWebUser('Bearer token', false, authClient());
  assert.equal(profile.id, userId);
});

test('export includes only records from active workspaces', () => {
  const rows = [
    { id: 'own', workspace_id: workspaceId },
    { id: 'foreign', workspace_id: '33333333-3333-4333-8333-333333333333' },
  ];
  assert.deepEqual(inActiveWorkspace(rows, new Set([workspaceId])), [rows[0]]);
});

test('authenticated web ZIP contains an owned receipt without exposing a public URL', async () => {
  const { client, getDownloads } = streamClient();
  const file = { id: 'file-1', workspace_id: workspaceId, uploaded_by_user_id: userId, storage_key: 'private/key', content_type: 'image/jpeg', deleted_at: null };
  const chunks: Buffer[] = [];
  for await (const chunk of streamPrivateExport({ metadata: { format_version: 1 }, files: [file] }, userId, client)) chunks.push(chunk);
  const zip = unzipSync(Buffer.concat(chunks));
  assert.equal(JSON.parse(strFromU8(zip['data.json'])).format_version, 1);
  assert.equal(strFromU8(zip['documents/file-1.jpg']), 'receipt');
  assert.equal(getDownloads(), 1);
  assert.equal(Buffer.concat(chunks).includes(Buffer.from('private/key')), false);
});

test('revoked user or workspace membership stops export before a receipt download', async () => {
  for (const options of [{ active: false }, { membership: false }]) {
    const { client, getDownloads } = streamClient(options);
    const file = { id: 'file-1', workspace_id: workspaceId, uploaded_by_user_id: userId, storage_key: 'private/key', content_type: 'image/jpeg', deleted_at: null };
    const stream = streamPrivateExport({ metadata: {}, files: [file] }, userId, client);
    await assert.rejects(async () => { for await (const _chunk of stream) { /* drain */ } }, PrivacyAccessError);
    assert.equal(getDownloads(), 0);
  }
});
