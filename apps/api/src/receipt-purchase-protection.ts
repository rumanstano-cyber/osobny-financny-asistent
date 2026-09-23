import type { Bot } from 'grammy';
import cron from 'node-cron';
import { receiptPurchaseProtectionReminderText } from './receipt-purchase-protection-controls.js';
import { deliverReceiptReminder } from './receipt-purchase-protection-delivery.js';
import { supabase } from './supabase.js';
import { AccessRevokedError, assertTelegramPrincipalAccess } from './access-control.js';
import { redactSensitiveLogText, safeErrorLog } from './safe-log.js';
import { reconcileReceiptStorageOrphans } from './receipt-storage-orphan-cleanup.js';
import { processDueAccountErasures } from './privacy-erasure.js';

export type ReceiptPurchaseProtectionDecision = {
  archive_status: 'decision_pending' | 'archived' | 'pending_deletion' | 'cleanup_claimed' | 'storage_deleted';
  protection_status: 'active' | 'cancelled' | null;
  protection_ends_on: string | null;
  was_changed: boolean;
};

export type ReceiptPurchaseProtectionDurationUpdate = {
  protection_id: string;
  warranty_duration_months: number;
  protection_ends_on: string;
  was_changed: boolean;
};

export const RECEIPT_IMAGE_RETENTION_HOURS = 7 * 24;

type StorageDeletionClaim = { receipt_id: string; storage_key: string };
type ReminderClaim = { reminder_id: string; telegram_user_id: string; milestone_days: 60 | 30 | 7 };
type ReminderDeliveryDetails = { merchant_name: string | null; receipt_date: string | null; storage_key: string | null };

export async function decideReceiptPurchaseProtection(
  telegramUserId: string,
  receiptId: string,
  keepReceipt: boolean,
): Promise<ReceiptPurchaseProtectionDecision | null> {
  await assertTelegramPrincipalAccess(telegramUserId);
  const { data, error } = await supabase.rpc('decide_telegram_receipt_purchase_protection', {
    p_telegram_user_id: telegramUserId,
    p_receipt_id: receiptId,
    p_keep_receipt: keepReceipt,
    p_retention_hours: RECEIPT_IMAGE_RETENTION_HOURS,
  });
  if (error) throw new Error(error.message);
  return (data as ReceiptPurchaseProtectionDecision[] | null)?.[0] ?? null;
}

export async function updateReceiptPurchaseProtectionDuration(
  telegramUserId: string,
  warrantyDurationMonths: number,
): Promise<ReceiptPurchaseProtectionDurationUpdate | null> {
  await assertTelegramPrincipalAccess(telegramUserId);
  const { data, error } = await supabase.rpc('update_telegram_receipt_purchase_protection_duration', {
    p_telegram_user_id: telegramUserId,
    p_warranty_duration_months: warrantyDurationMonths,
  });
  if (error) throw new Error(error.message);
  return (data as ReceiptPurchaseProtectionDurationUpdate[] | null)?.[0] ?? null;
}

async function cleanUpExpiredReceiptStorage(): Promise<number> {
  const [ordinary, warranty] = await Promise.all([
    supabase.rpc('claim_receipt_storage_deletions', { p_limit: 25 }),
    supabase.rpc('claim_expired_warranty_receipt_deletions', { p_limit: 25 }),
  ]);
  if (ordinary.error) throw new Error(ordinary.error.message);
  if (warranty.error) throw new Error(warranty.error.message);

  let completed = 0;
  const claims = [
    ...((ordinary.data as StorageDeletionClaim[] | null) ?? []),
    ...((warranty.data as StorageDeletionClaim[] | null) ?? []),
  ];
  for (const claim of claims) {
    const { error: storageError } = await supabase.storage.from('ofa-receipts').remove([claim.storage_key]);
    const { error: completionError } = await supabase.rpc('complete_receipt_storage_deletion', {
      p_receipt_id: claim.receipt_id,
      p_succeeded: !storageError,
      p_error: storageError?.message ?? null,
    });
    if (completionError) throw new Error(completionError.message);
    if (storageError) {
      console.error('Receipt storage cleanup failed', { receiptId: claim.receipt_id, error: safeErrorLog(storageError) });
      continue;
    }
    completed += 1;
  }
  return completed;
}

async function cleanUpExpiredPrivacyMetadata(): Promise<{ purgedReceipts: number }> {
  const { data: purgedReceipts, error: receiptError } = await supabase.rpc('purge_expired_receipt_extraction', { p_limit: 25 });
  if (receiptError) throw new Error(receiptError.message);
  const { error: metadataError } = await supabase.rpc('cleanup_privacy_metadata', { p_limit: 100 });
  if (metadataError) throw new Error(metadataError.message);
  return { purgedReceipts: Number(purgedReceipts ?? 0) };
}

async function cancelReminderAfterAccessRevocation(reminderId: string): Promise<void> {
  const { data: cancelledReminder, error: cancelError } = await supabase
    .from('receipt_purchase_protection_reminders')
    .update({
      status: 'cancelled',
      claimed_at: null,
      last_error: 'Recipient access revoked before delivery',
    })
    .eq('id', reminderId)
    .eq('status', 'sending')
    .select('workspace_id')
    .maybeSingle();
  if (cancelError) throw new Error(cancelError.message);
  if (cancelledReminder) {
    const { error: auditError } = await supabase.from('audit_events').insert({
      workspace_id: cancelledReminder.workspace_id,
      actor_type: 'system',
      action: 'receipt.purchase_protection_reminder_cancelled_access_revoked',
      entity_type: 'receipt_purchase_protection_reminder',
      entity_id: reminderId,
    });
    if (auditError) console.error('Revoked reminder audit event failed', { reminderId, error: safeErrorLog(auditError) });
  }
  console.info('Receipt purchase protection reminder cancelled after access revocation', { reminderId });
}

