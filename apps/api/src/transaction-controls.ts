export type CancelLastTransactionDecision =
  | { kind: 'confirm_void' }
  | { kind: 'no_last_transaction' };

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('sk-SK')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Matches only clear requests to cancel one transaction. It deliberately does
 * not accept plural or unspecified deletion requests such as "vymaž všetko".
 */
export function isCancelLastTransactionRequest(text: string): boolean {
  const value = normalize(text);
  return /^(?:prosim\s+)?(?:zrus|zrusit|odstran|odstranit|vymaz|vymazat|zmaz|zmazat|odvolaj)\s+(?:(?:mi|to)\s+)?(?:(?:posledn\p{L}*|naposledy)\s+)?(?:zapis(?:u|om|e)?|transakciu|transakcia|transakcii)(?:\s+prosim)?$/u.test(value);
}

export function cancelLastTransactionDecision(hasLastTransaction: boolean): CancelLastTransactionDecision {
  return hasLastTransaction ? { kind: 'confirm_void' } : { kind: 'no_last_transaction' };
}
