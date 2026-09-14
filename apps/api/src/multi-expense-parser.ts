import { countFinancialAmounts, parseFinancialMessage, type ParsedTransaction } from './finance-parser.js';

export type MultiExpenseParseResult =
  | { kind: 'not_multi' }
  | { kind: 'invalid' }
  | { kind: 'valid'; items: ParsedTransaction[] };

/**
 * Splits only on unambiguous separators. A comma between two digits remains a
 * decimal separator, so both "3,50 €" and "3.50 €" stay one amount.
 */
function splitCandidateItems(text: string): { segments: string[]; hasSeparator: boolean } {
  const hasSeparator = /[;\n]/u.test(text) || /(?<!\d),(?!\d)/u.test(text);
  if (!hasSeparator) return { segments: [text], hasSeparator: false };
  return {
    segments: text.split(/(?:[;\n]+|(?<!\d),(?!\d))/u),
    hasSeparator: true,
  };
}

function isPoliteSuffix(segment: string): boolean {
  const normalized = segment
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}]/gu, '');
  return ['prosim', 'dakujem', 'vdaka'].includes(normalized);
}

/**
 * A multi-entry message is accepted only when every explicitly separated part
 * has a description and exactly one amount. This deliberately makes a batch
 * all-or-nothing instead of silently saving a partial financial record.
 */
export function parseMultiExpenseMessage(text: string): MultiExpenseParseResult {
  const { segments, hasSeparator } = splitCandidateItems(text);
  if (!hasSeparator) return { kind: 'not_multi' };

  const amountCount = countFinancialAmounts(text);
  // Do not let an obviously incomplete batch fall through to the single-entry
  // parser. Polite trailing words remain valid for the ordinary entry path.
  if (amountCount < 2) {
    const hasIncompleteItem = segments.some(
      (segment) => segment.trim().length > 0
        && countFinancialAmounts(segment) === 0
        && !isPoliteSuffix(segment),
    );
    return hasIncompleteItem ? { kind: 'invalid' } : { kind: 'not_multi' };
  }
  if (segments.length < 2 || segments.some((segment) => !segment.trim())) return { kind: 'invalid' };

  const items: ParsedTransaction[] = [];
  for (const segment of segments) {
    if (countFinancialAmounts(segment) !== 1) return { kind: 'invalid' };
    const parsed = parseFinancialMessage(segment.trim());
    if (!parsed || !parsed.note.trim()) return { kind: 'invalid' };
    items.push(parsed);
  }

  return items.length >= 2 ? { kind: 'valid', items } : { kind: 'not_multi' };
}
