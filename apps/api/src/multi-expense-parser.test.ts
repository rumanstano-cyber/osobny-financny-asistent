import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMultiExpenseMessage } from './multi-expense-parser.js';

function validItems(text: string) {
  const result = parseMultiExpenseMessage(text);
  assert.equal(result.kind, 'valid');
  if (result.kind !== 'valid') throw new Error('Expected valid multi-expense input');
  return result.items;
}

test('splits comma-separated expenses without splitting decimal commas', () => {
  const items = validItems('káva 3 €, Lidl 10 €, benzín 40 €');
  assert.deepEqual(items.map((item) => [item.note, item.amountMinor]), [
    ['káva', 300], ['Lidl', 1000], ['benzín', 4000],
  ]);
});

test('splits space-separated entries after every complete amount', () => {
  const items = validItems('pivo 1,50 € Lidl 15 € benzín 20 € drogéria 12 €');
  assert.deepEqual(items.map((item) => [item.note, item.amountMinor]), [
    ['pivo', 150], ['Lidl', 1500], ['benzín', 2000], ['drogéria', 1200],
  ]);
});

test('splits a space-separated sequence with whole euro amounts', () => {
  const items = validItems('káva 3 € Lidl 10 € benzín 40 €');
  assert.deepEqual(items.map((item) => [item.note, item.amountMinor]), [
    ['káva', 300], ['Lidl', 1000], ['benzín', 4000],
  ]);
});

test('splits decimal-comma and decimal-point sequences without punctuation', () => {
  assert.deepEqual(
    validItems('káva 3,50 € Lidl 10,20 € benzín 40 €').map((item) => item.amountMinor),
    [350, 1020, 4000],
  );
  assert.deepEqual(
    validItems('káva 3.50 € Lidl 10.20 € benzín 40 €').map((item) => item.amountMinor),
    [350, 1020, 4000],
  );
});

test('keeps decimal commas within their own financial item', () => {
  const items = validItems('káva 3,50 €, Lidl 10,20 €, benzín 40 €');
  assert.deepEqual(items.map((item) => item.amountMinor), [350, 1020, 4000]);
});

test('keeps decimal points within their own financial item', () => {
  const items = validItems('káva 3.50 €; Lidl 10.20 €; benzín 40 €');
  assert.deepEqual(items.map((item) => item.amountMinor), [350, 1020, 4000]);
});

test('supports newline-separated expenses and duplicate merchant names', () => {
  const items = validItems('Lidl 10 €\nLidl 25 €\nbenzín 40 €');
  assert.deepEqual(items.map((item) => item.note), ['Lidl', 'Lidl', 'benzín']);
  assert.deepEqual(items.map((item) => item.amountMinor), [1000, 2500, 4000]);
});

test('leaves ordinary single-expense messages on the existing parser path', () => {
  assert.deepEqual(parseMultiExpenseMessage('káva 3,50 €'), { kind: 'not_multi' });
});

test('rejects an ambiguous batch without returning a partial list', () => {
  assert.deepEqual(parseMultiExpenseMessage('káva 3 €, Lidl 10 € a 2 €'), { kind: 'invalid' });
});

test('rejects an incomplete explicitly separated batch instead of saving one item', () => {
  assert.deepEqual(parseMultiExpenseMessage('káva 3 €, Lidl'), { kind: 'invalid' });
});

test('keeps a polite suffix on the ordinary single-expense parser path', () => {
  assert.deepEqual(parseMultiExpenseMessage('káva 3 €, prosím'), { kind: 'not_multi' });
});

test('does not treat warranty duration inputs as multi-expense entries', () => {
  assert.deepEqual(parseMultiExpenseMessage('3 roky'), { kind: 'not_multi' });
  assert.deepEqual(parseMultiExpenseMessage('36 mesiacov'), { kind: 'not_multi' });
});

test('rejects an incomplete natural batch without returning a partial list', () => {
  assert.deepEqual(parseMultiExpenseMessage('pivo 1,50 € Lidl 15 € benzín'), { kind: 'invalid' });
});
