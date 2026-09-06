import assert from 'node:assert/strict';
import test from 'node:test';
import {
  categoryButtonRows,
  categoryCallbackData,
  categoryCorrectionDecision,
  isCategoryCorrectionRequest,
  parseCategoryCallbackData,
  resolveNaturalCategory,
  type ActiveCategory,
} from './category-correction.js';

const categories: ActiveCategory[] = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'Potraviny', slug: 'potraviny', icon: null },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Reštaurácie', slug: 'restauracie', icon: null },
  { id: '00000000-0000-4000-8000-000000000003', name: 'Auto', slug: 'auto', icon: null },
];

test('opens the category picker for an ambiguous correction request', () => {
  assert.equal(isCategoryCorrectionRequest('Oprav kategóriu'), true);
  assert.equal(isCategoryCorrectionRequest('Zmeň kategóriu'), true);
  assert.equal(isCategoryCorrectionRequest('Zmen kategoriu'), true);
  assert.deepEqual(categoryCorrectionDecision('Oprav kategóriu', true, categories), {
    kind: 'show_picker', reason: 'unresolved',
  });
});

test('lays active categories out as two buttons per row', () => {
  assert.deepEqual(categoryButtonRows(categories).map((row) => row.map((category) => category.name)), [
    ['Potraviny', 'Reštaurácie'],
    ['Auto'],
  ]);
});

test('resolves a natural destination category and ignores the negated old category', () => {
  const result = resolveNaturalCategory('Kávu zaraď do reštaurácie, nie do potravín.', categories);
  assert.equal(result.category?.name, 'Reštaurácie');
  assert.equal(result.confidence, 'exact');
});

test('does not change a category for a negated statement without a replacement', () => {
  assert.deepEqual(resolveNaturalCategory('To nie sú potraviny.', categories), {
    category: null, confidence: 'ambiguous',
  });
});

test('reports that no correction is possible without a last transaction', () => {
  assert.deepEqual(categoryCorrectionDecision('Oprav kategóriu', false, categories), {
    kind: 'no_last_transaction',
  });
});

test('category callback data retains the picker token and selected category only', () => {
  const transactionId = '00000000-0000-4000-8000-000000000099';
  const callback = categoryCallbackData(transactionId, categories[1].id);
  assert.ok(callback.length <= 64);
  assert.deepEqual(parseCategoryCallbackData(callback), { transactionId, categoryId: categories[1].id });
  assert.equal(parseCategoryCallbackData('txc:invalid'), null);
});
