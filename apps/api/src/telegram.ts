import { createHash } from 'node:crypto';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import { describeReceiptOcrFailure, extractReceipt, transcribeVoice, type ReceiptExtraction } from './ai.js';
import { categorizeExpense, type CategorizationInput } from './category-categorizer.js';
import { config } from './config.js';
import { readEkasaReceiptQr } from './ekasa-qr.js';
import { formatAmount, parseFinancialMessage } from './finance-parser.js';
import { optimizeReceiptImage } from './receipt-image.js';
import { supabase } from './supabase.js';
import { downloadTelegramFile } from './telegram-files.js';
import { currentMonthVisualReport, currentWeekSummary } from './reports.js';

type RpcResult = { transaction_id: string; workspace_id: string; was_duplicate: boolean };
type LastTransaction = {
  transaction_id: string;
  transaction_type: 'income' | 'expense' | 'transfer';
  amount_minor: number;
  currency_code: string;
  category_name: string | null;
  note: string | null;
  occurred_at: string;
};
type CorrectedTransaction = {
  transaction_id: string;
  amount_minor: number;
  currency_code: string;
  category_name: string | null;
  note: string | null;
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

/** A report request must be handled before attempting to parse an amount. */
function isCurrentMonthReportRequest(text: string): boolean {
  return /\breport\b|prehľad|prehlad|sumár|sumar|štatistik|koľko som minul|stav mojich financií|súhrn|suhrn/iu.test(text);
}

function isCurrentWeekReportRequest(text: string): boolean {
  return /týžden|tyzden|tento\s+týždeň|tento\s+tyzden|koľko som minul tento týždeň|koľko som minul tento tyzden/iu.test(text);
}

function isReceiptClaimRequest(text: string): boolean {
  return /reklam|blo[cč]ek|doklad|účten/iu.test(text);
}

function isCancelLastTransactionRequest(text: string): boolean {
  return /\b(zruš|zrus|vymaž|vymaz|odvolaj)\b.*\b(posledn\p{L}*|naposledy)\b/iu.test(text);
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

async function correctLastTransaction(telegramUserId: string, text: string, categorizationInput: CategorizationInput = {}): Promise<CorrectedTransaction | null> {
  const parsed = parseFinancialMessage(text);
  if (!parsed) return null;
  const category = parsed.transactionType === 'expense'
    ? await categorizeExpense({ messageText: text, ...categorizationInput })
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
  return (data as ReceiptClaimMatch[] | null) ?? [];
}

async function getReceiptClaim(telegramUserId: string, receiptId: string): Promise<ReceiptClaimMatch | null> {
  const { data, error } = await supabase.rpc('get_telegram_receipt_for_claim', {
    p_telegram_user_id: telegramUserId,
    p_receipt_id: receiptId,
  });
  if (error) throw new Error(error.message);
  return (data as ReceiptClaimMatch[] | null)?.[0] ?? null;
}

async function handleReceiptClaimSearch(ctx: Context, query: string): Promise<void> {
  if (!ctx.from) return;
  const matches = await findReceiptClaims(String(ctx.from.id), query);
  if (!matches.length) {
    await ctx.reply(`Nenašiel som bloček k „${query}“. Skús názov obchodu alebo položky z dokladu.`);
    return;
  }
  if (matches.length === 1) {
    await ctx.reply('✅ Našiel som bloček. Posielam jeho pôvodnú fotografiu.');
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
  await ctx.reply(`Našiel som ${matches.length} bločkov. Vyber ten správny pre reklamáciu:`, { reply_markup: keyboard });
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
  let stage = 'príprava spracovania';

  try {
    await ctx.reply('🔎 Čítam bloček…');
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
      await ctx.reply('Bloček sa uložil, no sumu sa nepodarilo spoľahlivo nájsť. Skús prosím ostrejšiu fotku.');
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
    const { data: receipt, error: receiptError } = await supabase.from('ofa_receipts').insert({ workspace_id: saved.result.workspace_id, file_id: storedFile.id, uploaded_by_user_id: transaction.created_by_user_id, status: 'completed', merchant_name: extraction.merchantName, receipt_date: extraction.receiptDate, total_amount_minor: extraction.amountMinor, currency_code: 'EUR', ocr_text: extraction.ocrText, ocr_language: 'sk' }).select('id').single();
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
  } catch (error) {
    // Pass the Error object itself to preserve its full stack trace in Render.
    console.error('Receipt processing failed', {
      updateId: ctx.update.update_id,
      telegramUserId: ctx.from.id,
      stage,
    }, error);

    const message = stage === 'OpenAI Vision OCR'
      ? describeReceiptOcrFailure(error).userMessage
      : `Spracovanie bločku zlyhalo pri fáze: ${stage}. Skús to prosím znova.`;
    try {
      await ctx.reply(`❌ ${message}`);
    } catch (replyError) {
      console.error('Unable to send receipt failure message to Telegram', replyError);
    }
  }
}

export function createTelegramBot(): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  bot.command('start', async (ctx) => {
    await ctx.reply('Ahoj! Pošli „Káva 3 €“, hlasovú správu alebo fotku bločku. E-mail teraz nepotrebuješ.');
  });
  bot.command('link', async (ctx) => {
    if (!ctx.from) return;
    try {
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
  bot.callbackQuery(/^claim:([0-9a-f-]{36})$/i, async (ctx) => {
    if (!claimUpdate(ctx.update.update_id)) return;
    try {
      await ctx.answerCallbackQuery();
      if (ctx.chat?.type !== 'private' || !ctx.from) return;
      const receipt = await getReceiptClaim(String(ctx.from.id), ctx.match[1]);
      if (!receipt) {
        await ctx.reply('Tento bloček už nie je dostupný alebo k nemu nemáš prístup. Skús vyhľadávanie znova.');
        return;
      }
      await sendReceiptForClaim(ctx, receipt);
    } catch (error) {
      console.error('Telegram receipt claim selection failed', {
        updateId: ctx.update.update_id,
        telegramUserId: ctx.from?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      try { await ctx.reply('❌ Bloček sa nepodarilo odoslať. Skús výber zopakovať o chvíľu.'); } catch { /* update is already acknowledged */ }
    }
  });
  bot.callbackQuery(/^txn:void:([0-9a-f-]{36})$/i, async (ctx) => {
    if (!claimUpdate(ctx.update.update_id)) return;
    try {
      await ctx.answerCallbackQuery();
      if (ctx.chat?.type !== 'private' || !ctx.from) return;
      const voided = await voidTransaction(String(ctx.from.id), ctx.match[1]);
      if (!voided) {
        await ctx.reply('Tento zápis už nie je možné zrušiť. Možno bol už opravený alebo zrušený.');
        return;
      }
      await ctx.reply(`🗑️ Zápis bol zrušený: ${formatAmount(voided.amount_minor, transactionCurrency(voided.currency_code))}${voided.note?.trim() ? ` (${voided.note.trim()})` : ''}. Do reportov sa už nezapočítava.`);
    } catch (error) {
      console.error('Telegram transaction void failed', {
        updateId: ctx.update.update_id,
        telegramUserId: ctx.from?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      try { await ctx.reply('❌ Zápis sa nepodarilo zrušiť. Skús to prosím o chvíľu znova.'); } catch { /* update is already acknowledged */ }
    }
  });
  bot.callbackQuery(/^txn:keep$/i, async (ctx) => {
    if (!claimUpdate(ctx.update.update_id)) return;
    await ctx.answerCallbackQuery({ text: 'Zápis ostáva bez zmeny.' });
    try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* the original message may no longer be editable */ }
  });
  bot.on('message', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!claimUpdate(ctx.update.update_id)) {
      console.info('Ignoring duplicate Telegram update', { updateId: ctx.update.update_id });
      return;
    }

    try {
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

      if (/^oprav\b/iu.test(text.trim())) {
        const replacement = correctionText(text);
        if (!replacement) {
          const last = await getLastTransaction(String(ctx.from.id));
          await ctx.reply(last
            ? `Posledný zápis je: ${lastTransactionLabel(last)}\n\nNapíš napríklad: <code>oprav posledný zápis na Obed 8,50 €</code>`
            : 'Zatiaľ nemáš žiadny potvrdený zápis na opravu.', { parse_mode: 'HTML' });
          return;
        }
        const corrected = await correctLastTransaction(String(ctx.from.id), replacement);
        if (!corrected) {
          await ctx.reply('Nerozumel som oprave alebo nemáš žiadny potvrdený zápis. Skús napríklad: „oprav posledný zápis na Obed 8,50 €“.');
          return;
        }
        await ctx.reply(`✏️ Opravené: ${corrected.category_name ?? 'Výdavok'} – ${formatAmount(corrected.amount_minor, transactionCurrency(corrected.currency_code))}${corrected.note?.trim() ? ` (${corrected.note.trim()})` : ''}`);
        return;
      }

      if (isCancelLastTransactionRequest(text)) {
        const last = await getLastTransaction(String(ctx.from.id));
        if (!last) {
          await ctx.reply('Zatiaľ nemáš žiadny potvrdený zápis na zrušenie.');
          return;
        }
        const keyboard = new InlineKeyboard()
          .text('Áno, zrušiť', `txn:void:${last.transaction_id}`)
          .text('Ponechať', 'txn:keep');
        await ctx.reply(`⚠️ Naozaj chceš zrušiť posledný zápis?\n${lastTransactionLabel(last)}`, { reply_markup: keyboard });
        return;
      }

      if (isReceiptClaimRequest(text)) {
        const query = receiptClaimQuery(text);
        if (!query) {
          await ctx.reply('Napíš, prosím, čo hľadáš. Napríklad: „reklamácia Lidl“ alebo „potrebujem bloček za kávu“.');
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
          await ctx.reply('❌ Bločky sa teraz nepodarilo vyhľadať. Skús to prosím o chvíľu znova.');
        }
        return;
      }

      if (isCurrentWeekReportRequest(text)) {
        await ctx.reply(await currentWeekSummary(String(ctx.from.id)), { parse_mode: 'HTML' });
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
