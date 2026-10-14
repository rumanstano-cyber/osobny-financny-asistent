import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dativePerson, findPersonMatches, loanClarification, parseLoanIntent } from './loan-intents.js';
import { parseFinancialMessage } from './finance-parser.js';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role';
process.env.INTERNAL_CRON_SECRET ??= 'test-internal-cron-secret-32-chars';

const { decideLoanWriteFromRows, loanSavedText } = await import('./loan-service.js');
const loanMigration = readFileSync(
  new URL('../../../supabase/migrations/20261001193000_add_personal_loans.sql', import.meta.url),
  'utf8',
);

const borrowed = [
  'Som dlžný Romanovi 12 €.', 'Dlžím Romanovi 12 €.', 'Romanovi dlžím 12 €.',
  'Mám dlh voči Romanovi 12 €.', 'Mám u Romana dlh 12 €.',
  'Požičal som si od Romana 12 €.', 'Roman mi požičal 12 €.',
  'Vzal som si od Romana 12 €.', 'Mám od Romana požičaných 12 €.',
  'Som Romanovi dlžný 12 €.', 'Ešte dlžím Romanovi 12 €.',
  '12 € dlžím Romanovi.',
];
const lent = [
  'Požičal som Romanovi 12 €.', 'Dal som Romanovi požičať 12 €.',
  'Romanovi som požičal 12 €.', 'Roman mi dlhuje 12 €.',
  'Roman je mi dlžný 12 €.', 'Mám u Romana 12 €.',
  'Roman mi má vrátiť 12 €.', 'Dal som Romanovi 12 € na pôžičku.',
  'Pôžička Romanovi 12 €.', 'Požička Romanovi 12 €.', '12 € som požičal Romanovi.',
];
const borrowedRepayments = [
  'Vrátil som Romanovi 5 €.', 'Romanovi som vrátil 5 €.',
  'Splácal som Romanovi 5 €.', 'Splatil som Romanovi 5 €.',
  'Dal som Romanovi späť 5 €.', 'Uhradil som Romanovi 5 €.',
  'Vyrovnal som Romanovi 5 €.', 'Vrátil som časť dlhu Romanovi 5 €.',
];
const lentRepayments = [
  'Roman mi vrátil 5 €.', 'Roman vrátil 5 €.', 'Roman mi splatil 5 €.',
  'Roman mi dal späť 5 €.', 'Roman mi uhradil 5 €.',
  'Roman mi vrátil časť 5 €.', 'Od Romana som dostal späť 5 €.',
  '5 € mi Roman vrátil.',
];

for (const [sentences, kind, direction, amountMinor] of [
  [borrowed, 'principal', 'borrowed', 1200],
  [lent, 'principal', 'lent', 1200],
  [borrowedRepayments, 'repayment', 'borrowed', 500],
  [lentRepayments, 'repayment', 'lent', 500],
] as const) {
  for (const sentence of sentences) {
    test(`loan Slovak: ${sentence}`, () => {
      assert.deepEqual(parseLoanIntent(sentence), {
        kind, direction, name: 'Roman', amountMinor, currencyCode: 'EUR', dueOn: null,
      });
    });
  }
}

test('original Roman bug never becomes an ordinary expense or an Ostatné response', () => {
  const intent = parseLoanIntent('Som dlžný Romanovi 12 eur.');
  assert.deepEqual(intent, {
    kind: 'principal', direction: 'borrowed', name: 'Roman',
    amountMinor: 1200, currencyCode: 'EUR', dueOn: null,
  });
  if (!intent || intent.kind === 'status') throw new Error('Expected write intent');
  const reply = loanSavedText(intent, 'Roman', 1200);
  assert.equal(reply, 'Zapísané. Romanovi dlhuješ 12,00 €.');
  assert.doesNotMatch(reply, /ostatné\s+12\s+eur/iu);
});

test('Martin repayments keep the direction and do not reach the expense route', () => {
  for (const [sentence, direction] of [
    ['Vrátil som Martinovi 10 eur', 'borrowed'],
    ['vratil som Martinovi 10 eur', 'borrowed'],
    ['Martinovi som vrátil 10 €', 'borrowed'],
    ['Martinovi som vratil 10 €', 'borrowed'],
    ['Splácal som Martinovi pôžičku 10 eur', 'borrowed'],
    ['Martin mi vrátil 10 eur', 'lent'],
    ['Martin mi vratil 10 eur', 'lent'],
  ] as const) {
    assert.deepEqual(parseLoanIntent(sentence), {
      kind: 'repayment', direction, name: 'Martin', amountMinor: 1000,
      currencyCode: 'EUR', dueOn: null,
    }, sentence);
  }
  assert.equal(parseLoanIntent('Káva 10 €'), null);
  assert.equal(parseFinancialMessage('Káva 10 €')?.transactionType, 'expense');
  assert.ok(loanClarification('vratil som 10 eur'));
});

