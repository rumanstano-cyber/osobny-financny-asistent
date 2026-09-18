import { createHash } from 'node:crypto';
import { supabase } from './supabase.js';

export type CostOperation =
  | 'telegram_update'
  | 'receipt_upload'
  | 'voice_upload'
  | 'ai_categorization'
  | 'ai_category_correction'
  | 'ai_receipt_ocr'
  | 'ai_voice_transcription'
  | 'ai_report_commentary';

type LimitTemplate = {
  scopeType: 'global' | 'subject';
  windowSeconds: number;
  limit: number;
};

export type RateLimitPolicy = {
  scopeType: 'global' | 'subject';
  scopeKeyHash: string;
  windowSeconds: number;
  limit: number;
};

type ConsumeResult = { allowed: boolean; retry_after_seconds: number };
export type ConsumeLimits = (
  operation: CostOperation,
  cost: number,
  limits: RateLimitPolicy[],
) => Promise<ConsumeResult>;

const day = 24 * 60 * 60;
const hour = 60 * 60;
const tenMinutes = 10 * 60;

// Fixed-window limits are deliberately generous for normal personal use while
// bounding paid-provider and media workload in a compromised or automated flow.
export const costProtectionLimits: Record<CostOperation, readonly LimitTemplate[]> = {
  telegram_update: [
    { scopeType: 'subject', windowSeconds: 60, limit: 40 },
    { scopeType: 'subject', windowSeconds: day, limit: 600 },
    { scopeType: 'global', windowSeconds: 60, limit: 1_000 },
    { scopeType: 'global', windowSeconds: day, limit: 20_000 },
  ],
  receipt_upload: [
    { scopeType: 'subject', windowSeconds: tenMinutes, limit: 5 },
    { scopeType: 'subject', windowSeconds: day, limit: 25 },
    { scopeType: 'global', windowSeconds: hour, limit: 200 },
    { scopeType: 'global', windowSeconds: day, limit: 1_000 },
  ],
  voice_upload: [
    { scopeType: 'subject', windowSeconds: tenMinutes, limit: 10 },
    { scopeType: 'subject', windowSeconds: day, limit: 50 },
    { scopeType: 'global', windowSeconds: hour, limit: 400 },
    { scopeType: 'global', windowSeconds: day, limit: 2_000 },
  ],
  ai_categorization: [
    { scopeType: 'subject', windowSeconds: hour, limit: 30 },
    { scopeType: 'subject', windowSeconds: day, limit: 150 },
    { scopeType: 'global', windowSeconds: hour, limit: 300 },
    { scopeType: 'global', windowSeconds: day, limit: 3_000 },
  ],
  ai_category_correction: [
    { scopeType: 'subject', windowSeconds: hour, limit: 20 },
    { scopeType: 'subject', windowSeconds: day, limit: 100 },
    { scopeType: 'global', windowSeconds: hour, limit: 200 },
    { scopeType: 'global', windowSeconds: day, limit: 2_000 },
  ],
  ai_receipt_ocr: [
    { scopeType: 'subject', windowSeconds: tenMinutes, limit: 5 },
    { scopeType: 'subject', windowSeconds: day, limit: 25 },
    { scopeType: 'global', windowSeconds: hour, limit: 200 },
    { scopeType: 'global', windowSeconds: day, limit: 1_000 },
  ],
  ai_voice_transcription: [
    { scopeType: 'subject', windowSeconds: tenMinutes, limit: 10 },
    { scopeType: 'subject', windowSeconds: day, limit: 50 },
    { scopeType: 'global', windowSeconds: hour, limit: 400 },
    { scopeType: 'global', windowSeconds: day, limit: 2_000 },
  ],
  ai_report_commentary: [
    { scopeType: 'subject', windowSeconds: day, limit: 20 },
    { scopeType: 'global', windowSeconds: day, limit: 3_000 },
  ],
};

function scopeHash(scopeType: RateLimitPolicy['scopeType'], rawKey: string): string {
  return createHash('sha256').update(`ofa-cost-protection:${scopeType}:${rawKey}`).digest('hex');
}

export function buildRateLimitPolicies(operation: CostOperation, subjectKey: string): RateLimitPolicy[] {
  if (!subjectKey.trim()) throw new Error('Cost protection subject is required');
  return costProtectionLimits[operation]
    .map((policy) => ({
      ...policy,
      scopeKeyHash: scopeHash(policy.scopeType, policy.scopeType === 'global' ? 'all' : subjectKey),
    }))
    .sort((left, right) => left.scopeType.localeCompare(right.scopeType)
      || left.scopeKeyHash.localeCompare(right.scopeKeyHash)
      || left.windowSeconds - right.windowSeconds);
}

async function consumeWithSupabase(
  operation: CostOperation,
  cost: number,
  limits: RateLimitPolicy[],
): Promise<ConsumeResult> {
  const { data, error } = await supabase.rpc('consume_cost_rate_limits', {
    p_operation: operation,
    p_cost: cost,
    p_limits: limits,
  });
  if (error) throw new Error(`Cost protection check failed: ${error.message}`);
  const row = (data as ConsumeResult[] | null)?.[0];
  if (!row) throw new Error('Cost protection check returned no result');
  return row;
}

export class CostLimitExceededError extends Error {
  readonly operation: CostOperation;
  readonly retryAfterSeconds: number;

  constructor(operation: CostOperation, retryAfterSeconds: number) {
    super('Request rate limit exceeded');
    this.name = 'CostLimitExceededError';
    this.operation = operation;
    this.retryAfterSeconds = Math.max(1, retryAfterSeconds);
  }
}

export function createCostProtector(consume: ConsumeLimits = consumeWithSupabase) {
  return async (operation: CostOperation, subjectKey: string, cost = 1): Promise<void> => {
    if (!Number.isSafeInteger(cost) || cost < 1) throw new Error('Cost protection cost must be a positive integer');
    const result = await consume(operation, cost, buildRateLimitPolicies(operation, subjectKey));
    if (!result.allowed) throw new CostLimitExceededError(operation, result.retry_after_seconds);
  };
}

export const enforceCostProtection = createCostProtector();

export function telegramUserHash(telegramUserId: string): string {
  return scopeHash('subject', `telegram:${telegramUserId}`);
}

export async function claimTelegramUpdate(updateId: number, telegramUserId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('claim_telegram_update', {
    p_update_id: updateId,
    p_telegram_user_hash: telegramUserHash(telegramUserId),
  });
  if (error) throw new Error(`Telegram update claim failed: ${error.message}`);
  return data === true;
}
