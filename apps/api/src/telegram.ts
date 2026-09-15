import { createHash } from 'node:crypto';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import { describeReceiptOcrFailure, extractReceipt, resolveCategoryCorrectionWithAi, transcribeVoice, type ReceiptExtraction } from './ai.js';
import {
  categoryButtonRows,
  categoryCallbackData,
  categoryCorrectionDecision,
  isCategoryCorrectionRequest,
  parseCategoryCallbackData,
  type ActiveCategory,
} from './category-correction.js';
import { categorizeExpense, type CategorizationInput } from './category-categorizer.js';
import { config } from './config.js';
import { readEkasaReceiptQr } from './ekasa-qr.js';
import { formatAmount, parseFinancialMessage, type ParsedTransaction } from './finance-parser.js';
import { detectBudgetIntent, isBudgetStatusQuestion, parseStandaloneBudgetAmount } from './budget-intents.js';
import {
  budgetStatus,
  cancelBudget,
  claimBudgetAlert,
  claimBudgetCallback,
  consumeBudgetAmountPending,
  getBudgetCategories,
  hasBudgetAmountPending,
  maybeBudgetOffer,
  setBudget,
  setBudgetOfferPreference,
  startBudgetAmountPending,
  telegramBudgetContext,
  type BudgetCategory,
  type BudgetStatus,
} from './budget-service.js';
import { parseMultiExpenseMessage } from './multi-expense-parser.js';
import { EXPIRED_BUDGET_OFFER_MESSAGE, acknowledgeBudgetCallback } from './budget-callback.js';
import {
  batchCorrectionTarget,
  batchTransactionCallbackData,
  matchBatchTransactions,
  parseBatchTransactionCallbackData,
  type BatchTransactionCandidate,
} from './multi-expense-correction.js';
import { optimizeReceiptImage } from './receipt-image.js';
import { supabase } from './supabase.js';
import { downloadTelegramFile } from './telegram-files.js';
import { currentMonthVisualReport } from './reports.js';
import { isCancelLastTransactionRequest } from './transaction-controls.js';
import { enqueueTelegramMediaJob, wakeTelegramMediaJobWorker, type TelegramMediaJobPayload } from './async-jobs.js';
import {
  decideReceiptPurchaseProtection,
  updateReceiptPurchaseProtectionDuration,
  type ReceiptPurchaseProtectionDecision,
} from './receipt-purchase-protection.js';
import {
  formatWarrantyDuration,
  parseReceiptPurchaseProtectionCallbackData,
  parseWarrantyDurationMonths,
  receiptPurchaseProtectionCallbackData,
} from './receipt-purchase-protection-controls.js';

type RpcResult = { transaction_id: string; workspace_id: string; was_duplicate: boolean };
type BatchRpcResult = RpcResult & { item_index: number };
type LastTransaction = {
  transaction_id: string;
  transaction_type: 'income' | 'expense' | 'transfer';
  amount_minor: number;
  currency_code: string;
  category_name: string | null;
  note: string | null;
  occurred_at: string;
};

const WARRANTY_DURATION_CONTEXT_TTL_MS = 30 * 60 * 1_000;
const warrantyDurationPendingUntil = new Map<string, number>();

function markWarrantyDurationPending(telegramUserId: string): void {
  warrantyDurationPendingUntil.set(telegramUserId, Date.now() + WARRANTY_DURATION_CONTEXT_TTL_MS);
}

function hasPendingWarrantyDuration(telegramUserId: string): boolean {
  const pendingUntil = warrantyDurationPendingUntil.get(telegramUserId);
  if (!pendingUntil) return false;
  if (pendingUntil > Date.now()) return true;
  warrantyDurationPendingUntil.delete(telegramUserId);
  return false;
}

function clearWarrantyDurationPending(telegramUserId: string): void {
  warrantyDurationPendingUntil.delete(telegramUserId);
}
type CorrectedTransaction = {
  transaction_id: string;
  amount_minor: number;
  currency_code: string;
  category_name: string | null;
  note: string | null;
};
type CategoryCorrectionResult = {
  transaction_id: string;
  amount_minor: number;
  currency_code: string;
  category_name: string;
  previous_category_name: string | null;
  note: string | null;
  was_changed: boolean;
};
type CategoryCorrectionCategoryRpc = {
  category_id: string;
  name: string;
  slug: string;
  icon: string | null;
};
type ReceiptClaimMatch = {
  receipt_id: string;
  merchant_name: string | null;
  receipt_date: string | null;
  total_amount_minor: number | null;
  currency_code: string | null;
  storage_key: string;
  content_type: string;
  matched_item_name: string | null;
  match_score?: number;
};
const processedUpdateIds = new Set<number>();
const maxTrackedUpdates = 10_000;

function name(ctx: Context) { return [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || ctx.from?.username || 'Používateľ'; }

function telegramMediaJob(ctx: Context, kind: TelegramMediaJobPayload['kind'], fileId: string): TelegramMediaJobPayload | null {
  if (!ctx.from || !ctx.chat || !ctx.message) return null;
  return {
    version: 1,
    kind,
    updateId: ctx.update.update_id,
    messageId: ctx.message.message_id,
    messageDate: ctx.message.date,
    chatId: ctx.chat.id,
    telegramUserId: ctx.from.id,
    displayName: name(ctx),
    fileId,
  };
}

/** A report request must be handled before attempting to parse an amount. */
function isCurrentMonthReportRequest(text: string): boolean {
  return /\breport\b|prehľad|prehlad|sumár|sumar|štatistik|koľko som minul|stav mojich financií|súhrn|suhrn/iu.test(text);
}

function isAutomatedWeeklyReportRequest(text: string): boolean {
  return /týžden|tyzden|tento\s+týždeň|tento\s+tyzden/iu.test(text);
}

function isReceiptClaimRequest(text: string): boolean {
  return /reklam|blo[cč]ek|doklad|účten/iu.test(text);
}

function correctionText(text: string): string | null {
  if (!/^oprav\b/iu.test(text.trim())) return null;
  const value = text
    .trim()
    .replace(/^oprav(?:\s+mi)?\s*/iu, '')
    .replace(/^posledn\p{L}*(?:\s+z[aá]pis\p{L}*)?\s*/iu, '')
    .replace(/^na\s*/iu, '')
    .replace(/^[:\-]\s*/u, '')
    .trim();
  return value || null;
}

/** Extracts only the meaningful search phrase from natural Slovak claim requests. */
function receiptClaimQuery(text: string): string {
  const ignored = new Set([
    'reklamacia', 'reklamaciu', 'reklamacii', 'reklamacne', 'reklamovat',
    'potrebujem', 'prosim', 'najdi', 'najst', 'chcem', 'posli', 'ukaz',
    'blocek', 'uctenku', 'doklad', 'z', 'zo', 'pre', 'na', 'mi', 'ten', 'to',
  ]);
  const normalized = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];
  return words.filter((word) => !ignored.has(normalized(word))).join(' ').trim().slice(0, 160);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character] ?? character);
}

function claimCurrency(value: string | null): Parameters<typeof formatAmount>[1] {
  return value === 'CZK' || value === 'USD' || value === 'GBP' || value === 'HUF' || value === 'PLN' || value === 'EUR'
    ? value
    : 'EUR';
}

