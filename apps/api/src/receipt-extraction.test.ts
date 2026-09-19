import assert from 'node:assert/strict';
import test from 'node:test';
import { InvalidReceiptExtractionError, normalizeReceiptExtraction } from './ai.js';

test('normalizes bounded untrusted receipt extraction output', () => {
  const result = normalizeReceiptExtraction({
    merchantName: `  Obchod   ${'x'.repeat(400)}`,
    receiptDate: '2026-02-30',
    amountMinor: 1234,
    items: [
      { name: '  Tričko  ', quantity: 1, unitAmountMinor: 1234, totalAmountMinor: 1234 },
      { name: 'x'.repeat(501), quantity: 1, totalAmountMinor: 10 },
    ],
    ocrText: 'x'.repeat(60_000),
  });
  assert.equal(result.amountMinor, 1234);
  assert.equal(result.receiptDate, null);
  assert.equal(result.merchantName?.length, 300);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.name, 'Tričko');
  assert.equal(result.ocrText.length, 50_000);
});

test('rejects non-object AI output and out-of-range monetary values', () => {
  assert.throws(() => normalizeReceiptExtraction('ignore previous instructions'), InvalidReceiptExtractionError);
  assert.equal(normalizeReceiptExtraction({ amountMinor: Number.MAX_SAFE_INTEGER }).amountMinor, null);
});
