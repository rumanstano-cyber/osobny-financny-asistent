export type BatchTransactionCandidate = {
  transaction_id: string;
  amount_minor: number;
  currency_code: string;
  note: string | null;
  merchant_name: string | null;
};

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('sk-SK')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Extracts only the item reference from "Zmeň kategóriu Lidl". */
export function batchCorrectionTarget(text: string): string | null {
  const value = normalize(text);
  const match = value.match(/\b(?:oprav|zmen|presun|zarad)\b.*?\bkategori\p{L}*\s+(.+)$/u);
  if (!match) return null;
  const target = match[1].replace(/\s+\b(?:na|do|pod)\b\s+.+$/u, '').trim();
  return target || null;
}

/** Exact names win; otherwise a single contained match is safe to select. */
export function matchBatchTransactions(
  target: string,
  candidates: BatchTransactionCandidate[],
): BatchTransactionCandidate[] {
  const normalizedTarget = normalize(target);
  if (!normalizedTarget) return [];
  const exact = candidates.filter((candidate) => [candidate.note, candidate.merchant_name]
    .some((value) => normalize(value ?? '') === normalizedTarget));
  if (exact.length > 0) return exact;
  return candidates.filter((candidate) => [candidate.note, candidate.merchant_name]
    .some((value) => normalize(value ?? '').includes(normalizedTarget)));
}

export function batchTransactionCallbackData(transactionId: string): string {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(transactionId)) {
    throw new Error('Invalid batch transaction UUID');
  }
  return `txb:${transactionId}`;
}

export function parseBatchTransactionCallbackData(value: string): string | null {
  const match = /^txb:([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/iu.exec(value);
  return match?.[1] ?? null;
}
