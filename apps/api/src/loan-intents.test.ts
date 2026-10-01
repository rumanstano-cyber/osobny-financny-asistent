import assert from 'node:assert/strict';
import test from 'node:test';
import { findPersonMatches, parseLoanIntent } from './loan-intents.js';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role';
process.env.INTERNAL_CRON_SECRET ??= 'test-internal-cron-secret-32-chars';

const { formatLoanSnapshot } = await import('./loan-service.js');
const { summarizeReportTransactions, telegramCaption, weeklyTelegramCaption, reportEmailHtml } = await import('./reports.js');

test('natural Slovak loan messages distinguish cash movement direction', () => {
  assert.deepEqual(parseLoanIntent('Požičal som Janovi 150 €.'), {
    kind: 'principal', direction: 'lent', name: 'Jano', amountMinor: 15_000,
    currencyCode: 'EUR', dueOn: null,
  });
  assert.deepEqual(parseLoanIntent('Požičal som Petrovi Kováčovi 80 €.'), {
    kind: 'principal', direction: 'lent', name: 'Peter Kováč', amountMinor: 8_000,
    currencyCode: 'EUR', dueOn: null,
  });
  assert.deepEqual(parseLoanIntent('Požičal som si od Martina 300 €.'), {
    kind: 'principal', direction: 'borrowed', name: 'Martin', amountMinor: 30_000,
    currencyCode: 'EUR', dueOn: null,
  });
  assert.deepEqual(parseLoanIntent('Jano mi vrátil 50 €.'), {
    kind: 'repayment', direction: 'lent', name: 'Jano', amountMinor: 5_000,
    currencyCode: 'EUR', dueOn: null,
  });
  assert.deepEqual(parseLoanIntent('Martinovi som vrátil 100 €.'), {
    kind: 'repayment', direction: 'borrowed', name: 'Martin', amountMinor: 10_000,
    currencyCode: 'EUR', dueOn: null,
  });
});

test('missing name and optional due date are recognized before ordinary expense parsing', () => {
  assert.equal(parseLoanIntent('Požičal som 100 €.')?.name, null);
  const withDueDate = parseLoanIntent('Požičal som Janovi 150 €, má mi ich vrátiť do 15. novembra.', new Date('2026-10-01'));
  assert.equal(withDueDate?.kind, 'principal');
  if (withDueDate?.kind !== 'principal') throw new Error('Loan was not parsed');
  assert.equal(withDueDate.dueOn, '2026-11-15');
  assert.equal(parseLoanIntent('Káva 3 €'), null);
});

test('name matching never guesses between people with the same first name', () => {
  const people = [{ id: 'a', name: 'Jano Novák' }, { id: 'b', name: 'Jano Kováč' }];
  assert.equal(findPersonMatches('Jano', people).length, 2);
  assert.deepEqual(findPersonMatches('Jano Novák', people), [people[0]]);
});

test('status questions select the right side and optional person', () => {
  assert.deepEqual(parseLoanIntent('Kto mi dlhuje?'), { kind: 'status', direction: 'lent', name: null });
  assert.deepEqual(parseLoanIntent('Komu dlhujem?'), { kind: 'status', direction: 'borrowed', name: null });
  assert.deepEqual(parseLoanIntent('Koľko ešte dlhuje Jano?'), { kind: 'status', direction: 'lent', name: 'Jano' });
  assert.deepEqual(parseLoanIntent('Koľko ešte dlhujem Martinovi?'), { kind: 'status', direction: 'borrowed', name: 'Martin' });
  assert.deepEqual(parseLoanIntent('Stav pôžičiek.'), { kind: 'status', direction: null, name: null });
});

test('loan section exists only for open balances, and ordinary totals ignore transfers', () => {
  assert.equal(formatLoanSnapshot({ entries: [] }), 'Momentálne nemáš evidovanú žiadnu otvorenú pôžičku.');
  const formatted = formatLoanSnapshot({ entries: [
    { name: 'Jano', direction: 'lent', currencyCode: 'EUR', remainingMinor: 15_000, dueOn: null },
    { name: 'Martin', direction: 'borrowed', currencyCode: 'EUR', remainingMinor: 30_000, dueOn: null },
  ] });
  assert.match(formatted, /Mne dlhujú:[\s\S]*Jano/u);
  assert.match(formatted, /Ja dlhujem:[\s\S]*Martin/u);
  const totals = summarizeReportTransactions([
    { id: 'loan', transaction_type: 'transfer', amount_minor: 50_000, currency_code: 'EUR' },
    { id: 'expense', transaction_type: 'expense', amount_minor: 1_000, currency_code: 'EUR' },
  ], new Map());
  assert.equal(totals.expenseMinor, 1_000);
  assert.equal(totals.incomeMinor, 0);
});

test('weekly and monthly reports omit the loan section entirely without open loans', () => {
  const report = {
    periodStart: new Date('2026-10-01'), periodEnd: new Date('2026-11-01'), monthLabel: 'október 2026',
    currencyCode: 'EUR', incomeMinor: 0, expenseMinor: 0, balanceMinor: 0, categories: [],
  };
  assert.doesNotMatch(weeklyTelegramCaption(report), /Pôžičky/u);
  assert.doesNotMatch(telegramCaption(report, 'Komentár'), /Pôžičky/u);
  assert.doesNotMatch(reportEmailHtml(report, 'Komentár'), /Pôžičky/u);
  const withLoan = { ...report, loans: { entries: [{
    name: 'Jano', direction: 'lent' as const, currencyCode: 'EUR', remainingMinor: 10_000, dueOn: null,
  }] } };
  assert.match(weeklyTelegramCaption(withLoan), /Pôžičky/u);
  assert.match(telegramCaption(withLoan, 'Komentár'), /Pôžičky/u);
  assert.match(reportEmailHtml(withLoan, 'Komentár'), /Pôžičky/u);
});
