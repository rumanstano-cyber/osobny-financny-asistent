import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { supabase } from './supabase.js';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role';
process.env.INTERNAL_CRON_SECRET ??= 'test-internal-cron-secret-32-chars';

const { processDueAccountErasures } = await import('./privacy-erasure.js');
const migration = readFileSync(new URL('../../../supabase/migrations/20260923181247_privacy_account_workflows.sql', import.meta.url), 'utf8');
type Client = typeof supabase;
const request = { request_id: 'request-1', user_id: 'user-1', lease_token: 'lease-1' };

function fakeClient(options: { files?: string[]; storageError?: boolean; finalizerError?: boolean; authUserId?: string | null } = {}) {
  const calls: string[] = [];
  let remaining = [...(options.files ?? [])];
  const client = {
    rpc: async (name: string, args?: Record<string, unknown>) => {
      calls.push(name);
      if (name === 'claim_due_account_erasures') return { data: [request], error: null };
      if (name === 'list_account_erasure_storage_files') return {
        data: remaining.slice(0, Number(args?.p_limit ?? 25)).map((key) => ({ file_id: key, storage_key: key })), error: null,
      };
      if (name === 'mark_account_erasure_storage_file_removed') {
        remaining = remaining.filter((key) => key !== args?.p_file_id);
        return { data: true, error: null };
      }
      if (name === 'finalize_account_erasure') return {
        data: !options.finalizerError,
        error: options.finalizerError ? { message: 'reconciliation required' } : null,
      };
      if (name === 'defer_account_erasure') return { data: true, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    },
    storage: { from: () => ({ remove: async () => {
      calls.push('storage.remove');
      return { error: options.storageError ? { message: 'Storage unavailable' } : null };
    } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({
      data: { auth_user_id: options.authUserId ?? null }, error: null,
    }) }) }) }),
    auth: { admin: { deleteUser: async () => { calls.push('auth.deleteUser'); return { error: null }; } } },
  } as unknown as Client;
  return { client, calls };
}

test('finalizer follows Storage and Auth removal, not the reverse', async () => {
  const { client, calls } = fakeClient({ files: ['file-1'], authUserId: 'auth-user-1' });
  assert.deepEqual(await processDueAccountErasures(client), { completed: 1, deferred: 0 });
  assert.ok(calls.indexOf('storage.remove') < calls.indexOf('auth.deleteUser'));
  assert.ok(calls.indexOf('auth.deleteUser') < calls.indexOf('finalize_account_erasure'));
});

test('Storage error fails closed before Auth or database finalization', async () => {
  const { client, calls } = fakeClient({ files: ['file-1'], storageError: true, authUserId: 'auth-user-1' });
  assert.deepEqual(await processDueAccountErasures(client), { completed: 0, deferred: 1 });
  assert.ok(calls.includes('defer_account_erasure'));
  assert.ok(!calls.includes('auth.deleteUser'));
  assert.ok(!calls.includes('finalize_account_erasure'));
});

test('a bounded batch with more files is rescheduled rather than finalized', async () => {
  const files = Array.from({ length: 26 }, (_, index) => `file-${index}`);
  const { client, calls } = fakeClient({ files });
  assert.deepEqual(await processDueAccountErasures(client), { completed: 0, deferred: 1 });
  assert.equal(calls.filter((name) => name === 'storage.remove').length, 25);
  assert.ok(!calls.includes('finalize_account_erasure'));
});

test('DB finalization uncertainty is retained for reconciliation, not reported as erased', async () => {
  const { client, calls } = fakeClient({ finalizerError: true });
  assert.deepEqual(await processDueAccountErasures(client), { completed: 0, deferred: 1 });
  assert.ok(calls.includes('defer_account_erasure'));
});

test('shared workspace files are never listed for deletion merely because the departing user uploaded them', () => {
  const list = migration.split('create or replace function public.list_account_erasure_storage_files(')[1]
    ?.split('create or replace function public.mark_account_erasure_storage_file_removed(')[0] ?? '';
  assert.match(list, /public\.is_exclusive_erasure_workspace\(v_user_id, file\.workspace_id\)/u);
  assert.doesNotMatch(list, /file\.uploaded_by_user_id = v_user_id\s+or/u);
  const exclusive = migration.split('create or replace function public.is_exclusive_erasure_workspace(')[1]
    ?.split('create or replace function public.prevent_join_to_erasing_workspace(')[0] ?? '';
  assert.match(exclusive, /member\.user_id <> p_user_id/u);
  assert.match(exclusive, /file\.uploaded_by_user_id is distinct from p_user_id/u);
});

test('grace, exclusive workspace and shared-data preservation guard the finalizer', () => {
  const finalizer = migration.split('create or replace function public.finalize_account_erasure(')[1] ?? '';
  assert.match(finalizer, /request\.due_at <= pg_catalog\.now\(\)/u);
  assert.match(finalizer, /public\.is_exclusive_erasure_workspace\(v_user_id, v_workspace_id\)/u);
  assert.match(finalizer, /raise exception 'Workspace ownership requires reconciliation'/u);
  assert.match(finalizer, /No shared financial or receipt row is removed/u);
  assert.match(finalizer, /set display_name = null, email = null, auth_user_id = null/u);
  assert.match(finalizer, /status = 'completed'/u);
});
