import { randomUUID } from 'node:crypto';
import type { Bot } from 'grammy';
import { supabase } from './supabase.js';

export type TelegramMediaJobPayload = {
  version: 1;
  kind: 'receipt' | 'voice';
  updateId: number;
  messageId: number;
  messageDate: number;
  chatId: number;
  telegramUserId: number;
  displayName: string;
  fileId: string;
};

type ClaimedJob = { id: string; payload: TelegramMediaJobPayload; attempt_count: number; max_attempts: number };

const telegramMediaJobType = 'telegram_media';
let activeWorker: Promise<void> | null = null;
let processJob: ((payload: TelegramMediaJobPayload) => Promise<void>) | null = null;
let workerPoller: NodeJS.Timeout | null = null;

function isPayload(value: unknown): value is TelegramMediaJobPayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<TelegramMediaJobPayload>;
  return candidate.version === 1
    && (candidate.kind === 'receipt' || candidate.kind === 'voice')
    && Number.isInteger(candidate.updateId)
    && Number.isInteger(candidate.messageId)
    && Number.isInteger(candidate.messageDate)
    && Number.isInteger(candidate.chatId)
    && Number.isInteger(candidate.telegramUserId)
    && typeof candidate.displayName === 'string'
    && typeof candidate.fileId === 'string';
}

export async function enqueueTelegramMediaJob(payload: TelegramMediaJobPayload): Promise<boolean> {
  const { error } = await supabase.from('async_jobs').insert({
    job_type: telegramMediaJobType,
    payload,
    deduplication_key: `telegram:update:${payload.updateId}`,
    max_attempts: 5,
  });
  if (!error) return true;
  if (error.code === '23505') return false;
  throw new Error(error.message);
}

async function claim(): Promise<ClaimedJob | null> {
  const { data, error } = await supabase.rpc('claim_async_job', { p_job_type: telegramMediaJobType });
  if (error) throw new Error(error.message);
  const row = (data as ClaimedJob[] | null)?.[0];
  if (!row) return null;
  if (!isPayload(row.payload)) {
    await supabase.from('async_jobs').update({ status: 'failed', completed_at: new Date().toISOString(), last_error_code: 'invalid_payload', last_error: 'Invalid Telegram media job payload' }).eq('id', row.id);
    return null;
  }
  return row;
}

async function complete(jobId: string): Promise<void> {
  const { error } = await supabase.from('async_jobs').update({ status: 'completed', completed_at: new Date().toISOString(), locked_at: null }).eq('id', jobId).eq('status', 'running');
  if (error) throw new Error(error.message);
}

async function retryOrFail(job: ClaimedJob, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
  const exhausted = job.attempt_count >= job.max_attempts;
  const patch = exhausted
    ? { status: 'failed', completed_at: new Date().toISOString(), locked_at: null, last_error_code: 'processing_failed', last_error: message }
    : { status: 'queued', locked_at: null, run_after: new Date(Date.now() + job.attempt_count * 60_000).toISOString(), last_error_code: 'processing_failed', last_error: message };
  const { error: updateError } = await supabase.from('async_jobs').update(patch).eq('id', job.id).eq('status', 'running');
  if (updateError) throw new Error(updateError.message);
}

async function drain(): Promise<void> {
  if (!processJob) return;
  for (;;) {
    const job = await claim();
    if (!job) return;
    try {
      await processJob(job.payload);
      await complete(job.id);
    } catch (error) {
      console.error('Telegram media job failed', { jobId: job.id, attempt: job.attempt_count, error: error instanceof Error ? error.message : String(error) });
      await retryOrFail(job, error);
    }
  }
}

/** Starts one in-process worker; database row locks make multiple API replicas safe. */
export function startTelegramMediaJobWorker(handler: (payload: TelegramMediaJobPayload) => Promise<void>): void {
  processJob = handler;
  void wakeTelegramMediaJobWorker().catch((error: unknown) => {
    console.error('Unable to start Telegram media worker', error);
  });
  // A job that was delayed for retry must be picked up even if no new Telegram
  // update arrives. The queue remains durable in Supabase; this small poller
  // only wakes the claimant and is safe across process restarts/replicas.
  if (!workerPoller) {
    workerPoller = setInterval(() => {
      void wakeTelegramMediaJobWorker().catch((error: unknown) => {
        console.error('Unable to poll Telegram media worker', error);
      });
    }, 30_000);
    workerPoller.unref();
  }
}

export async function wakeTelegramMediaJobWorker(): Promise<void> {
  if (activeWorker) return activeWorker;
  activeWorker = drain().finally(() => { activeWorker = null; });
  return activeWorker;
}

// Keep a stable unique worker marker available for future observability without
// persisting a host identifier in user data.
export const asyncWorkerInstanceId = randomUUID();
