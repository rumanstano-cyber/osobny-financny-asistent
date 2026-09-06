export type ActiveCategory = {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
};

export type CategoryPickerContext = {
  token: string;
  telegramUserId: string;
  transactionId: string;
  expiresAt: number;
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

export function categoryCallbackData(token: string, categoryId: string): string {
  return `txc:${token}:${categoryId}`;
}

export function parseCategoryCallbackData(value: string): { token: string; categoryId: string } | null {
  const match = /^txc:([a-f0-9]{12}):([0-9a-f-]{36})$/i.exec(value);
  return match ? { token: match[1], categoryId: match[2] } : null;
}
