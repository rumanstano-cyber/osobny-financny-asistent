import assert from 'node:assert/strict';
import test from 'node:test';
import { sendTelegramWithRetry, summarizeReportTransactions, weeklyReportPeriod } from './reports.js';
import { previousClosedWeekReference, shouldCatchUpWeeklyReport } from './weekly-report-scheduler.js';

test('weekly report period uses the closed Monday-to-Monday Bratislava week across the spring DST change', () => {
  const period = weeklyReportPeriod(new Date('2026-03-29T10:00:00.000Z'));

  assert.equal(period.start.toISOString(), '2026-03-22T23:00:00.000Z');
  assert.equal(period.end.toISOString(), '2026-03-29T22:00:00.000Z');
});

test('weekly report period uses the closed Monday-to-Monday Bratislava week across the autumn DST change', () => {
  const period = weeklyReportPeriod(new Date('2026-10-25T11:00:00.000Z'));

  assert.equal(period.start.toISOString(), '2026-10-18T22:00:00.000Z');
  assert.equal(period.end.toISOString(), '2026-10-25T23:00:00.000Z');
});

test('weekly report catch-up only runs after 08:00 on Monday in Bratislava time', () => {
  assert.equal(shouldCatchUpWeeklyReport(new Date('2026-03-30T05:59:00.000Z')), false);
  assert.equal(shouldCatchUpWeeklyReport(new Date('2026-03-30T06:00:00.000Z')), true);
  assert.equal(shouldCatchUpWeeklyReport(new Date('2026-03-31T08:00:00.000Z')), false);
});

test('closed-week reference always selects the fully completed Bratislava week', () => {
  const period = weeklyReportPeriod(previousClosedWeekReference(new Date('2026-04-01T10:00:00.000Z')));

  assert.equal(period.start.toISOString(), '2026-03-22T23:00:00.000Z');
  assert.equal(period.end.toISOString(), '2026-03-29T22:00:00.000Z');
});

test('report aggregation calculates income, expenses, balance and ranked expense categories', () => {
  const summary = summarizeReportTransactions(
    [
      { id: 'income', transaction_type: 'income', amount_minor: 150_000, currency_code: 'EUR' },
      { id: 'fuel', transaction_type: 'expense', amount_minor: 6_000, currency_code: 'EUR' },
      { id: 'groceries', transaction_type: 'expense', amount_minor: 4_500, currency_code: 'EUR' },
      { id: 'lunch', transaction_type: 'expense', amount_minor: 1_200, currency_code: 'EUR' },
      { id: 'unknown', transaction_type: 'expense', amount_minor: 300, currency_code: 'EUR' },
    ],
    new Map([
      ['fuel', { name: 'Auto', slug: 'auto' }],
      ['groceries', { name: 'Potraviny', slug: 'potraviny' }],
      ['lunch', { name: 'Reštaurácie', slug: 'restauracie' }],
    ]),
  );

  assert.equal(summary.incomeMinor, 150_000);
  assert.equal(summary.expenseMinor, 12_000);
  assert.equal(summary.balanceMinor, 138_000);
  assert.deepEqual(summary.categories, [
    { name: 'Auto', slug: 'auto', amountMinor: 6_000 },
    { name: 'Potraviny', slug: 'potraviny', amountMinor: 4_500 },
    { name: 'Reštaurácie', slug: 'restauracie', amountMinor: 1_200 },
    { name: 'Ostatné', slug: 'ostatne', amountMinor: 300 },
  ]);
});

test('Telegram delivery retries transient failures and then succeeds', async () => {
  let attempts = 0;
  const result = await sendTelegramWithRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('temporary Telegram outage');
      return 'sent';
    },
    { sleep: async () => undefined },
  );

  assert.equal(result, 'sent');
  assert.equal(attempts, 3);
});

test('Telegram delivery fails only after the configured retry attempts', async () => {
  let attempts = 0;
  await assert.rejects(
    sendTelegramWithRetry(
      async () => {
        attempts += 1;
        throw new Error('Telegram unavailable');
      },
      { attempts: 3, sleep: async () => undefined },
    ),
    /Telegram unavailable/,
  );
  assert.equal(attempts, 3);
});
