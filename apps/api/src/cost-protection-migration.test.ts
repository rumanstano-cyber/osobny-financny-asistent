import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../../../supabase/migrations/20260918201052_anti_spam_cost_protection.sql', import.meta.url),
  'utf8',
);

test('cost protection migration is additive and isolates operational tables', () => {
  assert.match(migration, /create table public\.cost_rate_limit_counters/iu);
  assert.match(migration, /create table public\.telegram_update_claims/iu);
  assert.match(migration, /alter table public\.cost_rate_limit_counters enable row level security/iu);
  assert.match(migration, /alter table public\.telegram_update_claims enable row level security/iu);
  assert.doesNotMatch(migration, /drop\s+(?:table|schema)|truncate/iu);
  assert.doesNotMatch(migration, /delete from public\.(?:financial_transactions|ofa_receipts|stored_files)/iu);
});

test('privileged RPCs use an empty search path and service-role-only execution', () => {
  for (const signature of [
    'claim_telegram_update\\(bigint, text\\)',
    'consume_cost_rate_limits\\(text, integer, jsonb\\)',
    'cleanup_cost_protection\\(\\)',
  ]) {
    assert.match(migration, new RegExp(`set search_path = ''[\\s\\S]*?revoke all on function public\\.${signature} from public, anon, authenticated`, 'iu'));
    assert.match(migration, new RegExp(`grant execute on function public\\.${signature} to service_role`, 'iu'));
  }
});

test('counter consumption uses row locking and bounded cleanup', () => {
  assert.match(migration, /for update/iu);
  assert.match(migration, /bucket_start < now\(\) - interval '8 days'/iu);
  assert.match(migration, /claimed_at < now\(\) - interval '8 days'/iu);
});
