import OpenAI, { toFile } from 'openai';
import { config } from './config.js';

const client = config.OPENAI_API_KEY ? new OpenAI({ apiKey: config.OPENAI_API_KEY }) : null;

function requireClient(): OpenAI {
  if (!client) throw new Error('OPENAI_API_KEY is not configured');
  return client;
}

export async function transcribeVoice(audio: Buffer, fileName: string): Promise<string> {
  const transcription = await requireClient().audio.transcriptions.create({
    file: await toFile(audio, fileName, { type: 'audio/ogg' }),
    model: 'gpt-4o-mini-transcribe',
    language: 'sk',
  });
  return transcription.text.trim();
}

export type ReceiptExtraction = { merchantName: string | null; receiptDate: string | null; amountMinor: number | null; currencyCode: 'EUR'; ocrText: string };
export type ExpenseCategoryAiResult = { categorySlug: string; confidence: number; reason: string };

const expenseCategorizationPrompt = `Si klasifikátor výdavkov pre slovenského osobného finančného asistenta. Vráť výhradne JSON vo formáte {"categorySlug":"...","confidence":0 až 1,"reason":"stručné vysvetlenie"}. Môžeš vrátiť iba jednu z kategórií: auto, byvanie, domacnost, potraviny, restauracie, poistenie, zdravie, drogeria, oblecenie, elektronika, deti, dovolenka, zabava, ostatne.

Kategórie a ich presný rozsah:
- Auto: Palivá, tankovanie, servisy, diely, pneu, umývanie, parkovné, diaľničné známky, STK, a VÝHRADNE poistenie auta (PZP/havarijné).
- Bývanie: Nájom, energie (elektrina, plyn, voda), pevný internet/TV, a VÝHRADNE poistenie nehnuteľnosti/domácnosti.
- Domácnosť: Nábytok, spotrebiče, náradie, opravy v byte, čistiace prostriedky.
- Potraviny: Supermarkety a nákupy potravín/nápojov na doma.
- Reštaurácie: Hotové jedlá, kaviarne, obedy, pivo/alkohol v podniku, donášky (Wolt), fastfood.
- Poistenie: VÝHRADNE osobné poistenie (životné, úrazové, III. pilier). Poistka auta ide pod Auto, poistka domu pod Bývanie.
- Zdravie: Lekárne, lieky, zubár, vyšetrenia, okuliare.
- Drogéria: Osobná hygiena, kozmetika, starostlivosť o telo.
- Oblečenie: Odevy, obuv, móda, športové oblečenie.
- Elektronika: Telefóny, počítače, IT príslušenstvo, softvér.
- Deti: Hračky, krúžky, školské potreby, oblečenie pre deti.
- Dovolenka: Ubytovanie, letenky, zájazdy, a cestovné poistenie.
- Zábava: Kino, divadlo, knihy, streaming (Netflix, Spotify), koncerty, hry.
- Ostatné: Bankové poplatky, pošta, pokuty, výbery z ATM (Fallback, ak si AI nie je istá na >80%).

Pravidlá rozhodovania pre neznáme alebo nešpecifikované položky:
1. HLAVNÝ ÚČEL: Zváž primárny účel položky (napr. autopríslušenstvo, autopásy, čistič skiel na auto -> AUTO; žiarovka do stolnej lampy -> DOMÁCNOSŤ).
2. KONTEXT OBCHODNÍKA: Zohľadni typ predajcu alebo charakter obchodu (napr. servis, lekáreň, papiernictvo).
3. PRAVIDLO ISTOTY (FALLBACK): Ak ani podľa účelu a predajcu nevieš s istotou (>80 %) určiť správnu kategóriu, ZARADIŠ POLOŽKU DO "Ostatné". Nikdy nehádaj a nevymýšľaj si nové kategórie.`;

export async function classifyExpenseWithAi(context: string): Promise<ExpenseCategoryAiResult | null> {
  if (!client) return null;
  try {
    const result = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: expenseCategorizationPrompt },
        { role: 'user', content: `Klasifikuj tento výdavok:\n${context.slice(0, 8_000)}` },
      ],
    });
    const parsed = JSON.parse(result.choices[0]?.message.content ?? '{}') as Partial<ExpenseCategoryAiResult>;
    return typeof parsed.categorySlug === 'string'
      && typeof parsed.confidence === 'number'
      && typeof parsed.reason === 'string'
      ? { categorySlug: parsed.categorySlug, confidence: parsed.confidence, reason: parsed.reason }
      : null;
  } catch (error) {
    console.warn('AI expense categorization failed', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export async function extractReceipt(image: Buffer, mimeType: string): Promise<ReceiptExtraction> {
  const result = await requireClient().chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: 'Extract a Slovak receipt. Return JSON only: merchantName (string|null), receiptDate (YYYY-MM-DD|null), amountMinor (integer|null, EUR cents), ocrText (string).' }, {
      role: 'user', content: [{ type: 'text', text: 'Read this receipt.' }, { type: 'image_url', image_url: { url: `data:${mimeType};base64,${image.toString('base64')}` } }],
    }],
  });
  const parsed = JSON.parse(result.choices[0]?.message.content ?? '{}') as Partial<ReceiptExtraction>;
  return { merchantName: typeof parsed.merchantName === 'string' ? parsed.merchantName : null, receiptDate: typeof parsed.receiptDate === 'string' ? parsed.receiptDate : null, amountMinor: Number.isSafeInteger(parsed.amountMinor) && (parsed.amountMinor ?? 0) > 0 ? parsed.amountMinor! : null, currencyCode: 'EUR', ocrText: typeof parsed.ocrText === 'string' ? parsed.ocrText : '' };
}

export async function monthlyCommentary(summary: string): Promise<string> {
  const result = await requireClient().chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: 'You are a cautious personal-finance assistant. Write a short Slovak summary, never investment advice.' }, { role: 'user', content: summary }] });
  return result.choices[0]?.message.content?.trim() ?? '';
}
