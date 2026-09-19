import {
  countFinancialAmounts,
  findFinancialAmounts,
  parseFinancialMessage,
  type ParsedTransaction,
} from './finance-parser.js';

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

function cleanItemDescription(value: string): string {
  return value.replace(/^[\s,;|/–—-]+/u, '').trim();
}

function isStandaloneConnector(value: string): boolean {
  const normalized = value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}]/gu, '');
  return ['a', 'i', 'alebo', 'plus', 'and'].includes(normalized);
}

/**
 * Parses a repeated natural-language sequence such as
 * "pivo 1,50 € Lidl 15 € benzín 20 €". Every range before an amount belongs
 * to that amount; any missing description or trailing ambiguity rejects the
 * whole batch rather than allowing a partial save.
 */
function parseImplicitAmountPairs(text: string): MultiExpenseParseResult {
  const amounts = findFinancialAmounts(text);
  if (amounts.length < 2) return { kind: 'not_multi' };

  const items: ParsedTransaction[] = [];
  let cursor = 0;
  for (const amount of amounts) {
    const description = cleanItemDescription(text.slice(cursor, amount.index));
    if (!description || isStandaloneConnector(description)) return { kind: 'invalid' };
    const parsed = parseFinancialMessage(`${description} ${amount.value}`);
    if (!parsed || !parsed.note.trim()) return { kind: 'invalid' };
    items.push(parsed);
    cursor = amount.end;
  }

  const trailingText = cleanItemDescription(text.slice(cursor));
  if (trailingText && !isPoliteSuffix(trailingText)) return { kind: 'invalid' };
  return { kind: 'valid', items };
}

/**
 * Explicit separators already provide a trustworthy item boundary, so each
 * line/part can support both "description amount" and "amount description".
 * Every part is validated before anything reaches the atomic batch RPC.
 */
function parseExplicitItems(segments: string[]): MultiExpenseParseResult {
  const candidates = segments.map((segment) => segment.trim()).filter(Boolean);
  if (candidates.length < 2) return { kind: 'invalid' };

  const items: ParsedTransaction[] = [];
  for (const segment of candidates) {
    if (countFinancialAmounts(segment) !== 1) return { kind: 'invalid' };
    const parsed = parseFinancialMessage(segment);
    if (!parsed || !parsed.note.trim()) return { kind: 'invalid' };
    items.push(parsed);
  }

  return items.length >= 2 ? { kind: 'valid', items } : { kind: 'not_multi' };
}

/**
 * A multi-entry message is accepted only when every explicitly separated part
 * has a description and exactly one amount. This deliberately makes a batch
 * all-or-nothing instead of silently saving a partial financial record.
 */
export function parseMultiExpenseMessage(text: string): MultiExpenseParseResult {
  const { segments, hasSeparator } = splitCandidateItems(text);
  const amountCount = countFinancialAmounts(text);
  if (!hasSeparator && amountCount < 2) return { kind: 'not_multi' };
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

  if (hasSeparator) return parseExplicitItems(segments);
  return parseImplicitAmountPairs(text);
}
