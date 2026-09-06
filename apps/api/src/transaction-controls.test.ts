import assert from 'node:assert/strict';
import test from 'node:test';
import { cancelLastTransactionDecision, isCancelLastTransactionRequest } from './transaction-controls.js';

test('recognizes the requested Slovak forms for cancelling the last transaction', () => {
  for (const text of [
    'Zruš posledný zápis',
    'Odstráň posledný zápis',
    'Vymaž posledný zápis',
    'Zmaž poslednú transakciu',
    'Zruš poslednú transakciu',
    'Odstráň poslednú transakciu',
    'Vymaž poslednú transakciu',
    'Zruš zápis',
    'Vymaž zápis',
    'Odstráň zápis',
    'Zrušiť posledný zápis',
    'Vymazať poslednú transakciu',
    'Prosím, zruš mi posledný zápis',
    'Zruš posledný zápis, prosím.',
  ]) assert.equal(isCancelLastTransactionRequest(text), true, text);
});

test('does not treat an ambiguous or bulk deletion request as cancelling the last transaction', () => {
  assert.equal(isCancelLastTransactionRequest('Vymaž všetky zápisy'), false);
  assert.equal(isCancelLastTransactionRequest('Odstráň transakcie'), false);
  assert.equal(isCancelLastTransactionRequest('Zruš to'), false);
});

test('does not issue a void action when the user has no last transaction', () => {
  assert.deepEqual(cancelLastTransactionDecision(false), { kind: 'no_last_transaction' });
  assert.deepEqual(cancelLastTransactionDecision(true), { kind: 'confirm_void' });
});
