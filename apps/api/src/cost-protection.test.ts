import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRateLimitPolicies,
  CostLimitExceededError,
  costProtectionLimits,
  createCostProtector,
  telegramUserHash,
  type ConsumeLimits,
} from './cost-protection.js';

function memoryConsumer(): ConsumeLimits {
  const counters = new Map<string, number>();
  return async (operation, cost, limits) => {
    const keys = limits.map((limit) => `${operation}:${limit.scopeType}:${limit.scopeKeyHash}:${limit.windowSeconds}`);
    const denied = limits.some((limit, index) => (counters.get(keys[index]) ?? 0) + cost > limit.limit);
    if (denied) return { allowed: false, retry_after_seconds: 60 };
    limits.forEach((_, index) => counters.set(keys[index], (counters.get(keys[index]) ?? 0) + cost));
    return { allowed: true, retry_after_seconds: 0 };
  };
}

test('normal usage passes and raw Telegram identifiers are never stored in policies', async () => {
  const protect = createCostProtector(memoryConsumer());
  await protect('receipt_upload', 'telegram:123456789');
  const policies = buildRateLimitPolicies('receipt_upload', 'telegram:123456789');
  assert.equal(policies.length, costProtectionLimits.receipt_upload.length);
  assert.ok(policies.every((policy) => /^[0-9a-f]{64}$/.test(policy.scopeKeyHash)));
  assert.ok(policies.every((policy) => !JSON.stringify(policy).includes('123456789')));
  assert.match(telegramUserHash('123456789'), /^[0-9a-f]{64}$/);
});

test('receipt abuse is blocked before the sixth request in ten minutes', async () => {
  const protect = createCostProtector(memoryConsumer());
  for (let index = 0; index < 5; index += 1) await protect('receipt_upload', 'telegram:42');
  await assert.rejects(
    () => protect('receipt_upload', 'telegram:42'),
    (error: unknown) => error instanceof CostLimitExceededError && error.retryAfterSeconds === 60,
  );
});

test('parallel requests cannot consume more than the configured limit', async () => {
  const protect = createCostProtector(memoryConsumer());
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => protect('receipt_upload', 'telegram:parallel-user')),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 5);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 15);
});

test('different users still share and enforce global limits', async () => {
  const templates = costProtectionLimits.receipt_upload;
  const globalHourlyLimit = templates.find((policy) => policy.scopeType === 'global' && policy.windowSeconds === 3600)?.limit;
  assert.equal(globalHourlyLimit, 200);

  let globalUsage = 0;
  const consume: ConsumeLimits = async (_operation, cost, limits) => {
    const globalHourly = limits.find((policy) => policy.scopeType === 'global' && policy.windowSeconds === 3600)!;
    if (globalUsage + cost > globalHourly.limit) return { allowed: false, retry_after_seconds: 120 };
    globalUsage += cost;
    return { allowed: true, retry_after_seconds: 0 };
  };
  const protect = createCostProtector(consume);
  for (let index = 0; index < 200; index += 1) await protect('receipt_upload', `telegram:${index}`);
  await assert.rejects(() => protect('receipt_upload', 'telegram:blocked'), CostLimitExceededError);
});

test('invalid cost and blank subject fail closed', async () => {
  const protect = createCostProtector(memoryConsumer());
  await assert.rejects(() => protect('telegram_update', 'telegram:1', 0), /positive integer/);
  await assert.rejects(() => protect('telegram_update', '   '), /subject is required/);
});
