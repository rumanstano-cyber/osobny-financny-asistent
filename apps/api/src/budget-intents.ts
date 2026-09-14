import { parseFinancialMessage } from './finance-parser.js';

export type BudgetIntent = 'set' | 'change' | 'cancel' | 'status' | null;

function normalized(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

export function detectBudgetIntent(text: string): BudgetIntent {
  const value = normalized(text);
  if (!/\blimit\b/u.test(value)) return null;
  if (/\b(zrus|odstran|vymaz|zmaz)\b/u.test(value)) return 'cancel';
  if (/\b(kolko|ostava|mozem minut|ako som na tom)\b/u.test(value)) return 'status';
  if (/\b(zmen|uprav)\b/u.test(value)) return 'change';
  if (/\b(nastav|daj|chcem|vytvor)\b/u.test(value)) return 'set';
  return null;
}

export function isBudgetStatusQuestion(text: string): boolean {
  const value = normalized(text);
  return /\b(kolko|ostava|mozem minut|ako som na tom)\b/u.test(value)
    && /limit|potravin|jedl|restaurac|auto|drogeri|byvan|zdrav|oblecen/u.test(value);
}

/** Accepts only a standalone limit amount while the bot is waiting for it. */
export function parseStandaloneBudgetAmount(text: string) {
  const parsed = parseFinancialMessage(text);
  if (!parsed || parsed.transactionType !== 'expense') return null;
  const note = normalized(parsed.note).replace(/[^\p{L}]/gu, ' ').trim();
  return /^(|daj|nastav|nastavte|limit)$/u.test(note) ? parsed : null;
}
