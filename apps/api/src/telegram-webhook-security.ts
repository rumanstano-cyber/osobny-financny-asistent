import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

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

/** Reject unsigned updates in onRequest, before Fastify parses the body. */
export function telegramWebhookAuthHook(expected: string | undefined) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const received = request.headers['x-telegram-bot-api-secret-token'];
    if (hasValidTelegramWebhookSecret(expected, received)) return;

    request.log.warn({ hasSecret: Boolean(expected), hasHeader: Boolean(received) }, 'Rejected Telegram webhook with an invalid secret');
    return reply.code(401).send({ error: 'unauthorized' });
  };
}
