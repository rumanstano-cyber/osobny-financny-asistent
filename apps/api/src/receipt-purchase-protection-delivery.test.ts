import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverReceiptReminder } from './receipt-purchase-protection-delivery.js';

test('reminder sends its stored receipt image after the text', async () => {
  const calls: string[] = [];
  const result = await deliverReceiptReminder({
    sendMessage: async () => {
      calls.push('text');
      return { message_id: 101 };
    },
    sendPhoto: async () => {
      calls.push('photo');
      return {};
    },
  }, 'telegram-user', 'Reminder', 'https://signed.example/receipt.jpg');

  assert.deepEqual(calls, ['text', 'photo']);
  assert.equal(result.providerMessageId, '101');
  assert.equal(result.receiptImageError, null);
});

test('an unavailable receipt image does not prevent a delivered reminder', async () => {
  let textSent = false;
  const result = await deliverReceiptReminder({
    sendMessage: async () => {
      textSent = true;
      return { message_id: 102 };
    },
    sendPhoto: async () => {
      throw new Error('receipt unavailable');
    },
  }, 'telegram-user', 'Reminder', 'https://signed.example/receipt.jpg');

  assert.equal(textSent, true);
  assert.equal(result.providerMessageId, '102');
  assert.equal(result.receiptImageError, 'receipt unavailable');
});
