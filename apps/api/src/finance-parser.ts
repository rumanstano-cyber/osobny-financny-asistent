export type ParsedTransaction = {
  amountMinor: number;
  currencyCode: 'EUR' | 'CZK' | 'USD' | 'GBP' | 'HUF' | 'PLN';
  transactionType: 'income' | 'expense';
  categorySlug: string;
  categoryLabel: string;
  note: string;
};

const expenseCategories = [
  { slug: 'potraviny', label: 'Potraviny', terms: ['potraviny', 'lidl', 'kaufland', 'tesco', 'billa', 'coop'] },
  { slug: 'auto', label: 'Auto', terms: ['benzin', 'nafta', 'palivo', 'tankovanie', 'auto'] },
  { slug: 'byvanie', label: 'Bývanie', terms: ['najom', 'energie', 'elektrina', 'plyn', 'hypoteka'] },
  { slug: 'restauracie', label: 'Reštaurácie', terms: ['restauracia', 'obed', 'vecera', 'pizza', 'kava', 'coffee', 'cappuccino', 'espresso', 'kaviaren', 'cafe', 'starbucks', 'costa'] },
  { slug: 'zabava', label: 'Zábava', terms: ['kino', 'netflix', 'zabava', 'koncert'] },
  { slug: 'drogeria', label: 'Drogéria', terms: ['drogeria', 'dm', 'teta'] },
  { slug: 'elektronika', label: 'Elektronika', terms: ['telefon', 'televizor', 'notebook', 'elektronika'] },
  { slug: 'oblecenie', label: 'Oblečenie', terms: ['oblecenie', 'tricko', 'nohavice', 'topanky'] },
  { slug: 'zdravie', label: 'Zdravie', terms: ['lekar', 'lekaren', 'zdravie', 'zubar'] },
  { slug: 'domacnost', label: 'Domácnosť', terms: ['domacnost', 'nabytok'] },
  { slug: 'deti', label: 'Deti', terms: ['deti', 'dieta', 'skolka'] },
  { slug: 'poistenie', label: 'Poistenie', terms: ['poistenie'] },
  { slug: 'dovolenka', label: 'Dovolenka', terms: ['dovolenka', 'hotel', 'letenka'] },
];

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function extractAmount(input: string): { raw: string; currencyCode: ParsedTransaction['currencyCode']; minorUnit: number } | null {
  const match = input.match(/(?:€\s*)?(\d{1,12}(?:[\s.,]\d{1,2})?)\s*(€|eur|kč|czk|\$|usd|£|gbp|huf|ft|pln)?/iu);
  if (!match) return null;

  const currencyToken = normalize(match[2] ?? '€');
  const currency = currencyToken === 'kč' || currencyToken === 'czk'
    ? { currencyCode: 'CZK' as const, minorUnit: 2 }
    : currencyToken === '$' || currencyToken === 'usd'
      ? { currencyCode: 'USD' as const, minorUnit: 2 }
      : currencyToken === '£' || currencyToken === 'gbp'
        ? { currencyCode: 'GBP' as const, minorUnit: 2 }
        : currencyToken === 'huf' || currencyToken === 'ft'
          ? { currencyCode: 'HUF' as const, minorUnit: 0 }
          : currencyToken === 'pln'
            ? { currencyCode: 'PLN' as const, minorUnit: 2 }
            : { currencyCode: 'EUR' as const, minorUnit: 2 };
  return { raw: match[1], ...currency };
}

function toMinorUnits(raw: string, minorUnit: number): number | null {
  const normalized = raw.replace(/\s/g, '').replace(',', '.');
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [integerPart, fractionPart = ''] = normalized.split('.');
  const paddedFraction = `${fractionPart}${'0'.repeat(minorUnit)}`.slice(0, minorUnit);
  const result = Number(integerPart) * 10 ** minorUnit + Number(paddedFraction || 0);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

export function parseFinancialMessage(text: string): ParsedTransaction | null {
  const amount = extractAmount(text);
  if (!amount) return null;
  const amountMinor = toMinorUnits(amount.raw, amount.minorUnit);
  if (!amountMinor) return null;

  const normalized = normalize(text);
  const isIncome = /\b(vyplata|prijem|plat|bonus|odmena)\b/u.test(normalized);
  const category = isIncome
    ? (normalized.includes('vyplata') || normalized.includes('plat')
      ? { slug: 'vyplata', label: 'Výplata' }
      : { slug: 'iny-prijem', label: 'Príjem' })
    : expenseCategories.find((candidate) => candidate.terms.some((term) => normalized.includes(term)))
      ?? { slug: 'ostatne', label: 'Ostatné' };

  const note = text
    .replace(/(?:€\s*)?\d{1,12}(?:[\s.,]\d{1,2})?\s*(?:€|eur|kč|czk|\$|usd|£|gbp|huf|ft|pln)?/iu, '')
    .trim();

  return {
    amountMinor,
    currencyCode: amount.currencyCode,
    transactionType: isIncome ? 'income' : 'expense',
    categorySlug: category.slug,
    categoryLabel: category.label,
    note,
  };
}

export function formatAmount(amountMinor: number, currencyCode: ParsedTransaction['currencyCode']): string {
  const fractionDigits = currencyCode === 'HUF' ? 0 : 2;
  const amount = new Intl.NumberFormat('sk-SK', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amountMinor / 10 ** fractionDigits).replace(/\u00a0/g, ' ');
  const labels: Record<ParsedTransaction['currencyCode'], string> = {
    EUR: '€', CZK: 'Kč', USD: '$', GBP: '£', HUF: 'HUF', PLN: 'PLN',
  };
  return `${amount} ${labels[currencyCode]}`;
}
