import { createHash } from 'node:crypto';

export const BUDGET_AMOUNT_PENDING_TTL_MS = 15 * 60_000;
export const BUDGET_CALLBACK_CLAIM_TTL_MS = 30 * 24 * 60 * 60_000;
export const EXPIRED_BUDGET_OFFER_MESSAGE = 'Táto ponuka už nie je aktívna. Limit môžete nastaviť novou požiadavkou.';

export type BudgetCallbackIdentity = {
  telegramUserId: string;
  chatId: string;
  messageId: string;
  callbackQueryId: string;
  callbackData: string;
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function budgetCallbackClaim(identity: BudgetCallbackIdentity, nowMs = Date.now()): {
  claimKey: string;
  callbackQueryHash: string;
  expiresAt: string;
} {
  const buttonIdentity = JSON.stringify([
    identity.telegramUserId,
    identity.chatId,
    identity.messageId,
    identity.callbackData,
  ]);

  return {
    claimKey: sha256(buttonIdentity),
    callbackQueryHash: sha256(identity.callbackQueryId),
    expiresAt: new Date(nowMs + BUDGET_CALLBACK_CLAIM_TTL_MS).toISOString(),
  };
}

export function budgetAmountPendingExpiresAt(clickedAtMs = Date.now()): string {
  return new Date(clickedAtMs + BUDGET_AMOUNT_PENDING_TTL_MS).toISOString();
}

export async function acknowledgeBudgetCallback(
  answer: () => Promise<unknown>,
  onError: (error: unknown) => void,
): Promise<boolean> {
  try {
    await answer();
    return true;
  } catch (error) {
    // Telegram can reject an old callback acknowledgement even though the
    // message, user and category context are still safe to process.
    onError(error);
    return false;
  }
}
