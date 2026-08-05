import { createHash } from 'node:crypto';
import { Bot, type Context } from 'grammy';
import { extractReceipt, transcribeVoice } from './ai.js';
import { config } from './config.js';
import { formatAmount, parseFinancialMessage } from './finance-parser.js';
import { supabase } from './supabase.js';
import { downloadTelegramFile } from './telegram-files.js';
import { currentMonthSummary } from './reports.js';

type RpcResult = { transaction_id: string; workspace_id: string; was_duplicate: boolean };
const categories = ['potraviny', 'kava', 'auto', 'byvanie', 'restauracie', 'zabava', 'drogeria', 'elektronika', 'oblecenie', 'zdravie', 'domacnost', 'deti', 'poistenie', 'dovolenka'];

function name(ctx: Context) { return [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || ctx.from?.username || 'Používateľ'; }
function receiptCategory(value: string) { const text = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); return categories.find((category) => text.includes(category)) ?? (text.includes('lidl') || text.includes('tesco') ? 'potraviny' : 'ostatne'); }

async function saveTransaction(ctx: Context, text: string): Promise<{ result: RpcResult; label: string; amount: number; currency: 'EUR' | 'CZK' | 'USD' | 'GBP' | 'HUF' | 'PLN' } | null> {
  if (!ctx.from || !ctx.message || !ctx.chat) return null;
  const parsed = parseFinancialMessage(text);
  if (!parsed) return null;
  const { data, error } = await supabase.rpc('record_telegram_transaction', { p_telegram_user_id: String(ctx.from.id), p_display_name: name(ctx), p_chat_id: String(ctx.chat.id), p_message_id: String(ctx.message.message_id), p_update_id: String(ctx.update.update_id), p_message_text: text, p_amount_minor: parsed.amountMinor, p_currency_code: parsed.currencyCode, p_transaction_type: parsed.transactionType, p_category_slug: parsed.categorySlug, p_note: parsed.note, p_occurred_at: new Date(ctx.message.date * 1000).toISOString(), p_time_zone: 'Europe/Bratislava' });
  if (error) throw new Error(error.message);
  const result = (data as RpcResult[] | null)?.[0];
  return result ? { result, label: parsed.categoryLabel, amount: parsed.amountMinor, currency: parsed.currencyCode } : null;
}

async function handleReceipt(ctx: Context): Promise<void> {
  const photo = ctx.message?.photo?.at(-1);
  if (!photo || !ctx.from || !ctx.message) return;
  await ctx.reply('🔎 Čítam bloček…');
  const file = await downloadTelegramFile(photo.file_id);
  const extraction = await extractReceipt(file.bytes, 'image/jpeg');
  if (!extraction.amountMinor) { await ctx.reply('Bloček sa uložil až po doplnení OCR podpory; sumu sa nepodarilo spoľahlivo nájsť.'); return; }
  const synthetic = `${extraction.merchantName ?? 'Bloček'} ${formatAmount(extraction.amountMinor, 'EUR')}`;
  const saved = await saveTransaction(ctx, synthetic);
  if (!saved || saved.result.was_duplicate) return;
  const { data: transaction } = await supabase.from('financial_transactions').select('created_by_user_id').eq('id', saved.result.transaction_id).single();
  if (!transaction) throw new Error('Transaction lookup failed');
  const key = `${saved.result.workspace_id}/${ctx.message.message_id}-${createHash('sha256').update(file.bytes).digest('hex').slice(0, 16)}.jpg`;
  const upload = await supabase.storage.from('ofa-receipts').upload(key, file.bytes, { contentType: 'image/jpeg', upsert: false });
  if (upload.error) throw new Error(upload.error.message);
  const sha256 = `\\x${createHash('sha256').update(file.bytes).digest('hex')}`;
  const { data: storedFile, error: storedFileError } = await supabase.from('stored_files').insert({ workspace_id: saved.result.workspace_id, storage_provider: 'supabase_storage', storage_key: key, content_type: 'image/jpeg', byte_size: file.bytes.length, sha256, uploaded_by_user_id: transaction.created_by_user_id }).select('id').single();
  if (storedFileError || !storedFile) throw new Error(storedFileError?.message ?? 'Receipt file metadata failed');
  const { data: receipt, error: receiptError } = await supabase.from('ofa_receipts').insert({ workspace_id: saved.result.workspace_id, file_id: storedFile.id, uploaded_by_user_id: transaction.created_by_user_id, status: 'completed', merchant_name: extraction.merchantName, receipt_date: extraction.receiptDate, total_amount_minor: extraction.amountMinor, currency_code: 'EUR', ocr_text: extraction.ocrText, ocr_language: 'sk' }).select('id').single();
  if (receiptError || !receipt) throw new Error(receiptError?.message ?? 'Receipt metadata failed');
  await supabase.from('receipt_ocr_runs').insert({ receipt_id: receipt.id, provider: 'openai', provider_model: 'gpt-4o-mini', status: 'completed', extracted_data: extraction, confidence: 0.8, completed_at: new Date().toISOString() });
  await supabase.from('receipt_transaction_links').insert({ receipt_id: receipt.id, transaction_id: saved.result.transaction_id, link_source: 'ocr', confidence: 0.8 });
  await ctx.reply(`✅ Zapísané z bločku: ${extraction.merchantName ?? 'Výdavok'} – ${formatAmount(extraction.amountMinor, 'EUR')}`);
}

export function createTelegramBot(): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  bot.command('start', (ctx) => ctx.reply('Ahoj! Pošli „Káva 3 €“, hlasovú správu alebo fotku bločku.'));
  bot.on('message:photo', async (ctx) => { if (ctx.chat?.type === 'private') await handleReceipt(ctx); });
  bot.on('message:voice', async (ctx) => { if (ctx.chat?.type !== 'private' || !ctx.message.voice) return; await ctx.reply('🎙️ Prepisujem správu…'); const audio = await downloadTelegramFile(ctx.message.voice.file_id); const text = await transcribeVoice(audio.bytes, audio.path); const saved = await saveTransaction(ctx, text); await ctx.reply(saved ? `✅ Zapísané: ${saved.label} – ${formatAmount(saved.amount, saved.currency)}` : `Nerozumel som: „${text}“`); });
  bot.on('message:text', async (ctx) => { if (ctx.chat?.type !== 'private') return; if (/koľko som minul|stav mojich financií|súhrn/i.test(ctx.message.text)) { await ctx.reply(await currentMonthSummary(String(ctx.from.id))); return; } const saved = await saveTransaction(ctx, ctx.message.text); await ctx.reply(saved ? `✅ Zapísané: ${saved.label} – ${formatAmount(saved.amount, saved.currency)}` : 'Nerozumel som sume. Skús napríklad: Káva 3 €'); });
  bot.catch((error) => console.error('Telegram update failed', { updateId: error.ctx.update.update_id, message: error.message }));
  return bot;
}
