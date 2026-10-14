import { findFinancialAmounts, parseFinancialMessage } from './finance-parser.js';

export type LoanDirection = 'lent' | 'borrowed';
export type LoanIntent =
  | { kind: 'principal' | 'repayment'; direction: LoanDirection; name: string | null; amountMinor: number; currencyCode: string; dueOn: string | null }
  | { kind: 'status'; direction: LoanDirection | null; name: string | null }
  | null;

const person = String.raw`([\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*)?)`;
type NameCase = 'dative' | 'genitive' | null;
type WritePattern = { kind: 'principal' | 'repayment'; direction: LoanDirection; nameCase: NameCase; expression: RegExp };

function trimName(value: string | undefined): string | null {
  const name = value?.trim().replace(/[.,!?]+$/u, '').trim() ?? '';
  return name.length >= 2 && name.length <= 120 && !/^(?:mi|som|si|od|u|ešte)\s/iu.test(name) ? name : null;
}

export function nameKey(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLocaleLowerCase('sk-SK').trim();
}

function canonicalPerson(value: string | null, inflected: NameCase): string | null {
  if (!value || !inflected) return value;
  const dative: Record<string, string> = { janovi: 'Jano', petrovi: 'Peter', markovi: 'Marek', martinovi: 'Martin' };
  const genitive: Record<string, string> = { jana: 'Jano', petra: 'Peter', marka: 'Marek', martina: 'Martin' };
  return value.split(' ').map((part) => {
    const key = nameKey(part);
    if (inflected === 'dative' && key === 'janovi' && part.toLocaleLowerCase('sk-SK').startsWith('ján')) return 'Ján';
    if (inflected === 'genitive' && key === 'jana' && part.toLocaleLowerCase('sk-SK').startsWith('já')) return 'Ján';
    const known = (inflected === 'dative' ? dative : genitive)[key];
    if (known) return known;
    if (inflected === 'dative' && /ovi$/u.test(key)) return part.slice(0, -3);
    if (inflected === 'genitive' && /a$/u.test(key)) return part.slice(0, -1);
    return part;
  }).join(' ');
}

export function dativePerson(name: string): string {
  const known: Record<string, string> = { Peter: 'Petrovi', Marek: 'Markovi', Martin: 'Martinovi', Ján: 'Jánovi', Jano: 'Janovi' };
  return name.split(' ').map((part) => known[part] ?? (part.endsWith('o') ? `${part.slice(0, -1)}ovi` : `${part}ovi`)).join(' ');
}

export function findPersonMatches(name: string, people: readonly { id: string; name: string }[]): { id: string; name: string }[] {
  const query = nameKey(name);
  const exact = people.filter((person) => nameKey(person.name) === query);
  if (exact.length) return exact;
  return people.filter((person) => nameKey(person.name).split(' ')[0] === query);
}

function dueDate(text: string, now = new Date()): string | null {
  const match = /\bdo\s+(\d{1,2})\.\s*(?:([\p{L}]+)|([0-9]{1,2})\.)\s*(?:([0-9]{4}))?/iu.exec(text);
  if (!match) return null;
  const months: Record<string, number> = {
    januara: 1, februara: 2, marca: 3, aprila: 4, maja: 5, juna: 6,
    jula: 7, augusta: 8, septembra: 9, oktobra: 10, novembra: 11, decembra: 12,
  };
  const month = match[3] ? Number(match[3]) : months[nameKey(match[2])];
  const day = Number(match[1]);
  if (!month || month > 12 || day < 1 || day > 31) return null;
  let year = match[4] ? Number(match[4]) : now.getUTCFullYear();
  let date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  if (!match[4] && date.getTime() < now.getTime() - 86_400_000) {
    year += 1;
    date = new Date(Date.UTC(year, month - 1, day));
  }
  return date.toISOString().slice(0, 10);
}

