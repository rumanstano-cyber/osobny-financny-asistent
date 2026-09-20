export class ReceiptPersistenceError extends Error {
  readonly code = 'receipt_persistence_failed';

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly storageKey: string | null = null,
  ) {
    super(message);
    this.name = 'ReceiptPersistenceError';
  }
}
