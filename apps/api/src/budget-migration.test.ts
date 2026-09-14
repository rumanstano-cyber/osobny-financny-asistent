import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../../../supabase/migrations/20260914215335_add_telegram_category_budgets.sql', import.meta.url), 'utf8');

test('budget migration adds durable state without changing financial transactions', () => {
  assert.match(migration, /budgets_one_active_monthly_category_idx/u);
  assert.match(migration, /budget_alert_events/u);
  assert.match(migration, /telegram_budget_pending_states/u);
  assert.match(migration, /unique \(budget_id, period_start, threshold\)/u);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.financial_transactions/iu);
  assert.doesNotMatch(migration, /alter\s+table\s+public\.financial_transactions/iu);
});