function claimCaption(receipt: ReceiptClaimMatch): string {
  const merchant = escapeHtml(receipt.merchant_name?.trim() || 'Neznámy obchod');
  const item = receipt.matched_item_name ? `\n<b>Položka:</b> ${escapeHtml(receipt.matched_item_name)}` : '';
  const date = receipt.receipt_date ?? 'dátum sa nepodarilo prečítať';
  const amount = receipt.total_amount_minor === null ? 'suma sa nepodarila prečítať' : formatAmount(receipt.total_amount_minor, claimCurrency(receipt.currency_code));
  return `🧾 <b>Bločok pre reklamáciu</b>\n<b>Obchod:</b> ${merchant}\n<b>Dátum:</b> ${date}${item}\n<b>Celková suma:</b> ${amount}`;
}

function transactionCurrency(value: string): Parameters<typeof formatAmount>[1] {
  return value === 'CZK' || value === 'USD' || value === 'GBP' || value === 'HUF' || value === 'PLN' || value === 'EUR' ? value : 'EUR';
}

function normalizeBudgetText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('sk-SK');
}

function budgetCategoryFromText(text: string, categories: BudgetCategory[]): BudgetCategory | null {
  const normalized = normalizeBudgetText(text);
  const matches = categories.filter((category) => {
    const name = normalizeBudgetText(category.name);
    return normalized.includes(name) || normalized.includes(category.slug.replace(/-/g, ' '));
  });
  return matches.length === 1 ? matches[0] : null;
}

async function resolveBudgetCategory(telegramUserId: string, text: string, categories: BudgetCategory[]): Promise<BudgetCategory | null> {
  const direct = budgetCategoryFromText(text, categories);
  if (direct) return direct;
  const categorized = await categorizeExpense({ telegramUserId, messageText: text });
  return categories.find((category) => category.slug === categorized.slug) ?? null;
}

function budgetStatusText(status: BudgetStatus): string {
  const limit = formatAmount(status.amountMinor, transactionCurrency(status.currencyCode));
  const spent = formatAmount(status.spentMinor, transactionCurrency(status.currencyCode));
  if (status.remainingMinor < 0) return `⚠️ ${status.categoryName}: limit ${limit} je prekročený o ${formatAmount(Math.abs(status.remainingMinor), transactionCurrency(status.currencyCode))}.`;
  return `${status.categoryName}: minuté ${spent} z ${limit}. Ostáva ${formatAmount(status.remainingMinor, transactionCurrency(status.currencyCode))}.`;
}

function budgetControls(categoryId: string): InlineKeyboard {
  return new InlineKeyboard().text('Zmeniť limit', `bgc:${categoryId}`).text('Zrušiť limit', `bgx:${categoryId}`);
}

type BudgetFollowUp = { lines: string[]; offer: BudgetCategory | null };

function budgetOfferKeyboard(category: BudgetCategory): InlineKeyboard {
  return new InlineKeyboard().text('Áno, nastaviť limit', `bgo:${category.id}`).row().text('Neskôr', `bgl:${category.id}`).text('Už neponúkať', `bgn:${category.id}`);
}

async function budgetFollowUp(ctx: Context, categorySlug: string): Promise<BudgetFollowUp> {
  if (!ctx.from) return { lines: [], offer: null };
  const context = await telegramBudgetContext(String(ctx.from.id));
  if (!context) return { lines: [], offer: null };
  const category = (await getBudgetCategories(context)).find((item) => item.slug === categorySlug);
  if (!category) return { lines: [], offer: null };
  const status = await budgetStatus(context, category.id);
  if (!status) {
    const offer = await maybeBudgetOffer(context, category.id);
    return { lines: [], offer: offer ? category : null };
  }
  const lines = [budgetStatusText(status)];
  if (await claimBudgetAlert(context, status, 100)) lines.push(`⚠️ Mesačný limit pre ${status.categoryName} bol prekročený o ${formatAmount(Math.max(0, -status.remainingMinor), transactionCurrency(status.currencyCode))}.`);
  else if (await claimBudgetAlert(context, status, 80)) lines.push(`⚠️ Limit pre ${status.categoryName} sa blíži k vyčerpaniu. Minuté ${formatAmount(status.spentMinor, transactionCurrency(status.currencyCode))} z ${formatAmount(status.amountMinor, transactionCurrency(status.currencyCode))}.`);
  return { lines, offer: null };
}

async function sendBudgetOffer(ctx: Context, category: BudgetCategory): Promise<void> {
  await ctx.reply(`Tento mesiac bolo v kategórii ${category.name} evidovaných viac výdavkov.\nChcete si nastaviť mesačný limit pre túto kategóriu?`, { reply_markup: budgetOfferKeyboard(category) });
}

async function handleBudgetTextIntent(ctx: Context, text: string): Promise<boolean> {
  if (!ctx.from) return false;
  const context = await telegramBudgetContext(String(ctx.from.id));
  if (!context) return false;

  const pendingAmount = parseStandaloneBudgetAmount(text);
  if (pendingAmount) {
    const saved = await consumeBudgetAmountPending(context, pendingAmount.amountMinor, pendingAmount.currencyCode);
    if (saved) {
      await ctx.reply(`✅ Hotovo. Mesačný limit pre ${saved.categoryName} je ${formatAmount(saved.amountMinor, transactionCurrency(saved.currencyCode))}.\n${budgetStatusText(saved)}`, { reply_markup: budgetControls(saved.categoryId) });
      return true;
    }
  }
  if (await hasBudgetAmountPending(context)) {
    await ctx.reply('Bot čaká na sumu mesačného limitu. Napíšte ju napríklad ako 300 €.');
    return true;
  }

  const intent = detectBudgetIntent(text) ?? (isBudgetStatusQuestion(text) ? 'status' : null);
  if (!intent) return false;
  const categories = await getBudgetCategories(context);
  const category = await resolveBudgetCategory(String(ctx.from.id), text, categories);
  if (!category) {
    await ctx.reply('Kategóriu limitu sa nepodarilo jednoznačne rozpoznať. Napíšte napríklad: „Nastav limit na Potraviny 300 €“.');
    return true;
  }
  if (intent === 'cancel') {
    const cancelled = await cancelBudget(context, category.id);
    await ctx.reply(cancelled ? `✅ Limit pre ${category.name} je zrušený.` : `Pre ${category.name} zatiaľ nie je nastavený mesačný limit.`);
    return true;
  }
  if (intent === 'status') {
    const status = await budgetStatus(context, category.id);
    if (status) await ctx.reply(budgetStatusText(status), { reply_markup: budgetControls(category.id) });
    else await ctx.reply(`Pre ${category.name} zatiaľ nie je nastavený mesačný limit.`, { reply_markup: new InlineKeyboard().text('Nastaviť limit', `bgs:${category.id}`) });
    return true;
  }
  const parsed = parseFinancialMessage(text);
  if (!parsed) {
    await startBudgetAmountPending(context, category.id);
    await ctx.reply(`Aký mesačný limit chcete nastaviť pre ${category.name}?\nNapíšte sumu, napr. 300 €.`);
    return true;
  }
  const saved = await setBudget(context, category, parsed.amountMinor, parsed.currencyCode);
  await ctx.reply(`✅ Hotovo. Mesačný limit pre ${category.name} je ${formatAmount(saved.amountMinor, transactionCurrency(saved.currencyCode))}.\n${budgetStatusText(saved)}`, { reply_markup: budgetControls(category.id) });
  return true;
}

function lastTransactionLabel(transaction: LastTransaction): string {
  const category = transaction.category_name ? ` · ${transaction.category_name}` : '';
  const note = transaction.note?.trim() ? ` (${transaction.note.trim()})` : '';
  return `${transaction.transaction_type === 'income' ? 'Príjem' : 'Výdavok'}: ${formatAmount(transaction.amount_minor, transactionCurrency(transaction.currency_code))}${category}${note}`;
}