function rule(kind: WritePattern['kind'], direction: LoanDirection, nameCase: NameCase, source: string): WritePattern {
  return { kind, direction, nameCase, expression: new RegExp(`^${source}$`, 'iu') };
}

const writePatterns: WritePattern[] = [
  rule('principal', 'borrowed', 'dative', String.raw`(?:som\s+)?dlžn[ýá]\s+${person}`),
  rule('principal', 'borrowed', 'dative', String.raw`som\s+${person}\s+dlžn[ýá]`),
  rule('principal', 'borrowed', 'dative', String.raw`${person}\s+som\s+dlžn[ýá]`),
  rule('principal', 'borrowed', 'dative', String.raw`(?:ešte\s+)?dlžím\s+${person}`),
  rule('principal', 'borrowed', 'dative', String.raw`${person}\s+(?:ešte\s+)?dlžím`),
  rule('principal', 'borrowed', 'dative', String.raw`mám\s+dlh\s+voči\s+${person}`),
  rule('principal', 'borrowed', 'genitive', String.raw`mám\s+u\s+${person}\s+dlh`),
  rule('principal', 'borrowed', 'genitive', String.raw`požičal\s+som\s+si\s+od\s+${person}`),
  rule('principal', 'borrowed', null, String.raw`${person}\s+mi\s+požičal`),
  rule('principal', 'borrowed', 'genitive', String.raw`vzal\s+som\s+si\s+od\s+${person}`),
  rule('principal', 'borrowed', 'genitive', String.raw`mám\s+od\s+${person}\s+požičaných`),
  rule('principal', 'lent', 'dative', String.raw`požičal\s+som\s+${person}`),
  rule('principal', 'lent', 'dative', String.raw`som\s+požičal\s+${person}`),
  rule('principal', 'lent', 'dative', String.raw`dal\s+som\s+${person}\s+požičať`),
  rule('principal', 'lent', 'dative', String.raw`${person}\s+som\s+požičal`),
  rule('principal', 'lent', null, String.raw`${person}\s+mi\s+dlhuje`),
  rule('principal', 'lent', null, String.raw`${person}\s+je\s+mi\s+dlžn[ýá]`),
  rule('principal', 'lent', 'genitive', String.raw`mám\s+u\s+${person}`),
  rule('principal', 'lent', null, String.raw`${person}\s+mi\s+má\s+vrátiť`),
  rule('principal', 'lent', 'dative', String.raw`dal\s+som\s+${person}\s+na\s+pôžičku`),
  rule('principal', 'lent', 'dative', String.raw`(?:pôžička|požička)\s+${person}`),
  rule('repayment', 'borrowed', 'dative', String.raw`vr[áa]til\s+som\s+(?:časť\s+dlhu\s+)?${person}`),
  rule('repayment', 'borrowed', 'dative', String.raw`${person}\s+som\s+vr[áa]til`),
  rule('repayment', 'borrowed', 'dative', String.raw`(?:spl[áa]cal|splatil|uhradil|vyrovnal)\s+som\s+([\p{L}][\p{L}'-]*)\s+(?:pôžičku|pozicku)`),
  rule('repayment', 'borrowed', 'dative', String.raw`(?:spl[áa]cal|splatil|uhradil|vyrovnal)\s+som\s+${person}`),
  rule('repayment', 'borrowed', 'dative', String.raw`dal\s+som\s+${person}\s+späť`),
  rule('repayment', 'lent', null, String.raw`${person}\s+mi\s+vr[áa]til(?:\s+(?:časť|pôžičku))?`),
  rule('repayment', 'lent', null, String.raw`mi\s+${person}\s+vr[áa]til`),
  rule('repayment', 'lent', null, String.raw`${person}\s+vr[áa]til`),
  rule('repayment', 'lent', null, String.raw`${person}\s+mi\s+(?:splatil|uhradil)`),
  rule('repayment', 'lent', null, String.raw`${person}\s+mi\s+dal\s+späť`),
  rule('repayment', 'lent', 'genitive', String.raw`od\s+${person}\s+som\s+dostal\s+späť`),
  rule('repayment', 'lent', null, String.raw`${person}\s+splatil\s+pôžičku`),
];

