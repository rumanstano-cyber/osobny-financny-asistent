import assert from 'node:assert/strict';
import test from 'node:test';
import { dativePerson, findPersonMatches, loanClarification, parseLoanIntent } from './loan-intents.js';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role';
process.env.INTERNAL_CRON_SECRET ??= 'test-internal-cron-secret-32-chars';

const { loanSavedText } = await import('./loan-service.js');

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
