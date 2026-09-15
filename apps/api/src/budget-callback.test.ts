import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUDGET_AMOUNT_PENDING_TTL_MS,
  EXPIRED_BUDGET_OFFER_MESSAGE,
  acknowledgeBudgetCallback,
  budgetAmountPendingExpiresAt,
  budgetCallbackClaim,
} from './budget-callback.js';

const identity = {
  telegramUserId: '123',
  chatId: '456',
  messageId: '789',
  callbackQueryId: 'callback-1',
  callbackData: 'bgo:00000000-0000-4000-8000-000000000001',
};

test('budget amount window starts when a delayed offer is clicked', () => {
  const offerAt = Date.parse('2026-09-15T13:53:00.000Z');
  const clickedAt = offerAt + 55 * 60_000;

  assert.equal(
    Date.parse(budgetAmountPendingExpiresAt(clickedAt)),
    clickedAt + BUDGET_AMOUNT_PENDING_TTL_MS,
  );
});

test('repeated delivery and repeated tap of the same button share one durable claim', () => {
  const first = budgetCallbackClaim(identity, Date.parse('2026-09-15T14:48:00.000Z'));
  const repeatedDelivery = budgetCallbackClaim(identity, Date.parse('2026-09-15T14:49:00.000Z'));
  const repeatedTap = budgetCallbackClaim(
    { ...identity, callbackQueryId: 'callback-2' },
    Date.parse('2026-09-15T14:49:00.000Z'),
  );

  assert.equal(repeatedDelivery.claimKey, first.claimKey);
  assert.equal(repeatedDelivery.callbackQueryHash, first.callbackQueryHash);
  assert.equal(repeatedTap.claimKey, first.claimKey);
  assert.notEqual(repeatedTap.callbackQueryHash, first.callbackQueryHash);
});

test('another budget action does not reuse the original button claim', () => {
  const accept = budgetCallbackClaim(identity);
  const later = budgetCallbackClaim({ ...identity, callbackData: identity.callbackData.replace('bgo:', 'bgl:') });

  assert.notEqual(accept.claimKey, later.claimKey);
});

test('an invalid old offer has a user-friendly non-technical response', () => {
  assert.equal(EXPIRED_BUDGET_OFFER_MESSAGE, 'Táto ponuka už nie je aktívna. Limit môžete nastaviť novou požiadavkou.');
});

test('an expired Telegram acknowledgement does not abort delayed callback processing', async () => {
  let loggedError: unknown;
  let continued = false;
  const acknowledged = await acknowledgeBudgetCallback(
    async () => { throw new Error('query is too old'); },
    (error) => { loggedError = error; },
  );
  continued = true;

  assert.equal(acknowledged, false);
  assert.match(String(loggedError), /query is too old/u);
  assert.equal(continued, true);
});
