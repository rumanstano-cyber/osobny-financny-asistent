import assert from 'node:assert/strict';
import test from 'node:test';
import {
  batchCorrectionTarget,
  batchTransactionCallbackData,
  matchBatchTransactions,
  parseBatchTransactionCallbackData,
  type BatchTransactionCandidate,
} from './multi-expense-correction.js';

const items: BatchTransactionCandidate[] = [
  { transaction_id: '00000000-0000-4000-8000-000000000001', amount_minor: 1000, currency_code: 'EUR', note: 'Lidl', merchant_name: null },
  { transaction_id: '00000000-0000-4000-8000-000000000002', amount_minor: 2500, currency_code: 'EUR', note: 'Lidl', merchant_name: null },
  { transaction_id: '00000000-0000-4000-8000-000000000003', amount_minor: 4000, currency_code: 'EUR', note: 'Benzín', merchant_name: null },
];

test('extracts the intended item from a category correction request', () => {
  assert.equal(batchCorrectionTarget('Zmeň kategóriu Lidl'), 'lidl');
  assert.equal(batchCorrectionTarget('Oprav kategóriu'), null);
});

test('keeps duplicate merchant matches ambiguous for a picker', () => {
  assert.equal(matchBatchTransactions('Lidl', items).length, 2);
  assert.deepEqual(matchBatchTransactions('Benzín', items).map((item) => item.transaction_id), [items[2].transaction_id]);
});

test('batch transaction callback retains only one selected transaction id', () => {
  const callback = batchTransactionCallbackData(items[0].transaction_id);
  assert.ok(callback.length <= 64);
  assert.equal(parseBatchTransactionCallbackData(callback), items[0].transaction_id);
  assert.equal(parseBatchTransactionCallbackData('txb:invalid'), null);
});
