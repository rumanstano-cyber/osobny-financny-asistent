import jsQR from 'jsqr';
import sharp from 'sharp';

export type EkasaReceipt = {
  merchantName: string;
  merchantIco: string | null;
  receiptDate: string;
  amountMinor: number;
  rawPayload: string;
};

type JsonRecord = Record<string, unknown>;

const ekasaLookupUrl = 'https://ekasa.financnasprava.sk/mdu/api/v1/opd/receipt/find';
const ekasaHost = 'ekasa.financnasprava.sk';

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findValue(value: unknown, keys: readonly string[]): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findValue(item, keys);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  if (!isRecord(value)) return undefined;
  for (const [key, nestedValue] of Object.entries(value)) {
    if (keys.includes(key.toLowerCase())) return nestedValue;
  }
  for (const nestedValue of Object.values(value)) {
    const found = findValue(nestedValue, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseDate(value: unknown): string | null {
  const text = textValue(value);
  if (!text) return null;
  const slovakDate = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (slovakDate) return `${slovakDate[3]}-${slovakDate[2]}-${slovakDate[1]}`;
  const isoDate = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return isoDate ? isoDate[1] : null;
}

function parseAmountMinor(value: unknown, key: string): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const raw = String(value).trim().replace(',', '.');
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(raw)) return null;
  const numeric = Number(raw);
  const minor = key.includes('minor') || key.includes('cent')
    ? numeric
    : Math.round(numeric * 100);
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

function findAmountMinor(value: unknown): number | null {
  const amountKeys = ['amountminor', 'totalminor', 'totalamountminor', 'totalprice', 'amount', 'totalamount', 'total', 'sum', 'price'];
  for (const key of amountKeys) {
    const raw = findValue(value, [key]);
    const amount = parseAmountMinor(raw, key);
    if (amount !== null) return amount;
  }
  return null;
}

function extractReceipt(value: unknown, rawPayload: string): EkasaReceipt | null {
  const receipt = isRecord(value) && isRecord(value.receipt) ? value.receipt : value;
  const organization = isRecord(receipt) && isRecord(receipt.organization) ? receipt.organization : null;
  const merchantName = textValue(
    organization?.name
      ?? findValue(receipt, ['merchantname', 'sellername', 'organizationname', 'businessname', 'companyname']),
  );
  const merchantIco = textValue(
    organization?.ico
      ?? findValue(receipt, ['merchantico', 'organizationico', 'ico', 'companyid']),
  );
  const receiptDate = parseDate(findValue(receipt, ['receiptdate', 'issuedat', 'issueddate', 'date', 'createdat']));
  const amountMinor = findAmountMinor(receipt);

  // Do not guess from incomplete QR data. Vision remains the fallback unless
  // eKasa supplied the three values needed for a reliable financial record.
  if (!merchantName || !receiptDate || amountMinor === null) return null;
  return { merchantName, merchantIco, receiptDate, amountMinor, rawPayload };
}

function isEkasaReceiptId(payload: string): boolean {
  return /^O-[0-9A-F-]+$/i.test(payload);
}

function offlineEkasaPayload(payload: string): JsonRecord | null {
  const match = payload.match(/^([^:]+):(\d+):(\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}):(\d+):(\d{1,12}(?:[,.]\d{1,2})?)$/);
  if (!match) return null;
  return {
    okp: match[1],
    cashRegisterCode: match[2],
    issueDateFormatted: match[3],
    receiptNumber: Number(match[4]),
    totalAmount: Number(match[5].replace(',', '.')),
  };
}

function isEkasaUrl(payload: string): boolean {
  try {
    const url = new URL(payload);
    return url.protocol === 'https:' && url.hostname === ekasaHost;
  } catch {
    return false;
  }
}

async function fetchEkasaReceipt(payload: string, offlinePayload: JsonRecord | null): Promise<unknown | null> {
  try {
    const response = isEkasaReceiptId(payload) || offlinePayload
      ? await fetch(ekasaLookupUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': 'OsobnyFinancnyAsistent/1.0',
        },
        body: JSON.stringify(offlinePayload ?? { receiptId: payload }),
        signal: AbortSignal.timeout(8_000),
      })
      : await fetch(payload, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });

    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return null;
    return await response.json();
  } catch (error) {
    console.warn('eKasa QR lookup failed', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

async function decodeQrPayload(image: Buffer): Promise<string | null> {
  try {
    const { data, info } = await sharp(image, { limitInputPixels: 24_000_000 })
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const result = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, {
      inversionAttempts: 'attemptBoth',
    });
    return result?.data.trim() || null;
  } catch (error) {
    console.warn('Receipt QR decoding failed', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export async function readEkasaReceiptQr(image: Buffer): Promise<EkasaReceipt | null> {
  const payload = await decodeQrPayload(image);
  if (!payload) return null;

  try {
    const inlinePayload = payload.startsWith('{') ? JSON.parse(payload) : null;
    if (inlinePayload) return extractReceipt(inlinePayload, payload);

    const offlinePayload = offlineEkasaPayload(payload);
    if (!isEkasaReceiptId(payload) && !offlinePayload && !isEkasaUrl(payload)) return null;
    const receipt = await fetchEkasaReceipt(payload, offlinePayload);
    return receipt ? extractReceipt(receipt, payload) : null;
  } catch (error) {
    console.warn('eKasa QR parsing failed', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