async function getLastTransaction(telegramUserId: string): Promise<LastTransaction | null> {
  const { data, error } = await supabase.rpc('get_last_telegram_transaction', { p_telegram_user_id: telegramUserId });
  if (error) throw new Error(error.message);
  return (data as LastTransaction[] | null)?.[0] ?? null;
}

async function voidTransaction(telegramUserId: string, transactionId: string): Promise<LastTransaction | null> {
  const { data, error } = await supabase.rpc('void_telegram_transaction', {
    p_telegram_user_id: telegramUserId,
    p_transaction_id: transactionId,
  });
  if (error) throw new Error(error.message);
  return (data as LastTransaction[] | null)?.[0] ?? null;
}

async function requestLastTransactionVoid(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  const last = await getLastTransaction(String(ctx.from.id));
  if (!last) {
    await ctx.reply('Zatiaľ nie je k dispozícii žiadny potvrdený zápis na zrušenie.');
    return;
  }
  const keyboard = new InlineKeyboard()
    .text('Áno, zrušiť', `txn:void:${last.transaction_id}`)
    .text('Ponechať', 'txn:keep');
  await ctx.reply(`⚠️ Naozaj chcete zrušiť posledný zápis?\n${lastTransactionLabel(last)}`, { reply_markup: keyboard });
}

async function correctLastTransaction(telegramUserId: string, text: string, categorizationInput: Omit<CategorizationInput, 'telegramUserId'> = {}): Promise<CorrectedTransaction | null> {
  const parsed = parseFinancialMessage(text);
  if (!parsed) return null;
  const category = parsed.transactionType === 'expense'
    ? await categorizeExpense({ telegramUserId, messageText: text, ...categorizationInput })
    : { slug: parsed.categorySlug, label: parsed.categoryLabel };
  const { data, error } = await supabase.rpc('correct_last_telegram_transaction', {
    p_telegram_user_id: telegramUserId,
    p_amount_minor: parsed.amountMinor,
    p_currency_code: parsed.currencyCode,
    p_transaction_type: parsed.transactionType,
    p_category_slug: category.slug,
    p_note: parsed.note,
  });
  if (error) throw new Error(error.message);
  return (data as CorrectedTransaction[] | null)?.[0] ?? null;
}

async function getCategoryCorrectionCategories(telegramUserId: string, transactionId: string): Promise<ActiveCategory[]> {
  const { data, error } = await supabase.rpc('get_telegram_category_correction_categories', {
    p_telegram_user_id: telegramUserId,
    p_transaction_id: transactionId,
  });
  if (error) throw new Error(error.message);
  return ((data as CategoryCorrectionCategoryRpc[] | null) ?? []).flatMap((category) => {
    if (!category.category_id || !category.name || !category.slug) {
      console.warn('Ignoring invalid category correction row from Supabase RPC');
      return [];
    }
    return [{
      id: category.category_id,
      name: category.name,
      slug: category.slug,
      icon: category.icon,
    }];
  });
}

async function getLastTelegramBatchTransactions(telegramUserId: string): Promise<BatchTransactionCandidate[]> {
  const { data, error } = await supabase.rpc('get_telegram_last_batch_transactions', {
    p_telegram_user_id: telegramUserId,
  });
  if (error) throw new Error(error.message);
  return (data as BatchTransactionCandidate[] | null) ?? [];
}

async function correctLastTransactionCategory(
  telegramUserId: string,
  transactionId: string,
  categoryId: string,
): Promise<CategoryCorrectionResult | null> {
  const { data, error } = await supabase.rpc('correct_last_telegram_transaction_category', {
    p_telegram_user_id: telegramUserId,
    p_expected_transaction_id: transactionId,
    p_category_id: categoryId,
  });
  if (error) throw new Error(error.message);
  return (data as CategoryCorrectionResult[] | null)?.[0] ?? null;
}

async function showCategoryPicker(ctx: Context, last: LastTransaction, categories: ActiveCategory[]): Promise<void> {
  if (!ctx.from) return;
  const keyboard = new InlineKeyboard();
  for (const row of categoryButtonRows(categories)) {
    for (const category of row) {
      keyboard.text(category.name.slice(0, 48), categoryCallbackData(last.transaction_id, category.id));
    }
    keyboard.row();
  }
  await ctx.reply('Do ktorej kategórie zaradiť poslednú transakciu?\nVyberte kategóriu 👇', { reply_markup: keyboard });
}

function batchTransactionLabel(transaction: BatchTransactionCandidate): string {
  const description = transaction.note?.trim() || transaction.merchant_name?.trim() || 'Výdavok';
  return `${description} – ${formatAmount(transaction.amount_minor, transactionCurrency(transaction.currency_code))}`;
}

async function handleBatchCategoryCorrection(ctx: Context, text: string): Promise<boolean> {
  if (!ctx.from) return false;
  const target = batchCorrectionTarget(text);
  if (!target) return false;

  const telegramUserId = String(ctx.from.id);
  const batch = await getLastTelegramBatchTransactions(telegramUserId);
  if (batch.length === 0) return false;
  const matches = matchBatchTransactions(target, batch);
  if (matches.length === 0) {
    await ctx.reply('V poslednom hromadnom zápise sa takáto položka nenašla.');
    return true;
  }
  if (matches.length === 1) {
    const transaction = matches[0];
    const categories = await getCategoryCorrectionCategories(telegramUserId, transaction.transaction_id);
    if (categories.length === 0) {
      await ctx.reply('Pre tento zápis teraz nie je dostupná žiadna aktívna kategória.');
      return true;
    }
    await showCategoryPicker(ctx, {
      transaction_id: transaction.transaction_id,
      transaction_type: 'expense',
      amount_minor: transaction.amount_minor,
      currency_code: transaction.currency_code,
      category_name: null,
      note: transaction.note,
      occurred_at: '',
    }, categories);
    return true;
  }

  const keyboard = new InlineKeyboard();
  for (const transaction of matches) {
    keyboard.text(batchTransactionLabel(transaction).slice(0, 60), batchTransactionCallbackData(transaction.transaction_id)).row();
  }
  await ctx.reply('Našlo sa viac položiek. Vyberte položku, ktorej chcete zmeniť kategóriu:', { reply_markup: keyboard });
  return true;
}

function categoryCorrectionConfirmation(result: CategoryCorrectionResult): string {
  const label = `${result.note?.trim() || 'Posledný zápis'} ${formatAmount(result.amount_minor, transactionCurrency(result.currency_code))}`;
  if (!result.was_changed) return `ℹ️ ${label} už je zaradený v kategórii ${result.category_name}.`;
  return `✅ Opravené.\n${label} → ${result.category_name}`;
}

async function handleCategoryCorrection(ctx: Context, text: string): Promise<void> {
  if (!ctx.from) return;
  const telegramUserId = String(ctx.from.id);
  const last = await getLastTransaction(telegramUserId);
  if (!last) {
    await ctx.reply('Zatiaľ nie je k dispozícii žiadny potvrdený zápis na opravu kategórie.');
    return;
  }
  const categories = await getCategoryCorrectionCategories(telegramUserId, last.transaction_id);
  if (categories.length === 0) {
    await ctx.reply('Pre tento zápis teraz nie je dostupná žiadna aktívna kategória.');
    return;
  }

  const decision = categoryCorrectionDecision(text, true, categories);
  let category = decision.kind === 'apply_category' ? decision.category : null;
  const hasExplicitDestination = /\b(do|na|pod)\b/iu.test(text) && !/\bnie\s+(je|sú)\b/iu.test(text);
  if (!category && decision.kind === 'show_picker' && decision.reason === 'unresolved' && hasExplicitDestination) {
    const aiCategory = await resolveCategoryCorrectionWithAi(text, categories);
    if (aiCategory && aiCategory.confidence >= 0.9) {
      category = categories.find((candidate) => candidate.id === aiCategory.categoryId) ?? null;
    }
  }

  if (!category) {
    await showCategoryPicker(ctx, last, categories);
    return;
  }

  const corrected = await correctLastTransactionCategory(telegramUserId, last.transaction_id, category.id);
  if (!corrected) {
    await ctx.reply('Posledný zápis sa medzitým zmenil. Napíšte, prosím, opravu kategórie ešte raz.');
    return;
  }
  await ctx.reply(categoryCorrectionConfirmation(corrected));
}

