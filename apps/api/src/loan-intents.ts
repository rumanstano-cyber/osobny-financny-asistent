import { parseFinancialMessage } from './finance-parser.js';

export type LoanDirection = 'lent' | 'borrowed';
export type LoanIntent =
  | { kind: 'principal' | 'repayment'; direction: LoanDirection; name: string | null; amountMinor: number; currencyCode: string; dueOn: string | null }
  | { kind: 'status'; direction: LoanDirection | null; name: string | null }
  | null;

const person = String.raw`([\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*)?)`;
const amount = String.raw`(?=\s*(?:\d|€))`;

function trimName(value: string | undefined): string | null {
  const name = value?.trim().replace(/[.,!?]+$/u, '').trim() ?? '';
  return name.length >= 2 && name.length <= 120 ? name : null;
}

function canonicalPerson(value: string | null, inflected: 'dative' | 'genitive' | null): string | null {
  if (!value || !inflected) return value;
  const replacements: Record<string, string> = { janovi: 'Jano', petrovi: 'Peter', martinovi: 'Martin' };
  return value.split(' ').map((part) => {
    const key = nameKey(part);
    if (replacements[key]) return replacements[key];
    if (inflected === 'dative' && /ovi$/u.test(key)) return part.slice(0, -3);
    if (inflected === 'genitive' && /a$/u.test(key)) return part.slice(0, -1);
    return part;
  }).join(' ');
}

export function nameKey(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLocaleLowerCase('sk-SK').trim();
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

export function parseLoanIntent(text: string, now = new Date()): LoanIntent {
  const input = text.trim();
  const normalized = nameKey(input);
  if (/^(?:stav\s+poziciek|ukaz\s+moje\s+pozicky|kto\s+mi\s+dlhuje|kolko\s+mi\s+dlhuju|komu\s+dlhujem|kolko\s+este\s+dlhuje|kolko\s+este\s+dlhujem)/u.test(normalized)) {
    const direction: LoanDirection | null = /komu\s+dlhujem|kolko\s+este\s+dlhujem/u.test(normalized) ? 'borrowed'
      : /kto\s+mi\s+dlhuje|kolko\s+mi\s+dlhuju|kolko\s+este\s+dlhuje/u.test(normalized) ? 'lent' : null;
    const personName = /(?:dlhuje|dlhujem)\s+([\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*)?)(?:\?|\.)?$/iu.exec(input)?.[1];
    return { kind: 'status', direction, name: canonicalPerson(trimName(personName), direction === 'borrowed' ? 'dative' : null) };
  }
  const patterns: { kind: 'principal' | 'repayment'; direction: LoanDirection; expression: RegExp }[] = [
    { kind: 'principal', direction: 'borrowed', expression: new RegExp(String.raw`^požičal\s+som\s+si\s+od\s+${person}${amount}`, 'iu') },
    { kind: 'principal', direction: 'lent', expression: new RegExp(String.raw`^požičal\s+som\s+${person}${amount}`, 'iu') },
    { kind: 'principal', direction: 'lent', expression: /^požičal\s+som\s*(?=\d|€)/iu },
    { kind: 'repayment', direction: 'lent', expression: new RegExp(String.raw`^${person}\s+mi\s+vrátil(?:a)?(?:\s+pôžičku)?${amount}`, 'iu') },
    { kind: 'repayment', direction: 'borrowed', expression: new RegExp(String.raw`^${person}(?:ovi|ovi\s+som)?\s+som\s+vrátil(?:a)?${amount}`, 'iu') },
    { kind: 'repayment', direction: 'borrowed', expression: new RegExp(String.raw`^${person}\s+som\s+vrátil(?:a)?${amount}`, 'iu') },
  ];
  // Slovak dative suffixes are removed only from a single first name.
  const borrowedRepayment = /^([\p{L}]+)ovi\s+som\s+vrátil(?:a)?\s+(?=\d|€)/iu.exec(input);
  let detected: { kind: 'principal' | 'repayment'; direction: LoanDirection; name: string | null } | null = borrowedRepayment
    ? { kind: 'repayment', direction: 'borrowed', name: canonicalPerson(borrowedRepayment[1], 'dative') } : null;
  if (!detected) for (const pattern of patterns) {
    const match = pattern.expression.exec(input);
    if (match) {
      const inflection = pattern.kind === 'principal' ? (pattern.direction === 'lent' ? 'dative' : 'genitive') : null;
      detected = { kind: pattern.kind, direction: pattern.direction, name: canonicalPerson(trimName(match[1]), inflection) };
      break;
    }
  }
  if (!detected) return null;
  const parsed = parseFinancialMessage(input);
  if (!parsed) return null;
  return { ...detected, amountMinor: parsed.amountMinor, currencyCode: parsed.currencyCode, dueOn: detected.kind === 'principal' ? dueDate(input, now) : null };
}
