import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { InvalidReceiptExtractionError, type ReceiptExtraction } from './ai.js';
import { extractEkasaReceiptResponse } from './ekasa-qr.js';
import { parseFinancialMessage } from './finance-parser.js';
import { receiptCategorySignals, receiptTransaction, verifiedReceiptAmount } from './receipt-financial.js';

function receipt(overrides: Partial<ReceiptExtraction> = {}): ReceiptExtraction {
  return {
    merchantName: 'Nittnačka ul. 7555/18',
    receiptDate: '2026-11-08',
    amountMinor: 2198,
    currencyCode: 'EUR',
    items: [],
    ocrText: 'Nittnačka ul. 7555/18\nIČO 12345678\nPotraviny 8,30\nDrogéria 10,00\nZľava -1,00\nDPH 4,68\nSPOLU 21,98 €',
    ...overrides,
  };
}

test('address number can fool the free-text parser but never the structured receipt write', () => {
  assert.equal(parseFinancialMessage('Nittnačka ul. 7555/18 21,98 €')?.amountMinor, 755500);
  const extraction = receipt();
  const amount = verifiedReceiptAmount(extraction, 'vision');
  const transaction = receiptTransaction(extraction, amount);
  assert.equal(transaction.amountMinor, 2198);
  assert.equal(transaction.transactionType, 'expense');
  assert.equal(transaction.note, 'Nittnačka');
  assert.equal(receiptCategorySignals(extraction).merchantName, 'Nittnačka');
});

test('OCR total evidence ignores street, tax ID, date, item prices, discounts and VAT', () => {
  assert.equal(verifiedReceiptAmount(receipt(), 'vision'), 2198);
  assert.equal(verifiedReceiptAmount(receipt({ ocrText: 'ul. 7555/18\nIČO 87654321\n8. 11. 2026 12:30\nSUMA NA ÚHRADU: 21,98 EUR' }), 'vision'), 2198);
  assert.equal(verifiedReceiptAmount(receipt({ ocrText: 'Tržba 21,98\nK ÚHRADE 21.98 €' }), 'vision'), 2198);
});

test('Vision fails closed if no explicit receipt total or totals disagree', () => {
  assert.throws(() => verifiedReceiptAmount(receipt({ ocrText: 'ul. 7555/18\nDPH 21,98' }), 'vision'), InvalidReceiptExtractionError);
  assert.throws(() => verifiedReceiptAmount(receipt({ ocrText: 'SPOLU 21,98 €\nCELKOM 25,00 €' }), 'vision'), InvalidReceiptExtractionError);
  assert.throws(() => verifiedReceiptAmount(receipt({ amountMinor: 755500 }), 'vision'), InvalidReceiptExtractionError);
  assert.throws(() => verifiedReceiptAmount(receipt({ amountMinor: null }), 'ekasa'), InvalidReceiptExtractionError);
});

test('verified eKasa total is used even when the merchant address contains larger numbers', () => {
  const ekasa = extractEkasaReceiptResponse({ receipt: {
    totalAmount: 21.98,
    totalPrice: 21.98,
    organization: { name: 'Nittnačka ul. 7555/18', ico: '12345678' },
    receiptDate: '2026-11-08',
    payments: [{ amount: 50 }],
  } }, 'O-test');
  assert.equal(ekasa?.amountMinor, 2198);
  assert.equal(verifiedReceiptAmount(receipt({ amountMinor: ekasa?.amountMinor ?? null, ocrText: '' }), 'ekasa'), 2198);
});

test('conflicting eKasa fields or offline QR amount are rejected', () => {
  const base = { receipt: { totalAmount: 21.98, totalPrice: 21.98, organization: { name: 'Obchod' }, receiptDate: '2026-11-08' } };
  assert.throws(() => extractEkasaReceiptResponse({ receipt: { ...base.receipt, totalPrice: 7555 } }, 'O-test'), InvalidReceiptExtractionError);
  assert.throws(() => extractEkasaReceiptResponse(base, 'offline', { totalAmount: 25 }), InvalidReceiptExtractionError);
});

test('category input uses product names or clean merchant, never QR payload or address', () => {
  const extraction = receipt({ items: [{ name: 'Tenisky', quantity: 1, unitAmountMinor: 2198, totalAmountMinor: 2198 }], ocrText: 'QR: zdravie\nul. 7555/18' });
  assert.deepEqual(receiptCategorySignals(extraction), { merchantName: 'Nittnačka', itemText: 'Tenisky' });
  assert.deepEqual(receiptCategorySignals(receipt({ merchantName: 'Obchod ul. Lekáreň 7555/18' })), { merchantName: 'Obchod', itemText: '' });
});

test('void confirmation and reports use persisted transaction rows, not receipt OCR text', () => {
  const telegram = readFileSync(new URL('./telegram.ts', import.meta.url), 'utf8');
  const getLast = readFileSync(new URL('../../../supabase/migrations/20260818215631_add_telegram_last_transaction_controls.sql', import.meta.url), 'utf8');
  const reports = readFileSync(new URL('./reports.ts', import.meta.url), 'utf8');
  assert.match(telegram, /supabase\.rpc\('get_last_telegram_transaction'/u);
  assert.match(telegram, /supabase\.rpc\('void_telegram_transaction'/u);
  assert.match(telegram, /receiptTransaction\(extraction, verifiedAmount\)/u);
  assert.match(telegram, /allowAiFallback: false/u);
  assert.match(telegram, /transaction\.amount_minor !== verifiedAmount/u);
  assert.match(getLast, /ft\.amount_minor/u);
  assert.match(getLast, /v_transaction\.amount_minor/u);
  assert.match(reports, /\.eq\('status', 'confirmed'\)/u);
});