test('repayment decision refuses absent or multiple open Martin debts', () => {
  const intent = parseLoanIntent('vratil som Martinovi 10 eur');
  if (!intent || intent.kind !== 'repayment') throw new Error('Expected repayment');
  const people = [{ id: 'martin', name: 'Martin' }];
  const loan = { id: 'a', counterparty_id: 'martin', direction: 'borrowed' as const,
    original_minor: 30000, repaid_minor: 0, currency_code: 'EUR', due_on: null, status: 'OPEN' };
  assert.deepEqual(decideLoanWriteFromRows(intent, [], []), { kind: 'missing_loan' });
  assert.deepEqual(decideLoanWriteFromRows(intent, people, [loan, { ...loan, id: 'b' }]), { kind: 'ambiguous_loans' });
  assert.deepEqual(decideLoanWriteFromRows(intent, people, [loan]), { kind: 'ready', counterpartyId: 'martin', name: null });
  assert.deepEqual(decideLoanWriteFromRows({ ...intent, direction: 'lent' }, people, [loan]), { kind: 'missing_loan' });
});

test('loan amounts accept euro spellings and both decimal separators', () => {
  for (const [amount, expected] of [['12 €', 1200], ['12 eur', 1200], ['12 euro', 1200], ['12,50 €', 1250], ['12.50 €', 1250]] as const) {
    assert.equal(parseLoanIntent(`Som dlžný Romanovi ${amount}.`)?.kind, 'principal');
    assert.equal((parseLoanIntent(`Som dlžný Romanovi ${amount}.`) as { amountMinor: number }).amountMinor, expected);
  }
});

test('names retain distinct nominative forms and ambiguous first names stay ambiguous', () => {
  for (const [dative, genitive, nominative] of [
    ['Romanovi', 'Romana', 'Roman'], ['Petrovi', 'Petra', 'Peter'],
    ['Jánovi', 'Jána', 'Ján'], ['Markovi', 'Marka', 'Marek'],
  ]) {
    assert.equal((parseLoanIntent(`Dlžím ${dative} 12 €.`) as { name: string }).name, nominative);
    assert.equal((parseLoanIntent(`Požičal som si od ${genitive} 12 €.`) as { name: string }).name, nominative);
    assert.equal(dativePerson(nominative), dative);
  }
  const people = [{ id: 'a', name: 'Roman Novák' }, { id: 'b', name: 'Roman Kováč' }];
  assert.equal(findPersonMatches('Roman', people).length, 2);
  assert.deepEqual(findPersonMatches('Roman Novák', people), [people[0]]);
});

test('partial and full settlements name the right debtor', () => {
  const lentIntent = parseLoanIntent('Roman mi vrátil 5 €.');
  const borrowedIntent = parseLoanIntent('Vrátil som Romanovi 5 €.');
  if (!lentIntent || lentIntent.kind === 'status' || !borrowedIntent || borrowedIntent.kind === 'status') throw new Error('Expected repayments');
  assert.equal(loanSavedText(lentIntent, 'Roman', 700), 'Roman vrátil 5,00 €. Zostáva 7,00 €.');
  assert.equal(loanSavedText(borrowedIntent, 'Roman', 700), 'Romanovi si vrátil 5,00 €. Zostáva 7,00 €.');
  assert.match(loanSavedText(lentIntent, 'Roman', 0), /Roman ti už nič nedlhuje/u);
  assert.equal(loanSavedText(borrowedIntent, 'Roman', 0), 'Dlh voči Romanovi je vyrovnaný. ✅');
});

test('repayment stays bounded by the open balance before a movement is recorded', () => {
  assert.match(loanMigration, /if p_amount_minor > v_total then raise exception 'Repayment exceeds open balance' using errcode = '22003'/u);
  assert.match(loanMigration, /v_to_apply := least\(v_remaining, v_available\)/u);
  assert.match(loanMigration, /status = case when repaid_minor \+ v_to_apply = original_minor then 'SETTLED'/u);
});

test('a repeated Telegram update returns the existing loan movement', () => {
  assert.match(loanMigration, /telegram_update_id text not null unique/u);
  assert.match(loanMigration, /where m.telegram_update_id = p_update_id and m.created_by_user_id = v_user_id/u);
  assert.match(loanMigration, /if found then[\s\S]*?was_duplicate := true;[\s\S]*?return next;[\s\S]*?return;/u);
});

test('uncertain, negated and incomplete loan statements cannot fall through to expense parsing', () => {
  for (const sentence of [
    'Už Romanovi nič nedlžím.', 'Roman mi už nič nedlhuje.',
    'Neviem, či Romanovi ešte niečo dlžím.', 'Možno som Romanovi požičal.',
    'Možno som Romanovi požičal 12 €.', 'Roman splatil pôžičku.',
    'Dlžím 12 €.', 'Romanovi dlžím 12 € a Petrovi 5 €.',
  ]) {
    assert.equal(parseLoanIntent(sentence), null, sentence);
    assert.ok(loanClarification(sentence), sentence);
  }
  assert.equal(loanClarification('Káva 3 €'), null);
  assert.equal(loanClarification('Dlžím 12 €.'), 'Komu dlhuješ uvedenú sumu?');
  assert.equal(loanClarification('Roman splatil pôžičku.'), 'Akú sumu mám pri pôžičke zaznamenať?');
});
