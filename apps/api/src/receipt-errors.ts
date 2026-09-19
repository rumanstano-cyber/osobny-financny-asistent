export class ReceiptPersistenceError extends Error {
  readonly code = 'receipt_persistence_failed';

  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'ReceiptPersistenceError';
  }
}
