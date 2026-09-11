import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseReceiptPurchaseProtectionCallbackData,
  receiptPurchaseProtectionCallbackData,
  receiptPurchaseProtectionReminderText,
} from './receipt-purchase-protection-controls.js';

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

test('each reminder uses the approved cautious legal wording', () => {
  for (const days of [60, 30, 7] as const) {
    const text = receiptPurchaseProtectionReminderText(days);
    assert.match(text, new RegExp(`O ${days} dní`, 'u'));
    assert.match(text, /môže na tento produkt poskytovať aj dlhšiu záruku/iu);
    assert.match(text, /odporúčame overiť si jej podmienky/iu);
    assert.doesNotMatch(text, /končí reklamácia|zanika.*právo/iu);
  }
});
