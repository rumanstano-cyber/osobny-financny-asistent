const receiptIdPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const receiptProtectionCallbackPattern = new RegExp(`^rpp:(${receiptIdPattern}):([yn])$`, 'i');

/**
 * Accepts a bare duration ("3 roky") or a warranty-related sentence.
 * The caller still scopes the result to the user's most recently selected
 * purchase protection, so an unrelated amount or transaction is never used.
 */
export function parseWarrantyDurationMonths(value: string): number | null {
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .trim();
  const durationOnly = /^(?:\d+\s*rok(?:y|ov|a)?(?:\s+a\s+\d+\s*mesiac(?:ov|e|a)?)?|\d+\s+a\s+pol\s+rok(?:y|ov|a)?|\d+\s*(?:mesiac(?:ov|e|a)?|mes\.))\s*$/u.test(normalized);
  const mentionsWarranty = /z[aá]ruk|reklam[aá]ci/iu.test(value);
  if (!durationOnly && !mentionsWarranty) return null;

  const combined = /\b(\d+)\s*rok(?:y|ov|a)?\s+a\s*(\d+)\s*mesiac(?:ov|e|a)?\b/u.exec(normalized);
  if (combined) return Number(combined[1]) * 12 + Number(combined[2]);

  const halfYear = /\b(\d+)\s+a\s+pol\s+rok(?:y|ov|a)?\b/u.exec(normalized);
  if (halfYear) return Number(halfYear[1]) * 12 + 6;

  const months = /\b(\d+)\s*(?:mesiac(?:ov|e|a)?|mes\.)\b/u.exec(normalized);
  if (months) return Number(months[1]);

  const years = /\b(\d+)\s*(?:rok(?:y|ov|a)?|r\.)\b/u.exec(normalized);
  return years ? Number(years[1]) * 12 : null;
}

export function formatWarrantyDuration(months: number): string {
  const years = Math.floor(months / 12);
  const remainder = months % 12;
  if (remainder === 0) return `${years} ${years === 1 ? 'rok' : years >= 2 && years <= 4 ? 'roky' : 'rokov'}`;
  return `${years} ${years === 1 ? 'rok' : years >= 2 && years <= 4 ? 'roky' : 'rokov'} a ${remainder} ${remainder === 1 ? 'mesiac' : remainder >= 2 && remainder <= 4 ? 'mesiace' : 'mesiacov'}`;
}

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
