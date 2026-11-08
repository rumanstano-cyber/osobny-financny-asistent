import { InvalidReceiptExtractionError, type ReceiptExtraction } from './ai.js';
import type { ParsedTransaction } from './finance-parser.js';

const MAX_RECEIPT_AMOUNT_MINOR = 10_000_000_000;
const TOTAL_LABEL = /^(?:spolu|celkom|k\s+uhrad[eu]|suma\s+(?:na|k)\s+uhrad[eu]|total|to\s+pay)\s*[:=\-]?\s*/iu;
const TOTAL_AMOUNT = /^(?:€\s*)?(\d{1,9}(?:[ \u00a0\u202f]\d{3})*(?:[,.]\d{1,2})?|\d{1,12}(?:[,.]\d{1,2})?)\s*(?:€|eur)?$/iu;

function totalEvidenceAmounts(text: string): number[] {
  const amounts: number[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const normalized = line.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').trim();
    const prefix = TOTAL_LABEL.exec(normalized);
    if (!prefix) continue;
    const match = TOTAL_AMOUNT.exec(normalized.slice(prefix[0].length).trim());
    if (!match) continue;
    const raw = match[1].replace(/[ \u00a0\u202f]/gu, '').replace(',', '.');
    const [whole, fraction = ''] = raw.split('.');
    const minor = Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
    if (Number.isSafeInteger(minor) && minor > 0 && minor <= MAX_RECEIPT_AMOUNT_MINOR) amounts.push(minor);
  }
  return amounts;
}

/** Receipt totals are structured values, never numbers rediscovered in merchant or OCR prose. */
export function verifiedReceiptAmount(extraction: ReceiptExtraction, source: 'ekasa' | 'vision'): number {
  const amount = extraction.amountMinor;
  if (!Number.isSafeInteger(amount) || amount === null || amount <= 0 || amount > MAX_RECEIPT_AMOUNT_MINOR) {
    throw new InvalidReceiptExtractionError('Receipt total is missing or invalid');
  }
  if (source === 'vision') {
    const evidence = totalEvidenceAmounts(extraction.ocrText);
    if (!evidence.length || evidence.some((candidate) => candidate !== amount)) {
      throw new InvalidReceiptExtractionError('Receipt total has no matching unambiguous total line');
    }
  }
  return amount;
}

/** Address and raw QR/OCR text are not category signals. Product lines take priority. */
export function receiptCategorySignals(extraction: ReceiptExtraction): { merchantName: string | null; itemText: string } {
  const merchantName = extraction.merchantName
    ?.split(/\b(?:ul\.?|ulica|n[aá]mestie|adresa|prev[aá]dzka)\b/iu)[0]
    ?.replace(/\s+\d[\d/\-]*\s*$/u, '')
    .trim() || null;
  const itemText = extraction.items.map((item) => item.name).filter(Boolean).join('\n').slice(0, 4_000);
  return { merchantName, itemText };
}

export function receiptTransaction(extraction: ReceiptExtraction, amountMinor: number): ParsedTransaction {
  return {
    amountMinor,
    currencyCode: 'EUR',
    transactionType: 'expense',
    categorySlug: 'ostatne',
    categoryLabel: 'Ostatné',
    note: receiptCategorySignals(extraction).merchantName || 'Bloček',
  };
}
