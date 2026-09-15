import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../../../supabase/migrations/20260914215335_add_telegram_category_budgets.sql', import.meta.url), 'utf8');
const callbackMigration = readFileSync(new URL('../../../supabase/migrations/20260915154235_add_telegram_budget_callback_claims.sql', import.meta.url), 'utf8');

test('budget migration adds durable state without changing financial transactions', () => {
  assert.match(migration, /budgets_one_active_monthly_category_idx/u);
  assert.match(migration, /budget_alert_events/u);
  assert.match(migration, /telegram_budget_pending_states/u);
  assert.match(migration, /unique \(budget_id, period_start, threshold\)/u);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.financial_transactions/iu);
  assert.doesNotMatch(migration, /alter\s+table\s+public\.financial_transactions/iu);
});

test('budget callback claims are private and durably unique', () => {
  assert.match(callbackMigration, /create table public\.telegram_budget_callback_claims/u);
  assert.match(callbackMigration, /claim_key char\(64\) primary key/u);
  assert.match(callbackMigration, /callback_query_hash char\(64\) not null unique/u);
  assert.match(callbackMigration, /enable row level security/u);
  assert.match(callbackMigration, /revoke all on table public\.telegram_budget_callback_claims from anon, authenticated/u);
  assert.match(callbackMigration, /grant select, insert, delete on table public\.telegram_budget_callback_claims to service_role/u);
});
