const receiptIdPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const receiptProtectionCallbackPattern = new RegExp(`^rpp:(${receiptIdPattern}):([yn])$`, 'i');

export function receiptPurchaseProtectionCallbackData(receiptId: string, keepReceipt: boolean): string {
  return `rpp:${receiptId}:${keepReceipt ? 'y' : 'n'}`;
}

export function parseReceiptPurchaseProtectionCallbackData(value: string): { receiptId: string; keepReceipt: boolean } | null {
  const match = receiptProtectionCallbackPattern.exec(value);
  if (!match) return null;
  return { receiptId: match[1], keepReceipt: match[2].toLowerCase() === 'y' };
}

export function receiptPurchaseProtectionReminderText(days: 60 | 30 | 7): string {
  return `O ${days} dní končí sledovaná zákonná 2-ročná ochrana nákupu. Výrobca alebo predajca môže na tento produkt poskytovať aj dlhšiu záruku, preto odporúčame overiť si jej podmienky, aby ste neprišli o možnosť reklamácie.`;
}
