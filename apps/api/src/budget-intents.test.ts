import assert from 'node:assert/strict';
import test from 'node:test';
import { detectBudgetIntent, isBudgetStatusQuestion, parseStandaloneBudgetAmount } from './budget-intents.js';

test('recognizes manual budget intents without hardcoding a category', () => {
  assert.equal(detectBudgetIntent('Nastav limit na potraviny 300 €'), 'set');
  assert.equal(detectBudgetIntent('Zmeň limit na auto na 150 €'), 'change');
  assert.equal(detectBudgetIntent('Zruš limit na potraviny'), 'cancel');
  assert.equal(isBudgetStatusQuestion('Koľko mi ostáva na potraviny?'), true);
});

test('accepts only a standalone pending budget amount', () => {
  assert.equal(parseStandaloneBudgetAmount('300 €')?.amountMinor, 30000);
  assert.equal(parseStandaloneBudgetAmount('daj 250')?.amountMinor, 25000);
  assert.equal(parseStandaloneBudgetAmount('Lidl 42 €'), null);
});
