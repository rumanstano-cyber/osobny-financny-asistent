export type ActiveCategory = {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
};

export type NaturalCategoryResolution =
  | { category: ActiveCategory; confidence: 'exact' }
  | { category: null; confidence: 'ambiguous' | 'none' };

export type CategoryCorrectionDecision =
  | { kind: 'no_last_transaction' }
  | { kind: 'apply_category'; category: ActiveCategory }
  | { kind: 'show_picker'; reason: 'ambiguous' | 'unresolved' };

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('sk-SK')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Detects a category-only correction without interfering with amount corrections. */
export function isCategoryCorrectionRequest(text: string): boolean {
  const normalized = normalize(text);
  return /\b(oprav|oprava|zmen|presun|zarad)\b.*\bkategori/.test(normalized)
    || /\b(daj|zarad|presun)\b.*\b(do|na|pod)\b/.test(normalized)
    || /\bto\s+nie\s+(je|su)\b/.test(normalized);
}

function destinationText(normalizedText: string): string | null {
  const match = normalizedText.match(/\b(?:daj|zarad|presun)\b[\s\p{L}\p{N}]*?\b(?:do|na|pod)\s+([^,.!?]+)/u);
  return match?.[1]?.trim() || null;
}

function matchingCategories(text: string, categories: ActiveCategory[]): ActiveCategory[] {
  const normalizedText = normalize(text);
  return categories.filter((category) => {
    const name = normalize(category.name);
    const slug = normalize(category.slug.replace(/-/g, ' '));
    return Boolean(name && (normalizedText.includes(name) || normalizedText.includes(slug)));
  });
}

/**
 * Resolves an explicit, database-provided category name. A negated statement
 * ("to nie sú potraviny") intentionally returns ambiguous: it never guesses a
 * replacement category.
 */
export function resolveNaturalCategory(text: string, categories: ActiveCategory[]): NaturalCategoryResolution {
  const normalizedText = normalize(text);
  if (/\bnie\b/.test(normalizedText) && !destinationText(normalizedText)) {
    return { category: null, confidence: 'ambiguous' };
  }

  const destination = destinationText(normalizedText);
  const matches = matchingCategories(destination ?? normalizedText, categories);
  return matches.length === 1
    ? { category: matches[0], confidence: 'exact' }
    : { category: null, confidence: matches.length > 1 ? 'ambiguous' : 'none' };
}

/** The pure first step of the Telegram flow; safe to unit-test without I/O. */
export function categoryCorrectionDecision(
  text: string,
  hasLastTransaction: boolean,
  categories: ActiveCategory[],
): CategoryCorrectionDecision {
  if (!hasLastTransaction) return { kind: 'no_last_transaction' };
  const resolution = resolveNaturalCategory(text, categories);
  return resolution.category
    ? { kind: 'apply_category', category: resolution.category }
    : { kind: 'show_picker', reason: resolution.confidence === 'ambiguous' ? 'ambiguous' : 'unresolved' };
}

/** Two category buttons per line keep the picker readable on a phone. */
export function categoryButtonRows(categories: ActiveCategory[]): ActiveCategory[][] {
  return categories.reduce<ActiveCategory[][]>((rows, category, index) => {
    if (index % 2 === 0) rows.push([category]);
    else rows[rows.length - 1].push(category);
    return rows;
  }, []);
}

function uuidToBase64Url(value: string): string | null {
  const hex = value.replace(/-/g, '');
  if (!/^[a-f0-9]{32}$/i.test(hex)) return null;
  return Buffer.from(hex, 'hex').toString('base64url');
}

function base64UrlToUuid(value: string): string | null {
  if (!/^[A-Za-z0-9_-]{22}$/.test(value)) return null;
  const hex = Buffer.from(value, 'base64url').toString('hex');
  if (!/^[a-f0-9]{32}$/i.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Telegram limits callback data to 64 bytes. UUIDs encoded as base64url fit
 * comfortably and keep the picker valid across a Render restart. The database
 * RPC still verifies the Telegram user and that this is their latest record.
 */
export function categoryCallbackData(transactionId: string, categoryId: string): string {
  const transaction = uuidToBase64Url(transactionId);
  const category = uuidToBase64Url(categoryId);
  if (!transaction || !category) throw new Error('Invalid UUID for category callback');
  return `txc:${transaction}:${category}`;
}

export function parseCategoryCallbackData(value: string): { transactionId: string; categoryId: string } | null {
  const match = /^txc:([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{22})$/.exec(value);
  if (!match) return null;
  const transactionId = base64UrlToUuid(match[1]);
  const categoryId = base64UrlToUuid(match[2]);
  return transactionId && categoryId ? { transactionId, categoryId } : null;
}