const loanWords = /(?:dlž|dlh|požič|pôžič|pozick|vr[áa]til|vr[áa]ti[ťt]|spl[áa]cal|splatil|uhradil|vyrovnal)/iu;
const uncertainty = /\b(?:neviem|možno|asi|snáď|nič|nedlžím|nedlhuje|nepožičal|nevrátil)\b/iu;

export function loanClarification(text: string): string | null {
  if (!loanWords.test(text)) return null;
  if (uncertainty.test(text)) return 'Z tejto správy neviem bezpečne zapísať pôžičku. Ak chceš zaznamenať pohyb, napíš komu, koľko a čo sa stalo.';
  if (findFinancialAmounts(text).length === 0) return 'Akú sumu mám pri pôžičke zaznamenať?';
  if (/^\s*(?:ešte\s+)?dlžím\s*(?:\d|€)/iu.test(text)) return 'Komu dlhuješ uvedenú sumu?';
  return 'Pôžičku neviem jednoznačne rozpoznať. Napíš, prosím, kto komu dlhuje alebo kto komu vrátil peniaze.';
}

export function parseLoanIntent(text: string, now = new Date()): LoanIntent {
  const input = text.trim();
  const normalized = nameKey(input);
  if (/^(?:stav\s+poziciek|ukaz\s+moje\s+pozicky|kto\s+mi\s+dlhuje|kolko\s+mi\s+dlhuju|komu\s+dlhujem|kolko\s+este\s+dlhuje|kolko\s+este\s+dlhujem)/u.test(normalized)) {
    const direction: LoanDirection | null = /komu\s+dlhujem|kolko\s+este\s+dlhujem/u.test(normalized) ? 'borrowed'
      : /kto\s+mi\s+dlhuje|kolko\s+mi\s+dlhuju|kolko\s+este\s+dlhuje/u.test(normalized) ? 'lent' : null;
    const personName = /(?:dlhuje|dlhujem)\s+([\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*)?)(?:\?|\.)?$/iu.exec(input)?.[1];
    return { kind: 'status', direction, name: canonicalPerson(trimName(personName), direction === 'borrowed' ? 'dative' : null) };
  }
  if (uncertainty.test(input)) return null;
  const amountMatches = findFinancialAmounts(input);
  if (amountMatches.length === 0) return null;
  const amountMatch = amountMatches[0];
  const head = input.slice(0, amountMatch.index) + input.slice(amountMatch.end);
  const [statement, ...tail] = head.split(/[,;]/u);
  if (tail.length && (!dueDate(input, now) || !/^\s*má\s+mi\s+ich\s+vrátiť\s+do\s+/iu.test(tail.join(',')))) return null;
  if (findFinancialAmounts(statement).length > 0) return null;
  const phrase = statement.trim().replace(/[.!?]+$/u, '').trim();
  const parsed = parseFinancialMessage(input);
  if (!parsed) return null;
  for (const pattern of writePatterns) {
    const match = pattern.expression.exec(phrase);
    if (!match) continue;
    const parsedName = trimName(match[1]);
    if (!parsedName) continue;
    return {
      kind: pattern.kind, direction: pattern.direction,
      name: canonicalPerson(parsedName, pattern.nameCase),
      amountMinor: parsed.amountMinor, currencyCode: parsed.currencyCode,
      dueOn: pattern.kind === 'principal' ? dueDate(input, now) : null,
    };
  }
  if (/^požičal\s+som$/iu.test(phrase)) {
    return { kind: 'principal', direction: 'lent', name: null, amountMinor: parsed.amountMinor, currencyCode: parsed.currencyCode, dueOn: dueDate(input, now) };
  }
  return null;
}
