import { classifyExpenseWithAi } from './ai.js';
import { supabase } from './supabase.js';
import { safeErrorLog } from './safe-log.js';

type MatchType = 'contains' | 'exact';
type RuleCategory = { slug: string; name: string; transaction_type: 'expense' | 'income'; is_active: boolean; is_archived: boolean };
type CategoryRule = { keyword: string; match_type: MatchType; category: RuleCategory | RuleCategory[] | null };
type ActiveCategory = { slug: string; name: string };

export type ExpenseCategorization = {
  slug: string;
  label: string;
  source: 'rule' | 'ai' | 'fallback';
  confidence: number;
  reason: string;
};

export type CategorizationInput = { telegramUserId: string; messageText?: string; merchantName?: string | null; receiptText?: string | null };
const cacheTtlMs = 5 * 60_000;
let cachedRules: { expiresAt: number; rules: CategoryRule[] } | null = null;
const categoryCache = new Map<string, { expiresAt: number; categories: ActiveCategory[] }>();

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('sk-SK').trim();
}

function firstCategory(value: CategoryRule['category']): RuleCategory | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

async function loadActiveCategories(telegramUserId: string): Promise<ActiveCategory[]> {
  const cached = categoryCache.get(telegramUserId);
  if (cached && cached.expiresAt > Date.now()) return cached.categories;
  const { data, error } = await supabase.rpc('get_telegram_active_expense_categories', { p_telegram_user_id: telegramUserId });
  if (error) throw new Error(error.message);
  const categories = ((data ?? []) as ActiveCategory[]).filter((category) => category.slug && category.name);
  categoryCache.set(telegramUserId, { categories, expiresAt: Date.now() + cacheTtlMs });
  return categories;
}

async function loadRules(): Promise<CategoryRule[]> {
  if (cachedRules && cachedRules.expiresAt > Date.now()) return cachedRules.rules;
  const { data, error } = await supabase
    .from('category_rules')
    .select('keyword, match_type, category:categories!inner(slug, name, transaction_type, is_active, is_archived)')
    .eq('is_active', true);
  if (error) {
    console.warn('Category rule lookup failed', { error: safeErrorLog(error) });
    return cachedRules?.rules ?? [];
  }
  const rules = (data ?? []) as unknown as CategoryRule[];
  cachedRules = { rules, expiresAt: Date.now() + cacheTtlMs };
  return rules;
}

function fallback(categories: ActiveCategory[]): ExpenseCategorization {
  const category = categories.find((item) => item.slug === 'ostatne') ?? categories[0];
  if (!category) throw new Error('No active expense category is configured for this Telegram account');
  return { slug: category.slug, label: category.name, source: 'fallback', confidence: 0, reason: 'No matching rule or sufficiently confident AI classification' };
}

export async function categorizeExpense(input: CategorizationInput): Promise<ExpenseCategorization> {
  const activeCategories = await loadActiveCategories(input.telegramUserId);
  const categoryBySlug = new Map(activeCategories.map((category) => [category.slug, category]));
  const context = [input.merchantName, input.messageText, input.receiptText].filter((value): value is string => Boolean(value?.trim())).join('\n');
  const normalizedContext = normalize(context);
  if (!normalizedContext) return fallback(activeCategories);

  const matchingRules = (await loadRules())
    .map((rule) => ({ rule, category: firstCategory(rule.category), normalizedKeyword: normalize(rule.keyword) }))
    .filter(({ category, normalizedKeyword, rule }) => category
      && category.transaction_type === 'expense'
      && category.is_active
      && !category.is_archived
      && (rule.match_type === 'exact' ? normalizedContext === normalizedKeyword : normalizedContext.includes(normalizedKeyword)))
    .sort((left, right) => Number(right.rule.match_type === 'exact') - Number(left.rule.match_type === 'exact') || right.normalizedKeyword.length - left.normalizedKeyword.length);

  const match = matchingRules[0];
  const matchedCategory = match?.category ? categoryBySlug.get(match.category.slug) : undefined;
  if (match?.category && matchedCategory) {
    return { slug: matchedCategory.slug, label: matchedCategory.name, source: 'rule', confidence: 1, reason: `Matched ${match.rule.match_type} rule: ${match.rule.keyword}` };
  }

  const aiResult = await classifyExpenseWithAi(context, activeCategories, `telegram:${input.telegramUserId}`);
  const aiCategory = aiResult ? categoryBySlug.get(aiResult.categorySlug) : undefined;
  if (aiResult && aiResult.confidence > 0.8 && aiCategory) {
    return { slug: aiCategory.slug, label: aiCategory.name, source: 'ai', confidence: aiResult.confidence, reason: aiResult.reason };
  }
  return fallback(activeCategories);
}