async function sendReceiptForClaim(ctx: Context, receipt: ReceiptClaimMatch): Promise<void> {
  const { data, error } = await supabase.storage.from('ofa-receipts').createSignedUrl(receipt.storage_key, 10 * 60);
  if (error || !data?.signedUrl) throw new Error(error?.message ?? 'Signed URL for receipt was not created');
  await ctx.replyWithPhoto(data.signedUrl, { caption: claimCaption(receipt), parse_mode: 'HTML' });
}

async function findReceiptClaims(telegramUserId: string, query: string): Promise<ReceiptClaimMatch[]> {
  const { data, error } = await supabase.rpc('search_telegram_receipts_for_claim', {
    p_telegram_user_id: telegramUserId,
    p_query: query,
    p_limit: 5,
  });
  if (error) throw new Error(error.message);
  return onlyArchivedReceiptClaims((data as ReceiptClaimMatch[] | null) ?? []);
}

async function getReceiptClaim(telegramUserId: string, receiptId: string): Promise<ReceiptClaimMatch | null> {
  const { data, error } = await supabase.rpc('get_telegram_receipt_for_claim', {
    p_telegram_user_id: telegramUserId,
    p_receipt_id: receiptId,
  });
  if (error) throw new Error(error.message);
  return (await onlyArchivedReceiptClaims((data as ReceiptClaimMatch[] | null) ?? []))[0] ?? null;
}

async function onlyArchivedReceiptClaims(receipts: ReceiptClaimMatch[]): Promise<ReceiptClaimMatch[]> {
  if (!receipts.length) return [];
  const { data, error } = await supabase
    .from('ofa_receipts')
    .select('id')
    .in('id', receipts.map((receipt) => receipt.receipt_id))
    .eq('archive_status', 'archived')
    .is('deleted_at', null);
  if (error) throw new Error(error.message);
  const archivedIds = new Set((data ?? []).map((receipt) => receipt.id));
  return receipts.filter((receipt) => archivedIds.has(receipt.receipt_id));
}

async function handleReceiptClaimSearch(ctx: Context, query: string): Promise<void> {
  if (!ctx.from) return;
  const matches = await findReceiptClaims(String(ctx.from.id), query);
  if (!matches.length) {
    await ctx.reply(`Bloček k „${query}“ sa nenašiel. Skúste názov obchodu alebo položky z dokladu.`);
    return;
  }
  if (matches.length === 1) {
    await ctx.reply('✅ Bloček bol nájdený. Pôvodná fotografia bločku je priložená.');
    await sendReceiptForClaim(ctx, matches[0]);
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const receipt of matches) {
    const merchant = receipt.merchant_name?.trim() || 'Neznámy obchod';
    const date = receipt.receipt_date ?? 'bez dátumu';
    const amount = receipt.total_amount_minor === null ? '' : ` · ${formatAmount(receipt.total_amount_minor, claimCurrency(receipt.currency_code))}`;
    keyboard.text(`${merchant} · ${date}${amount}`.slice(0, 60), `claim:${receipt.receipt_id}`).row();
  }
  await ctx.reply(`Našlo sa ${matches.length} bločkov. Vyberte správny doklad pre reklamáciu:`, { reply_markup: keyboard });
}

function claimUpdate(updateId: number): boolean {
  if (processedUpdateIds.has(updateId)) return false;
  processedUpdateIds.add(updateId);

  // Keep duplicate protection bounded for a long-running Render instance.
  if (processedUpdateIds.size > maxTrackedUpdates) {
    const oldestUpdateId = processedUpdateIds.values().next().value;
    if (oldestUpdateId !== undefined) processedUpdateIds.delete(oldestUpdateId);
  }

  return true;
}

async function saveTransaction(ctx: Context, text: string, categorizationInput: Omit<CategorizationInput, 'telegramUserId'> = {}): Promise<{ result: RpcResult; slug: string; label: string; amount: number; currency: 'EUR' | 'CZK' | 'USD' | 'GBP' | 'HUF' | 'PLN' } | null> {
  if (!ctx.from || !ctx.message || !ctx.chat) return null;
  const parsed = parseFinancialMessage(text);
  if (!parsed) return null;
  const category = parsed.transactionType === 'expense'
    ? await categorizeExpense({ telegramUserId: String(ctx.from.id), messageText: text, ...categorizationInput })
    : { slug: parsed.categorySlug, label: parsed.categoryLabel };
  const { data, error } = await supabase.rpc('record_telegram_transaction', { p_telegram_user_id: String(ctx.from.id), p_display_name: name(ctx), p_chat_id: String(ctx.chat.id), p_message_id: String(ctx.message.message_id), p_update_id: String(ctx.update.update_id), p_message_text: text, p_amount_minor: parsed.amountMinor, p_currency_code: parsed.currencyCode, p_transaction_type: parsed.transactionType, p_category_slug: category.slug, p_note: parsed.note, p_occurred_at: new Date(ctx.message.date * 1000).toISOString(), p_time_zone: 'Europe/Bratislava' });
  if (error) throw new Error(error.message);
  const result = (data as RpcResult[] | null)?.[0];
  return result ? { result, slug: category.slug, label: category.label, amount: parsed.amountMinor, currency: parsed.currencyCode } : null;
}

async function saveTransactionBatch(
  ctx: Context,
  items: ParsedTransaction[],
): Promise<{ result: BatchRpcResult; note: string; slug: string; label: string; amount: number; currency: 'EUR' | 'CZK' | 'USD' | 'GBP' | 'HUF' | 'PLN' }[] | null> {
  if (!ctx.from || !ctx.message || !ctx.chat) return null;

  const categorizedItems = await Promise.all(items.map(async (parsed) => {
    const category = parsed.transactionType === 'expense'
      ? await categorizeExpense({ telegramUserId: String(ctx.from!.id), messageText: parsed.note })
      : { slug: parsed.categorySlug, label: parsed.categoryLabel, source: 'rule' as const, confidence: 1, reason: 'Income parser' };
    return { parsed, category };
  }));

  const { data, error } = await supabase.rpc('record_telegram_transaction_batch', {
    p_telegram_user_id: String(ctx.from.id),
    p_display_name: name(ctx),
    p_chat_id: String(ctx.chat.id),
    p_message_id: String(ctx.message.message_id),
    p_update_id: String(ctx.update.update_id),
    p_message_text: ctx.message.text ?? '',
    p_items: categorizedItems.map(({ parsed, category }) => ({
      amount_minor: parsed.amountMinor,
      currency_code: parsed.currencyCode,
      transaction_type: parsed.transactionType,
      category_slug: category.slug,
      category_source: category.source === 'fallback' ? 'system' : category.source,
      category_confidence: category.confidence,
      category_reason: category.reason,
      note: parsed.note,
    })),
    p_occurred_at: new Date(ctx.message.date * 1000).toISOString(),
    p_time_zone: 'Europe/Bratislava',
  });
  if (error) throw new Error(error.message);
  const results = (data as BatchRpcResult[] | null) ?? [];
  if (results.length !== categorizedItems.length) throw new Error('Batch transaction RPC returned an incomplete result');
  return categorizedItems.map(({ parsed, category }, index) => ({
    result: results.find((row) => row.item_index === index) ?? (() => { throw new Error('Batch transaction result index is missing'); })(),
    note: parsed.note,
    slug: category.slug,
    label: category.label,
    amount: parsed.amountMinor,
    currency: parsed.currencyCode,
  }));
}

