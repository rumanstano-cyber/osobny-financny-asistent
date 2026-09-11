export type ReceiptReminderTelegramApi = {
  sendMessage(chatId: string, text: string): Promise<{ message_id: number }>;
  sendPhoto(chatId: string, photo: string): Promise<unknown>;
};

export type ReceiptReminderDeliveryResult = {
  providerMessageId: string;
  receiptImageError: string | null;
};

/**
 * The text delivery is authoritative. A failed optional image must never turn
 * an otherwise delivered reminder into a retry, because that would duplicate
 * the reminder text on the next worker run.
 */
export async function deliverReceiptReminder(
  api: ReceiptReminderTelegramApi,
  telegramUserId: string,
  text: string,
  signedReceiptUrl: string | null,
): Promise<ReceiptReminderDeliveryResult> {
  const message = await api.sendMessage(telegramUserId, text);
  if (!signedReceiptUrl) return { providerMessageId: String(message.message_id), receiptImageError: null };

  try {
    await api.sendPhoto(telegramUserId, signedReceiptUrl);
    return { providerMessageId: String(message.message_id), receiptImageError: null };
  } catch (error) {
    return {
      providerMessageId: String(message.message_id),
      receiptImageError: error instanceof Error ? error.message : String(error),
    };
  }
}
