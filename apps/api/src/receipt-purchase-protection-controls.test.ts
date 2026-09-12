import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatWarrantyDuration,
  parseWarrantyDurationMonths,
  parseReceiptPurchaseProtectionCallbackData,
  receiptPurchaseProtectionCallbackData,
  receiptPurchaseProtectionReminderText,
} from './receipt-purchase-protection-controls.js';
import { parseFinancialMessage } from './finance-parser.js';

const receiptId = '00000000-0000-4000-8000-000000000001';

test('receipt protection callback data is compact and carries only the receipt id and decision', () => {
  const yes = receiptPurchaseProtectionCallbackData(receiptId, true);
  const no = receiptPurchaseProtectionCallbackData(receiptId, false);

  assert.ok(yes.length <= 64);
  assert.deepEqual(parseReceiptPurchaseProtectionCallbackData(yes), { receiptId, keepReceipt: true });
  assert.deepEqual(parseReceiptPurchaseProtectionCallbackData(no), { receiptId, keepReceipt: false });
  assert.equal(parseReceiptPurchaseProtectionCallbackData('rpp:not-a-receipt:y'), null);
  assert.equal(parseReceiptPurchaseProtectionCallbackData('claim:' + receiptId), null);
});

test('each reminder names the receipt merchant and purchase date', () => {
  for (const days of [60, 30, 7] as const) {
    const text = receiptPurchaseProtectionReminderText(days, 'LIDL', '2026-09-10');
    assert.match(text, new RegExp(`O ${days} dní`, 'u'));
    assert.match(text, /dokladu z LIDL z 10\. 9\. 2026\./u);
    assert.doesNotMatch(text, /produkt/iu);
  }
});

test('warranty duration parser recognizes Slovak year and month expressions safely', () => {
  assert.equal(parseWarrantyDurationMonths('moja záruka je 3 roky'), 36);
  assert.equal(parseWarrantyDurationMonths('3 roky'), 36);
  assert.equal(parseWarrantyDurationMonths('3.roky'), 36);
  assert.equal(parseWarrantyDurationMonths('3roky'), 36);
  assert.equal(parseWarrantyDurationMonths('36 mesiacov'), 36);
  assert.equal(parseWarrantyDurationMonths('3 a pol roka'), 42);
  assert.equal(parseWarrantyDurationMonths('2 roky a 6 mesiacov'), 30);
  assert.equal(parseWarrantyDurationMonths('káva 3 €'), null);
  assert.ok(parseFinancialMessage('káva 3 €'));
  assert.equal(formatWarrantyDuration(30), '2 roky a 6 mesiacov');
});