function batchTransactionSummary(items: NonNullable<Awaited<ReturnType<typeof saveTransactionBatch>>>): string {
  return `✅ Zapísané:\n${items.map((item) => `${item.note} — ${formatAmount(item.amount, item.currency)} — ${item.label}`).join('\n')}`;
}

function receiptPurchaseProtectionDecisionText(decision: ReceiptPurchaseProtectionDecision, keptReceipt: boolean): string {
  if (decision.archive_status === 'archived') {
    if (decision.protection_status === 'active' && decision.protection_ends_on) {
      return '✅ Doklad je uložený a záruku sledujeme 2 roky. Ak máte dlhšiu záruku, napíšte jej dĺžku.';
    }
    return '✅ Doklad je uložený. Sledovanie sa nespustilo, pretože súvisiaci finančný záznam už bol zrušený.';
  }
  if (decision.archive_status === 'pending_deletion') {
    return keptReceipt
      ? 'Doklad je už označený na technické odstránenie a jeho mazanie už prebieha.'
      : 'Finančný záznam zostáva uložený. Pôvodná fotografia dokladu bude po technickej retenčnej lehote bezpečne odstránená.';
  }
  if (decision.archive_status === 'cleanup_claimed') {
    return 'Doklad už čaká na technické odstránenie a jeho uloženie sa nedá spoľahlivo obnoviť.';
  }
  if (decision.archive_status === 'storage_deleted') {
    return 'Pôvodná fotografia tohto dokladu už bola po retenčnej lehote odstránená. Finančný záznam ostal zachovaný.';
  }
  return 'Rozhodnutie o uložení dokladu sa nepodarilo dokončiť.';
}

async function handleReceipt(ctx: Context): Promise<void> {
  const photo = ctx.message?.photo?.at(-1);
  if (!photo || !ctx.from || !ctx.message) return;
  let stage = 'príprava spracovania';

  try {
    await ctx.reply('🔎 Bloček sa spracúva…');
    stage = 'stiahnutie fotky z Telegramu';
    const file = await downloadTelegramFile(photo.file_id);
    stage = 'kompresia fotky';
    const receiptImage = await optimizeReceiptImage(file.bytes);

    // Persist the optimized JPEG before QR/OCR work. The temporary object remains
    // private and is moved to the permanent workspace key after the transaction
    // has resolved the workspace identity.
    stage = 'uloženie fotky do Supabase Storage';
    const hash = createHash('sha256').update(receiptImage.bytes).digest('hex');
    const temporaryKey = `incoming/telegram/${ctx.update.update_id}-${hash.slice(0, 16)}.jpg`;
    const upload = await supabase.storage.from('ofa-receipts').upload(temporaryKey, receiptImage.bytes, { contentType: 'image/jpeg', upsert: false });
    if (upload.error) throw new Error(upload.error.message);

    stage = 'čítanie eKasa QR kódu';
    const ekasa = await readEkasaReceiptQr(receiptImage.bytes);
    let extraction: ReceiptExtraction;
    if (ekasa) {
      extraction = {
        merchantName: ekasa.merchantName,
        receiptDate: ekasa.receiptDate,
        amountMinor: ekasa.amountMinor,
        currencyCode: 'EUR',
        items: [],
        ocrText: JSON.stringify({ source: 'ekasa_qr', merchantIco: ekasa.merchantIco, qrPayload: ekasa.rawPayload }),
      };
    } else {
      stage = 'OpenAI Vision OCR';
      extraction = await extractReceipt(receiptImage.bytes, 'image/jpeg');
    }

    if (!extraction.amountMinor) {
      await ctx.reply('Bloček sa uložil, no sumu sa nepodarilo spoľahlivo nájsť. Skúste, prosím, ostrejšiu fotku.');
      return;
    }
    stage = 'uloženie finančnej transakcie';
    const synthetic = `${extraction.merchantName ?? 'Bloček'} ${formatAmount(extraction.amountMinor, 'EUR')}`;
    if (ekasa) console.log('eKasa amount before transaction save', { amountMinor: ekasa.amountMinor, synthetic });
    const saved = await saveTransaction(ctx, synthetic, { merchantName: extraction.merchantName, receiptText: extraction.ocrText });
    if (!saved || saved.result.was_duplicate) return;
    if (ekasa) console.log('eKasa amount after transaction save', { parsedAmountMinor: saved.amount, transactionId: saved.result.transaction_id });
    stage = 'načítanie uloženej transakcie';
    const { data: transaction, error: transactionError } = await supabase.from('financial_transactions').select('created_by_user_id').eq('id', saved.result.transaction_id).single();
    if (transactionError || !transaction) throw new Error(transactionError?.message ?? 'Transaction lookup failed');
    stage = 'presun fotky do trvalého úložiska';
    const key = `${saved.result.workspace_id}/${ctx.message.message_id}-${hash.slice(0, 16)}.jpg`;
    const move = await supabase.storage.from('ofa-receipts').move(temporaryKey, key);
    if (move.error) throw new Error(move.error.message);
    stage = 'uloženie metadát bločku';
    const sha256 = `\\x${hash}`;
    const { data: storedFile, error: storedFileError } = await supabase.from('stored_files').insert({ workspace_id: saved.result.workspace_id, storage_provider: 'supabase_storage', storage_key: key, content_type: 'image/jpeg', byte_size: receiptImage.bytes.length, sha256, uploaded_by_user_id: transaction.created_by_user_id }).select('id').single();
    if (storedFileError || !storedFile) throw new Error(storedFileError?.message ?? 'Receipt file metadata failed');
    const retentionUntil = new Date(Date.now() + config.RECEIPT_STORAGE_RETENTION_HOURS * 60 * 60 * 1_000).toISOString();
    const { data: receipt, error: receiptError } = await supabase.from('ofa_receipts').insert({ workspace_id: saved.result.workspace_id, file_id: storedFile.id, uploaded_by_user_id: transaction.created_by_user_id, status: 'completed', archive_status: 'decision_pending', retention_until: retentionUntil, merchant_name: extraction.merchantName, receipt_date: extraction.receiptDate, total_amount_minor: extraction.amountMinor, currency_code: 'EUR', ocr_text: extraction.ocrText, ocr_language: 'sk' }).select('id').single();
    if (receiptError || !receipt) throw new Error(receiptError?.message ?? 'Receipt metadata failed');
    if (extraction.items.length) {
      stage = 'uloženie položiek bločku';
      const { error: receiptItemsError } = await supabase.from('receipt_line_items').insert(extraction.items.map((item, index) => ({
        workspace_id: saved.result.workspace_id,
        receipt_id: receipt.id,
        line_number: index + 1,
        item_name: item.name,
        quantity: item.quantity,
        unit_amount_minor: item.unitAmountMinor,
        total_amount_minor: item.totalAmountMinor,
        currency_code: extraction.currencyCode,
      })));
      if (receiptItemsError) throw new Error(receiptItemsError.message);
    }
    stage = 'uloženie OCR výsledku';
    const { error: ocrRunError } = await supabase.from('receipt_ocr_runs').insert({ receipt_id: receipt.id, provider: ekasa ? 'ekasa' : 'openai', provider_model: ekasa ? 'mdu-api-v1' : 'gpt-4o-mini', status: 'completed', extracted_data: extraction, confidence: ekasa ? 1 : 0.8, completed_at: new Date().toISOString() });
    if (ocrRunError) throw new Error(ocrRunError.message);
    const { error: receiptLinkError } = await supabase.from('receipt_transaction_links').insert({ receipt_id: receipt.id, transaction_id: saved.result.transaction_id, link_source: 'ocr', confidence: ekasa ? 1 : 0.8 });
    if (receiptLinkError) throw new Error(receiptLinkError.message);
    await ctx.reply(`${ekasa ? '✅ Zapísané z eKasa QR' : '✅ Zapísané z bločku'}: ${extraction.merchantName ?? 'Výdavok'} – ${formatAmount(extraction.amountMinor, 'EUR')}`);
    const keyboard = new InlineKeyboard()
      .text('✅ ÁNO', receiptPurchaseProtectionCallbackData(receipt.id, true))
      .text('❌ NIE', receiptPurchaseProtectionCallbackData(receipt.id, false));
    await ctx.reply('Obsahuje tento bloček výrobok vhodný na sledovanie reklamácie / záruky?', { reply_markup: keyboard });
  } catch (error) {
    // Pass the Error object itself to preserve its full stack trace in Render.
    console.error('Receipt processing failed', {
      updateId: ctx.update.update_id,
      telegramUserId: ctx.from.id,
      stage,
    }, error);

    const message = stage === 'OpenAI Vision OCR'
      ? describeReceiptOcrFailure(error).userMessage
      : `Spracovanie bločku zlyhalo pri fáze: ${stage}. Skúste to, prosím, znova.`;
    try {
      await ctx.reply(`❌ ${message}`);
    } catch (replyError) {
      console.error('Unable to send receipt failure message to Telegram', replyError);
    }
    throw error;
  }
}

