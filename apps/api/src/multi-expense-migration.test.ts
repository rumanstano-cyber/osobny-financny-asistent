import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../../../supabase/migrations/20260914200023_add_telegram_multi_expense_batch.sql', import.meta.url),
  'utf8',
);
const telegram = readFileSync(new URL('./telegram.ts', import.meta.url), 'utf8');

test('batch migration is atomic, idempotent, and does not alter existing transaction data', () => {
  assert.match(migration, /record_telegram_transaction_batch/u);
  assert.equal((migration.match(/security definer\s+set search_path = pg_catalog, pg_temp/gu) ?? []).length, 4);
  assert.match(migration, /jsonb_array_length\(p_items\) < 2/u);
  assert.match(migration, /on conflict \(idempotency_key\) do nothing/iu);
  assert.match(migration, /v_idempotency_key \|\| ':item:'/u);
  assert.match(migration, /transaction\.created_from_telegram_batch/u);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.financial_transactions/iu);
  assert.doesNotMatch(migration, /alter\s+table\s+public\.financial_transactions/iu);
  assert.match(migration, /revoke all on function public\.record_telegram_transaction_batch[\s\S]*?from public, anon, authenticated/u);
  assert.match(migration, /grant execute on function public\.record_telegram_transaction_batch[\s\S]*?to service_role/u);
});

test('batch category selection reuses the existing category picker callbacks', () => {
  assert.match(migration, /get_telegram_last_batch_transactions/u);
  assert.match(migration, /correct_last_telegram_transaction_category/u);
  assert.match(telegram, /handleBatchCategoryCorrection/u);
  assert.match(telegram, /showCategoryPicker\(ctx/u);
  assert.match(telegram, /parseBatchTransactionCallbackData/u);
});
