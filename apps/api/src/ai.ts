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