async function handleVoice(ctx: Context, fileId: string): Promise<void> {
  await ctx.reply('🎙️ Hlasová správa sa prepisuje…');
  const audio = await downloadTelegramFile(fileId);
  const text = await transcribeVoice(audio.bytes, audio.path);
  if (isCancelLastTransactionRequest(text)) {
    await requestLastTransactionVoid(ctx);
    return;
  }
  const saved = await saveTransaction(ctx, text);
  await ctx.reply(saved ? `✅ Zapísané: ${saved.label} – ${formatAmount(saved.amount, saved.currency)}` : `Správu sa nepodarilo rozpoznať: „${text}“`);
}

/** Invoked by the durable worker, not by Telegram's HTTP webhook. */
export async function processQueuedTelegramMedia(bot: Bot, payload: TelegramMediaJobPayload): Promise<void> {
  const message = payload.kind === 'receipt'
    ? { message_id: payload.messageId, date: payload.messageDate, photo: [{ file_id: payload.fileId }] }
    : { message_id: payload.messageId, date: payload.messageDate, voice: { file_id: payload.fileId } };
  const context = {
    from: { id: payload.telegramUserId, first_name: payload.displayName },
    chat: { id: payload.chatId, type: 'private' },
    message,
    update: { update_id: payload.updateId },
    reply: (text: string, options?: object) => bot.api.sendMessage(payload.chatId, text, options as never),
  } as unknown as Context;
  if (payload.kind === 'receipt') await handleReceipt(context);
  else await handleVoice(context, payload.fileId);
}

