import { timingSafeEqual } from 'node:crypto';

/**
 * Validates Telegram's optional webhook secret without exposing either value
 * through logs or a timing side-channel. Missing configuration is deliberately
 * rejected: accepting unsigned production updates would permit spoofing.
 */
export function hasValidTelegramWebhookSecret(expected: string | undefined, received: string | string[] | undefined): boolean {
  if (!expected || typeof received !== 'string') return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const receivedBytes = Buffer.from(received, 'utf8');
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}