async function sendDueReceiptPurchaseProtectionReminders(bot: Bot): Promise<number> {
  const { data, error } = await supabase.rpc('claim_due_receipt_purchase_protection_reminders', { p_limit: 100 });
  if (error) throw new Error(error.message);

  let delivered = 0;
  for (const claim of (data as ReminderClaim[] | null) ?? []) {
    try {
      try {
        await assertTelegramPrincipalAccess(claim.telegram_user_id);
      } catch (accessError) {
        if (!(accessError instanceof AccessRevokedError)) throw accessError;
        await cancelReminderAfterAccessRevocation(claim.reminder_id);
        continue;
      }

      let details: ReminderDeliveryDetails | null = null;
      try {
        const { data: reminderDetails, error: detailsError } = await supabase.rpc('get_receipt_purchase_protection_reminder_delivery', {
          p_reminder_id: claim.reminder_id,
        });
        if (detailsError) throw new Error(detailsError.message);
        details = (reminderDetails as ReminderDeliveryDetails[] | null)?.[0] ?? null;
      } catch (detailsError) {
        console.error('Receipt purchase protection reminder details failed', {
          reminderId: claim.reminder_id,
          error: safeErrorLog(detailsError),
        });
      }

      let signedReceiptUrl: string | null = null;
      if (details?.storage_key) {
        try {
          await assertTelegramPrincipalAccess(claim.telegram_user_id);
          const { data: signedUrl, error: signedUrlError } = await supabase.storage.from('ofa-receipts').createSignedUrl(details.storage_key, 10 * 60);
          if (signedUrlError || !signedUrl?.signedUrl) throw new Error(signedUrlError?.message ?? 'Signed URL for receipt was not created');
          signedReceiptUrl = signedUrl.signedUrl;
        } catch (imagePreparationError) {
          if (imagePreparationError instanceof AccessRevokedError) throw imagePreparationError;
          console.error('Receipt purchase protection reminder image preparation failed', {
            reminderId: claim.reminder_id,
            error: safeErrorLog(imagePreparationError),
          });
        }
      }

      await assertTelegramPrincipalAccess(claim.telegram_user_id);
      const delivery = await deliverReceiptReminder(
        bot.api,
        claim.telegram_user_id,
        receiptPurchaseProtectionReminderText(claim.milestone_days, details?.merchant_name, details?.receipt_date),
        signedReceiptUrl,
      );
      if (delivery.receiptImageError) {
        console.error('Receipt purchase protection reminder image delivery failed', {
          reminderId: claim.reminder_id,
          error: redactSensitiveLogText(delivery.receiptImageError),
        });
      }
      const { error: completionError } = await supabase.rpc('complete_receipt_purchase_protection_reminder', {
        p_reminder_id: claim.reminder_id,
        p_succeeded: true,
        p_provider_message_id: delivery.providerMessageId,
        p_error: null,
      });
      if (completionError) throw new Error(completionError.message);
      delivered += 1;
    } catch (reminderError) {
      if (reminderError instanceof AccessRevokedError) {
        await cancelReminderAfterAccessRevocation(claim.reminder_id);
        continue;
      }
      const message = reminderError instanceof Error ? reminderError.message : String(reminderError);
      console.error('Receipt purchase protection reminder failed', { reminderId: claim.reminder_id, error: safeErrorLog(reminderError) });
      const { error: completionError } = await supabase.rpc('complete_receipt_purchase_protection_reminder', {
        p_reminder_id: claim.reminder_id,
        p_succeeded: false,
        p_provider_message_id: null,
        p_error: message,
      });
      if (completionError) throw new Error(completionError.message);
    }
  }
  return delivered;
}

export async function runReceiptPurchaseProtectionMaintenance(bot: Bot): Promise<{ deletedReceipts: number; deletedOrphans: number; purgedReceiptMetadata: number; sentReminders: number; erasedAccounts: number }> {
  const [deletedReceipts, orphanCleanup, sentReminders] = await Promise.all([
    cleanUpExpiredReceiptStorage(),
    reconcileReceiptStorageOrphans(),
    sendDueReceiptPurchaseProtectionReminders(bot),
  ]);
  const privacyCleanup = await cleanUpExpiredPrivacyMetadata();
  const erasures = await processDueAccountErasures();
  return { deletedReceipts, deletedOrphans: orphanCleanup.deleted, purgedReceiptMetadata: privacyCleanup.purgedReceipts, sentReminders, erasedAccounts: erasures.completed };
}

let schedulerStarted = false;

export function startReceiptPurchaseProtectionScheduler(bot: Bot): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  cron.schedule('7 * * * *', () => {
    void runReceiptPurchaseProtectionMaintenance(bot).catch((error: unknown) => {
      console.error('Receipt purchase protection maintenance failed', { error: safeErrorLog(error) });
    });
  }, { timezone: 'Europe/Bratislava', noOverlap: true, name: 'receipt-purchase-protection-maintenance' });
}