export function createTelegramBot(): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  bot.command('start', async (ctx) => {
    await ctx.reply('Ahoj! Pošlite „Káva 3 €“, hlasovú správu alebo fotku bločku. E-mail zatiaľ nie je potrebný.');
  });
  bot.command('link', async (ctx) => {
    if (!ctx.from) return;
    try {
      const code = ctx.match.trim();
      if (!code) {
        await ctx.reply('Vygenerujte párovací kód vo webovom prehľade a pošlite: /link TVOJ_KÓD');
        return;
      }
      const { error } = await supabase.rpc('consume_telegram_link_code', {
        p_telegram_user_id: String(ctx.from.id),
        p_display_name: name(ctx),
        p_code: code,
      });
      if (error) throw new Error(error.message);
      await ctx.reply('✅ Telegram účet je prepojený s webovým prehľadom.');
    } catch (error) {
      console.error('Telegram account linking failed', {
        telegramUserId: ctx.from.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await ctx.reply('Párovací kód je neplatný alebo už vypršal. Vygenerujte nový kód vo webovom prehľade.');
    }
  });
  bot.callbackQuery(/^claim:([0-9a-f-]{36})$/i, async (ctx) => {
    if (!claimUpdate(ctx.update.update_id)) return;
    try {
      await ctx.answerCallbackQuery();
      if (ctx.chat?.type !== 'private' || !ctx.from) return;
      const receipt = await getReceiptClaim(String(ctx.from.id), ctx.match[1]);
      if (!receipt) {
        await ctx.reply('Tento bloček už nie je dostupný alebo k nemu nemáte prístup. Skúste vyhľadávanie znova.');
        return;
      }
      await sendReceiptForClaim(ctx, receipt);
    } catch (error) {
      console.error('Telegram receipt claim selection failed', {
        updateId: ctx.update.update_id,
        telegramUserId: ctx.from?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      try { await ctx.reply('❌ Bloček sa nepodarilo odoslať. Skúste výber zopakovať o chvíľu.'); } catch { /* update is already acknowledged */ }
    }
  });
  bot.callbackQuery(/^rpp:[0-9a-f-]{36}:[yn]$/i, async (ctx) => {
    if (!claimUpdate(ctx.update.update_id)) {
      await ctx.answerCallbackQuery({ text: 'Toto kliknutie už bolo spracované.' });
      return;
    }
    try {
      await ctx.answerCallbackQuery();
      if (ctx.chat?.type !== 'private' || !ctx.from) return;
      const callback = parseReceiptPurchaseProtectionCallbackData(ctx.callbackQuery.data);
      if (!callback) return;
      const decision = await decideReceiptPurchaseProtection(String(ctx.from.id), callback.receiptId, callback.keepReceipt);
      if (!decision) {
        await ctx.reply('Tento doklad už nie je dostupný alebo k nemu nie je prístup.');
        return;
      }
      if (callback.keepReceipt && decision.archive_status === 'archived' && decision.protection_status === 'active') {
        markWarrantyDurationPending(String(ctx.from.id));
      } else {
        clearWarrantyDurationPending(String(ctx.from.id));
      }
      try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* original message may no longer be editable */ }
      await ctx.reply(receiptPurchaseProtectionDecisionText(decision, callback.keepReceipt));
    } catch (error) {
      console.error('Telegram receipt purchase protection decision failed', {
        updateId: ctx.update.update_id,
        telegramUserId: ctx.from?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      try { await ctx.reply('❌ Nastavenie uloženia dokladu sa nepodarilo zmeniť. Skúste to, prosím, o chvíľu znova.'); } catch { /* update is already acknowledged */ }
    }
  });
  bot.callbackQuery(/^txn:void:([0-9a-f-]{36})$/i, async (ctx) => {
    if (!claimUpdate(ctx.update.update_id)) {
      await ctx.answerCallbackQuery({ text: 'Toto kliknutie už bolo spracované.' });
      return;
    }
    try {
      await ctx.answerCallbackQuery();
      if (!ctx.from) return;
      const voided = await voidTransaction(String(ctx.from.id), ctx.match[1]);
      if (!voided) {
        await ctx.reply('Tento zápis už nie je možné zrušiť. Možno bol už opravený alebo zrušený.');
        return;
      }
      try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* original message may no longer be editable */ }
      const label = voided.note?.trim()
        ? `${voided.note.trim()} ${formatAmount(voided.amount_minor, transactionCurrency(voided.currency_code))}`
        : formatAmount(voided.amount_minor, transactionCurrency(voided.currency_code));
      await ctx.reply(`✅ Posledný zápis bol zrušený: ${label}. Do reportov sa už nezapočítava.`);
    } catch (error) {
      console.error('Telegram transaction void failed', {
        updateId: ctx.update.update_id,
        telegramUserId: ctx.from?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      try { await ctx.reply('❌ Zápis sa nepodarilo zrušiť. Skúste to, prosím, o chvíľu znova.'); } catch { /* update is already acknowledged */ }
    }
  });
  bot.callbackQuery(/^txn:keep$/i, async (ctx) => {
    if (!claimUpdate(ctx.update.update_id)) return;
    await ctx.answerCallbackQuery({ text: 'Zápis ostáva bez zmeny.' });
    try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* the original message may no longer be editable */ }
  });
  bot.callbackQuery(/^bg([olncxs]):([0-9a-f-]{36})$/i, async (ctx) => {
    const callbackData = ctx.callbackQuery.data;
    const match = /^bg([olncxs]):([0-9a-f-]{36})$/i.exec(callbackData);
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!ctx.from || !ctx.chat || messageId === undefined || !match) {
      await acknowledgeBudgetCallback(
        () => ctx.answerCallbackQuery({ text: 'Táto ponuka už nie je aktívna.' }),
        (error) => console.warn('Telegram budget callback acknowledgement failed', { updateId: ctx.update.update_id, error: error instanceof Error ? error.message : String(error) }),
      );
      return;
    }

    try {
      const claimed = await claimBudgetCallback({
        telegramUserId: String(ctx.from.id),
        chatId: String(ctx.chat.id),
        messageId: String(messageId),
        callbackQueryId: ctx.callbackQuery.id,
        callbackData,
      });
      if (!claimed) {
        await acknowledgeBudgetCallback(
          () => ctx.answerCallbackQuery({ text: 'Toto kliknutie už bolo spracované.' }),
          (error) => console.warn('Telegram duplicate budget callback acknowledgement failed', { updateId: ctx.update.update_id, error: error instanceof Error ? error.message : String(error) }),
        );
        return;
      }

      await acknowledgeBudgetCallback(
        () => ctx.answerCallbackQuery(),
        (error) => console.warn('Telegram budget callback acknowledgement failed; processing continues', { updateId: ctx.update.update_id, error: error instanceof Error ? error.message : String(error) }),
      );
      // Disable the claimed buttons immediately. A late click is still valid,
      // but the same offer cannot trigger two independent operations.
      try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* original message may no longer be editable */ }

      const context = await telegramBudgetContext(String(ctx.from.id));
      if (!context) {
        await ctx.reply(EXPIRED_BUDGET_OFFER_MESSAGE);
        return;
      }
      const action = match[1];
      const categoryId = match[2];
      if (action === 'l') {
        await setBudgetOfferPreference(context, 'later');
        await ctx.reply('Rozumiem. Ponuka limitu sa zobrazí najskôr o 14 dní.');
      } else if (action === 'n') {
        await setBudgetOfferPreference(context, 'never');
        await ctx.reply('Proaktívne ponuky limitov sú vypnuté. Limity je stále možné nastaviť správou.');
      } else if (action === 'x') {
        const cancelled = await cancelBudget(context, categoryId);
        await ctx.reply(cancelled ? `✅ Limit pre ${cancelled.categoryName} je zrušený.` : 'Tento limit už nie je aktívny.');
      } else {
        const category = await startBudgetAmountPending(context, categoryId);
        if (!category) {
          await ctx.reply(EXPIRED_BUDGET_OFFER_MESSAGE);
          return;
        }
        await ctx.reply(`Aký mesačný limit chcete nastaviť pre ${category.name}?\nNapíšte sumu, napr. 300 €.`);
      }
    } catch (error) {
      console.error('Telegram budget callback failed', { updateId: ctx.update.update_id, telegramUserId: ctx.from?.id, error: error instanceof Error ? error.message : String(error) });
      try { await ctx.reply('❌ Nastavenie limitu sa nepodarilo zmeniť. Skúste to, prosím, o chvíľu znova.'); } catch { /* update is already acknowledged */ }
    }
  });
  bot.callbackQuery(/^txb:[0-9a-f-]{36}$/i, async (ctx) => {
    if (!claimUpdate(ctx.update.update_id)) {
      await ctx.answerCallbackQuery({ text: 'Toto kliknutie už bolo spracované.' });
      return;
    }
    try {
      await ctx.answerCallbackQuery();
      if (!ctx.from) return;
      const transactionId = parseBatchTransactionCallbackData(ctx.callbackQuery.data);
      if (!transactionId) return;
      const categories = await getCategoryCorrectionCategories(String(ctx.from.id), transactionId);
      if (categories.length === 0) {
        await ctx.reply('Tento výber položky už nie je platný. Napíšte, prosím, opravu kategórie znova.');
        return;
      }
      const batch = await getLastTelegramBatchTransactions(String(ctx.from.id));
      const transaction = batch.find((candidate) => candidate.transaction_id === transactionId);
      if (!transaction) {
        await ctx.reply('Tento výber položky už nie je platný. Napíšte, prosím, opravu kategórie znova.');
        return;
      }
      try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* original message may no longer be editable */ }
      await showCategoryPicker(ctx, {
        transaction_id: transaction.transaction_id,
        transaction_type: 'expense',
        amount_minor: transaction.amount_minor,
        currency_code: transaction.currency_code,
        category_name: null,
        note: transaction.note,
        occurred_at: '',
      }, categories);
    } catch (error) {
      console.error('Telegram batch transaction selection failed', {
        updateId: ctx.update.update_id,
        telegramUserId: ctx.from?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      try { await ctx.reply('❌ Výber položky sa nepodarilo pripraviť. Skúste to, prosím, o chvíľu znova.'); } catch { /* update is already acknowledged */ }
    }
  });
  bot.callbackQuery(/^txc:([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{22})$/, async (ctx) => {
    if (!claimUpdate(ctx.update.update_id)) {
      await ctx.answerCallbackQuery({ text: 'Toto kliknutie už bolo spracované.' });
      return;
    }
    try {
      await ctx.answerCallbackQuery();
      if (!ctx.from) return;
      const callback = parseCategoryCallbackData(ctx.callbackQuery.data);
      if (!callback) {
        await ctx.reply('Tento výber kategórie už nie je platný. Napíšte, prosím, „oprav kategóriu“ znova.');
        return;
      }
      console.info('Telegram category correction selected', {
        updateId: ctx.update.update_id,
        telegramUserId: ctx.from.id,
        transactionId: callback.transactionId,
        categoryId: callback.categoryId,
      });
      const corrected = await correctLastTransactionCategory(String(ctx.from.id), callback.transactionId, callback.categoryId);
      if (!corrected) {
        await ctx.reply('Posledný zápis sa medzitým zmenil. Napíšte, prosím, opravu kategórie ešte raz.');
        return;
      }
      try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* the original message may no longer be editable */ }
      await ctx.reply(categoryCorrectionConfirmation(corrected));
    } catch (error) {
      console.error('Telegram category correction selection failed', {
        updateId: ctx.update.update_id,
        telegramUserId: ctx.from?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      try { await ctx.reply('❌ Kategóriu sa nepodarilo zmeniť. Skúste to, prosím, o chvíľu znova.'); } catch { /* update is already acknowledged */ }
    }
  });
  bot.on('message', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!claimUpdate(ctx.update.update_id)) {
      console.info('Ignoring duplicate Telegram update', { updateId: ctx.update.update_id });
      return;
    }

    try {
      if (ctx.message.photo) {
        const job = telegramMediaJob(ctx, 'receipt', ctx.message.photo.at(-1)?.file_id ?? '');
        if (!job?.fileId) return;
        const inserted = await enqueueTelegramMediaJob(job);
        if (inserted) {
          await ctx.reply('🔎 Bloček bol prijatý a bezpečne sa spracúva…');
          void wakeTelegramMediaJobWorker();
        }
        return;
      }

      // Voice transcription is intentionally reachable only for media updates.
      // A text message has neither `voice` nor `audio` and bypasses this branch.
      const audioMessage = ctx.message.voice ?? ctx.message.audio;
      if (audioMessage) {
        const job = telegramMediaJob(ctx, 'voice', audioMessage.file_id);
        if (!job) return;
        const inserted = await enqueueTelegramMediaJob(job);
        if (inserted) {
          await ctx.reply('🎙️ Hlasová správa bola prijatá a prepisuje sa…');
          void wakeTelegramMediaJobWorker();
        }
        return;
      }

      const text = ctx.message.text;
      if (!text) {
        await ctx.reply('Podporované sú textové správy, hlasové správy a fotky bločkov.');
        return;
      }

      const telegramUserId = String(ctx.from.id);
      const warrantyDurationIsPending = hasPendingWarrantyDuration(telegramUserId);
      const warrantyDurationMonths = parseWarrantyDurationMonths(text);
      if (warrantyDurationMonths !== null) {
        // This runs before every general text intent and the financial parser.
        // The RPC is additionally scoped to the last selected protection, so a
        // process restart cannot turn an immediate duration reply into a charge.
        const update = await updateReceiptPurchaseProtectionDuration(telegramUserId, warrantyDurationMonths);
        if (update) {
          clearWarrantyDurationPending(telegramUserId);
          await ctx.reply(`✅ Záruka upravená na ${formatWarrantyDuration(update.warranty_duration_months)}.`);
          return;
        }
        if (warrantyDurationIsPending) {
          clearWarrantyDurationPending(telegramUserId);
          await ctx.reply('❌ Záruku sa nepodarilo upraviť.');
          return;
        }
      }

      if (isCategoryCorrectionRequest(text)) {
        try {
          const handledBatchCorrection = await handleBatchCategoryCorrection(ctx, text);
          if (!handledBatchCorrection) await handleCategoryCorrection(ctx, text);
        } catch (error) {
          console.error('Telegram category correction request failed', {
            updateId: ctx.update.update_id,
            telegramUserId: ctx.from.id,
            error: error instanceof Error ? error.message : String(error),
          });
          await ctx.reply('❌ Opravu kategórie sa nepodarilo pripraviť. Skúste to, prosím, o chvíľu znova.');
        }
        return;
      }

      if (await handleBudgetTextIntent(ctx, text)) return;

      if (/^oprav\b/iu.test(text.trim())) {
        const replacement = correctionText(text);
        if (!replacement) {
          const last = await getLastTransaction(String(ctx.from.id));
          await ctx.reply(last
            ? `Posledný zápis je: ${lastTransactionLabel(last)}\n\nNapíšte napríklad: <code>oprav posledný zápis na Obed 8,50 €</code>`
            : 'Zatiaľ nie je k dispozícii žiadny potvrdený zápis na opravu.', { parse_mode: 'HTML' });
          return;
        }
        const corrected = await correctLastTransaction(String(ctx.from.id), replacement);
        if (!corrected) {
          await ctx.reply('Opravu sa nepodarilo rozpoznať alebo nie je k dispozícii žiadny potvrdený zápis. Skúste napríklad: „oprav posledný zápis na Obed 8,50 €“.');
          return;
        }
        await ctx.reply(`✏️ Opravené: ${corrected.category_name ?? 'Výdavok'} – ${formatAmount(corrected.amount_minor, transactionCurrency(corrected.currency_code))}${corrected.note?.trim() ? ` (${corrected.note.trim()})` : ''}`);
        return;
      }

      if (isCancelLastTransactionRequest(text)) {
        await requestLastTransactionVoid(ctx);
        return;
      }

      if (isReceiptClaimRequest(text)) {
        const query = receiptClaimQuery(text);
        if (!query) {
          await ctx.reply('Napíšte, prosím, čo hľadáte. Napríklad: „reklamácia Lidl“ alebo „potrebujem bloček za kávu“.');
          return;
        }
        try {
          await handleReceiptClaimSearch(ctx, query);
        } catch (claimError) {
          console.error('Telegram receipt claim search failed', {
            updateId: ctx.update.update_id,
            telegramUserId: ctx.from.id,
            query,
            error: claimError instanceof Error ? claimError.message : String(claimError),
          });
          await ctx.reply('❌ Bločky sa teraz nepodarilo vyhľadať. Skúste to, prosím, o chvíľu znova.');
        }
        return;
      }

      if (isAutomatedWeeklyReportRequest(text)) {
        await ctx.reply('📅 Týždenný prehľad prichádza automaticky každý pondelok o 8:00 za uplynulý týždeň.');
        return;
      }

      if (isCurrentMonthReportRequest(text)) {
        const report = await currentMonthVisualReport(String(ctx.from.id));
        if (report.chartUrl) {
          await ctx.replyWithPhoto(report.chartUrl, { caption: report.caption, parse_mode: 'HTML' });
        } else {
          await ctx.reply(report.caption, { parse_mode: 'HTML' });
        }
        return;
      }

      const multiExpense = parseMultiExpenseMessage(text);
      if (multiExpense.kind === 'invalid') {
        await ctx.reply('Niektoré položky sa nepodarilo jednoznačne rozpoznať. Skúste ich oddeliť bodkočiarkou alebo každú napíšte na nový riadok.');
        return;
      }
      if (multiExpense.kind === 'valid') {
        const savedBatch = await saveTransactionBatch(ctx, multiExpense.items);
        if (!savedBatch) throw new Error('Batch transaction could not be saved');
        const budgetFollowUps = await Promise.all([...new Set(savedBatch.map((item) => item.slug))].map((slug) => budgetFollowUp(ctx, slug)));
        await ctx.reply([batchTransactionSummary(savedBatch), ...budgetFollowUps.flatMap((followUp) => followUp.lines)].join('\n'));
        for (const offer of budgetFollowUps.map((followUp) => followUp.offer).filter((value): value is BudgetCategory => Boolean(value))) await sendBudgetOffer(ctx, offer);
        return;
      }

      const saved = await saveTransaction(ctx, text);
      if (!saved) {
        await ctx.reply('Sumu sa nepodarilo rozpoznať. Skúste napríklad: Káva 3 €');
        return;
      }
      const budgetFollowUpResult = await budgetFollowUp(ctx, saved.slug);
      await ctx.reply([`✅ Zapísané: ${saved.label} – ${formatAmount(saved.amount, saved.currency)}`, ...budgetFollowUpResult.lines].join('\n'));
      if (budgetFollowUpResult.offer) await sendBudgetOffer(ctx, budgetFollowUpResult.offer);
    } catch (error) {
      // The webhook has already been acknowledged; log failures without allowing
      // them to escape middleware and trigger a Telegram redelivery.
      console.error('Telegram message processing failed', {
        updateId: ctx.update.update_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  bot.catch((error) => console.error('Telegram update failed', { updateId: error.ctx.update.update_id, message: error.message }));
  return bot;
}
