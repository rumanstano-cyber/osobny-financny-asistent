import { createHash } from 'node:crypto';
import { Bot, type Context } from 'grammy';
import { extractReceipt, transcribeVoice } from './ai.js';
import { categorizeExpense, type CategorizationInput } from './category-categorizer.js';
import { config } from './config.js';
import { readEkasaReceiptQr } from './ekasa-qr.js';
import { formatAmount, parseFinancialMessage } from './finance-parser.js';
import { optimizeReceiptImage } from './receipt-image.js';
import { supabase } from './supabase.js';
import { downloadTelegramFile } from './telegram-files.js';
import { currentMonthSummary } from './reports.js';

type RpcResult = { transaction_id: string; workspace_id: string; was_duplicate: boolean };
type TelegramEmailProfile = { user_id: string; email: string | null };
const processedUpdateIds = new Set<number>();
const maxTrackedUpdates = 10_000;

function name(ctx: Context) { return [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || ctx.from?.username || 'Používateľ'; }

function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function ensureTelegramEmailProfile(ctx: Context): Promise<TelegramEmailProfile | null> {
  if (!ctx.from) return null;
  const { data, error } = await supabase.rpc('ensure_telegram_email_profile', {
    p_telegram_user_id: String(ctx.from.id),
    p_display_name: name(ctx),
  });
  if (error) throw new Error(error.message);
  return (data as TelegramEmailProfile[] | null)?.[0] ?? null;
}

async function requireEmailBeforeFeatures(ctx: Context): Promise<boolean> {
  const profile = await ensureTelegramEmailProfile(ctx);
  if (!profile) return false;
  if (profile.email) return true;

  const text = ctx.message?.text?.trim() ?? '';
  if (isEmailAddress(text)) {
    const { error } = await supabase.rpc('set_telegram_user_email', {
      p_telegram_user_id: String(ctx.from!.id),
      p_display_name: name(ctx),
      p_email: text,
    });
    if (error) {
      console.warn('Telegram e-mail collection failed', { telegramUserId: ctx.from!.id, error: error.message });
      await ctx.reply('E-mail sa nepodarilo uložiť. Skontroluj jeho formát alebo použi inú adresu.');
      return false;
    }
    await ctx.reply('✅ E-mail je uložený. Teraz môžeš poslať výdavok, fotku bločku alebo sa opýtať na finančný prehľad.');
    return false;
  }

  await ctx.reply('Pred použitím bota potrebujem tvoju e-mailovú adresu. Pošli ju prosím v tvare meno@example.com.');
  return false;
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

async function saveTransaction(ctx: Context, text: string, categorizationInput: CategorizationInput = {}): Promise<{ result: RpcResult; label: string; amount: number; currency: 'EUR' | 'CZK' | 'USD' | 'GBP' | 'HUF' | 'PLN' } | null> {
  if (!ctx.from || !ctx.message || !ctx.chat) return null;
  const parsed = parseFinancialMessage(text);
  if (!parsed) return null;
  const category = parsed.transactionType === 'expense'
    ? await categorizeExpense({ messageText: text, ...categorizationInput })
    : { slug: parsed.categorySlug, label: parsed.categoryLabel };
  const { data, error } = await supabase.rpc('record_telegram_transaction', { p_telegram_user_id: String(ctx.from.id), p_display_name: name(ctx), p_chat_id: String(ctx.chat.id), p_message_id: String(ctx.message.message_id), p_update_id: String(ctx.update.update_id), p_message_text: text, p_amount_minor: parsed.amountMinor, p_currency_code: parsed.currencyCode, p_transaction_type: parsed.transactionType, p_category_slug: category.slug, p_note: parsed.note, p_occurred_at: new Date(ctx.message.date * 1000).toISOString(), p_time_zone: 'Europe/Bratislava' });
  if (error) throw new Error(error.message);
  const result = (data as RpcResult[] | null)?.[0];
  return result ? { result, label: category.label, amount: parsed.amountMinor, currency: parsed.currencyCode } : null;
}

async function handleReceipt(ctx: Context): Promise<void> {
  const photo = ctx.message?.photo?.at(-1);
  if (!photo || !ctx.from || !ctx.message) return;
  await ctx.reply('🔎 Čítam bloček…');
  const file = await downloadTelegramFile(photo.file_id);
  const receiptImage = await optimizeReceiptImage(file.bytes);

  // Persist the optimized JPEG before QR/OCR work. The temporary object remains
  // private and is moved to the permanent workspace key after the transaction
  // has resolved the workspace identity.
  const hash = createHash('sha256').update(receiptImage.bytes).digest('hex');
  const temporaryKey = `incoming/telegram/${ctx.update.update_id}-${hash.slice(0, 16)}.jpg`;
  const upload = await supabase.storage.from('ofa-receipts').upload(temporaryKey, receiptImage.bytes, { contentType: 'image/jpeg', upsert: false });
  if (upload.error) throw new Error(upload.error.message);

  const ekasa = await readEkasaReceiptQr(receiptImage.bytes);
  const extraction = ekasa
    ? {
      merchantName: ekasa.merchantName,
      receiptDate: ekasa.receiptDate,
      amountMinor: ekasa.amountMinor,
      currencyCode: 'EUR' as const,
      ocrText: JSON.stringify({ source: 'ekasa_qr', merchantIco: ekasa.merchantIco, qrPayload: ekasa.rawPayload }),
    }
    : await extractReceipt(receiptImage.bytes, 'image/jpeg');

  if (!extraction.amountMinor) { await ctx.reply('Bloček sa uložil až po doplnení OCR podpory; sumu sa nepodarilo spoľahlivo nájsť.'); return; }
  const synthetic = `${extraction.merchantName ?? 'Bloček'} ${formatAmount(extraction.amountMinor, 'EUR')}`;
  if (ekasa) console.log('eKasa amount before transaction save', { amountMinor: ekasa.amountMinor, synthetic });
  const saved = await saveTransaction(ctx, synthetic, { merchantName: extraction.merchantName, receiptText: extraction.ocrText });
  if (!saved || saved.result.was_duplicate) return;
  if (ekasa) console.log('eKasa amount after transaction save', { parsedAmountMinor: saved.amount, transactionId: saved.result.transaction_id });
  const { data: transaction } = await supabase.from('financial_transactions').select('created_by_user_id').eq('id', saved.result.transaction_id).single();
  if (!transaction) throw new Error('Transaction lookup failed');
  const key = `${saved.result.workspace_id}/${ctx.message.message_id}-${hash.slice(0, 16)}.jpg`;
  const move = await supabase.storage.from('ofa-receipts').move(temporaryKey, key);
  if (move.error) throw new Error(move.error.message);
  const sha256 = `\\x${hash}`;
  const { data: storedFile, error: storedFileError } = await supabase.from('stored_files').insert({ workspace_id: saved.result.workspace_id, storage_provider: 'supabase_storage', storage_key: key, content_type: 'image/jpeg', byte_size: receiptImage.bytes.length, sha256, uploaded_by_user_id: transaction.created_by_user_id }).select('id').single();
  if (storedFileError || !storedFile) throw new Error(storedFileError?.message ?? 'Receipt file metadata failed');
  const { data: receipt, error: receiptError } = await supabase.from('ofa_receipts').insert({ workspace_id: saved.result.workspace_id, file_id: storedFile.id, uploaded_by_user_id: transaction.created_by_user_id, status: 'completed', merchant_name: extraction.merchantName, receipt_date: extraction.receiptDate, total_amount_minor: extraction.amountMinor, currency_code: 'EUR', ocr_text: extraction.ocrText, ocr_language: 'sk' }).select('id').single();
  if (receiptError || !receipt) throw new Error(receiptError?.message ?? 'Receipt metadata failed');
  await supabase.from('receipt_ocr_runs').insert({ receipt_id: receipt.id, provider: ekasa ? 'ekasa' : 'openai', provider_model: ekasa ? 'mdu-api-v1' : 'gpt-4o-mini', status: 'completed', extracted_data: extraction, confidence: ekasa ? 1 : 0.8, completed_at: new Date().toISOString() });
  await supabase.from('receipt_transaction_links').insert({ receipt_id: receipt.id, transaction_id: saved.result.transaction_id, link_source: 'ocr', confidence: ekasa ? 1 : 0.8 });
  await ctx.reply(`${ekasa ? '✅ Zapísané z eKasa QR' : '✅ Zapísané z bločku'}: ${extraction.merchantName ?? 'Výdavok'} – ${formatAmount(extraction.amountMinor, 'EUR')}`);
}

export function createTelegramBot(): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  bot.command('start', async (ctx) => {
    try {
      if (await requireEmailBeforeFeatures(ctx)) {
        await ctx.reply('Ahoj! Pošli „Káva 3 €“, hlasovú správu alebo fotku bločku.');
      }
    } catch (error) {
      console.error('Telegram onboarding failed', { telegramUserId: ctx.from?.id, error: error instanceof Error ? error.message : String(error) });
      await ctx.reply('Onboarding sa nepodarilo pripraviť. Skús to prosím o chvíľu znova.');
    }
  });
  bot.command('link', async (ctx) => {
    if (!ctx.from) return;
    try {
      if (!(await requireEmailBeforeFeatures(ctx))) return;
      const code = ctx.match.trim();
      if (!code) {
        await ctx.reply('Vygeneruj si párovací kód vo webovom prehľade a pošli mi: /link TVOJ_KÓD');
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
      await ctx.reply('Párovací kód je neplatný alebo už vypršal. Vygeneruj nový kód vo webovom prehľade.');
    }
  });
  bot.on('message', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!claimUpdate(ctx.update.update_id)) {
      console.info('Ignoring duplicate Telegram update', { updateId: ctx.update.update_id });
      return;
    }

    try {
      if (!(await requireEmailBeforeFeatures(ctx))) return;

      if (ctx.message.photo) {
        await handleReceipt(ctx);
        return;
      }

      // Voice transcription is intentionally reachable only for media updates.
      // A text message has neither `voice` nor `audio` and bypasses this branch.
      const audioMessage = ctx.message.voice ?? ctx.message.audio;
      if (audioMessage) {
        await ctx.reply('🎙️ Prepisujem správu…');
        const audio = await downloadTelegramFile(audioMessage.file_id);
        const text = await transcribeVoice(audio.bytes, audio.path);
        const saved = await saveTransaction(ctx, text);
        await ctx.reply(saved ? `✅ Zapísané: ${saved.label} – ${formatAmount(saved.amount, saved.currency)}` : `Nerozumel som: „${text}“`);
        return;
      }

      const text = ctx.message.text;
      if (!text) {
        await ctx.reply('Podporujem textové správy, hlasové správy a fotky bločkov.');
        return;
      }

      if (/koľko som minul|stav mojich financií|súhrn/i.test(text)) {
        await ctx.reply(await currentMonthSummary(String(ctx.from.id)));
        return;
      }

      const saved = await saveTransaction(ctx, text);
      await ctx.reply(saved ? `✅ Zapísané: ${saved.label} – ${formatAmount(saved.amount, saved.currency)}` : 'Nerozumel som sume. Skús napríklad: Káva 3 €');
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
