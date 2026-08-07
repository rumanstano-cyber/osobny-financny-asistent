import { classifyExpenseWithAi } from './ai.js';
import { supabase } from './supabase.js';

type MatchType = 'contains' | 'exact';
type RuleCategory = { slug: string; name: string; transaction_type: 'expense' | 'income'; is_active: boolean; is_archived: boolean };
type CategoryRule = { keyword: string; match_type: MatchType; category: RuleCategory | RuleCategory[] | null };

export type ExpenseCategorization = {
  slug: string;
  label: string;
  source: 'rule' | 'ai' | 'fallback';
  confidence: number;
  reason: string;
};

export type CategorizationInput = { messageText?: string; merchantName?: string | null; receiptText?: string | null };

const expenseCategories = {
  auto: 'Auto',
  byvanie: 'Bývanie',
  domacnost: 'Domácnosť',
  potraviny: 'Potraviny',
  restauracie: 'Reštaurácie',
  poistenie: 'Poistenie',
  zdravie: 'Zdravie',
  drogeria: 'Drogéria',
  oblecenie: 'Oblečenie',
  elektronika: 'Elektronika',
  deti: 'Deti',
  dovolenka: 'Dovolenka',
  zabava: 'Zábava',
  ostatne: 'Ostatné',
} as const;

type ExpenseCategorySlug = keyof typeof expenseCategories;
const cacheTtlMs = 5 * 60_000;
let cachedRules: { expiresAt: number; rules: CategoryRule[] } | null = null;

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('sk-SK').trim();
}

function firstCategory(value: CategoryRule['category']): RuleCategory | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function isExpenseCategorySlug(value: string): value is ExpenseCategorySlug {
  return Object.hasOwn(expenseCategories, value);
}

async function loadRules(): Promise<CategoryRule[]> {
  if (cachedRules && cachedRules.expiresAt > Date.now()) return cachedRules.rules;
  const { data, error } = await supabase
    .from('category_rules')
    .select('keyword, match_type, category:categories!inner(slug, name, transaction_type, is_active, is_archived)')
    .eq('is_active', true);
  if (error) {
    console.warn('Category rule lookup failed', { error: error.message });
    return cachedRules?.rules ?? [];
  }
  const rules = (data ?? []) as unknown as CategoryRule[];
  cachedRules = { rules, expiresAt: Date.now() + cacheTtlMs };
  return rules;
}

function fallback(): ExpenseCategorization {
  return { slug: 'ostatne', label: expenseCategories.ostatne, source: 'fallback', confidence: 0, reason: 'No matching rule or sufficiently confident AI classification' };
}

export async function categorizeExpense(input: CategorizationInput): Promise<ExpenseCategorization> {
  const context = [input.merchantName, input.messageText, input.receiptText].filter((value): value is string => Boolean(value?.trim())).join('\n');
  const normalizedContext = normalize(context);
  if (!normalizedContext) return fallback();

  const matchingRules = (await loadRules())
    .map((rule) => ({ rule, category: firstCategory(rule.category), normalizedKeyword: normalize(rule.keyword) }))
    .filter(({ category, normalizedKeyword, rule }) => category
      && category.transaction_type === 'expense'
      && category.is_active
      && !category.is_archived
      && (rule.match_type === 'exact' ? normalizedContext === normalizedKeyword : normalizedContext.includes(normalizedKeyword)))
    .sort((left, right) => Number(right.rule.match_type === 'exact') - Number(left.rule.match_type === 'exact') || right.normalizedKeyword.length - left.normalizedKeyword.length);

  const match = matchingRules[0];
  if (match?.category && isExpenseCategorySlug(match.category.slug)) {
    return { slug: match.category.slug, label: match.category.name, source: 'rule', confidence: 1, reason: `Matched ${match.rule.match_type} rule: ${match.rule.keyword}` };
  }

  const aiResult = await classifyExpenseWithAi(context);
  if (aiResult && aiResult.confidence > 0.8 && isExpenseCategorySlug(aiResult.categorySlug)) {
    return { slug: aiResult.categorySlug, label: expenseCategories[aiResult.categorySlug], source: 'ai', confidence: aiResult.confidence, reason: aiResult.reason };
  }
  return fallback();
}
