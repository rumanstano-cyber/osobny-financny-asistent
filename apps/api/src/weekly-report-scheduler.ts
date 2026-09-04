import cron from 'node-cron';
import type { Bot } from 'grammy';
import { sendWeeklyReports } from './reports.js';

const timeZone = 'Europe/Bratislava';

export function previousClosedWeekReference(now = new Date()): Date {
  // Pick the prior Sunday at local noon. `weeklyReportPeriod` needs only the
  // calendar date, and noon avoids any ambiguity around a DST midnight.
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => Number(values.find((part) => part.type === type)?.value);
  const localDate = new Date(Date.UTC(value('year'), value('month') - 1, value('day')));
  const isoWeekday = localDate.getUTCDay() || 7;
  localDate.setUTCDate(localDate.getUTCDate() - isoWeekday);
  return new Date(Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate(), 12));
}

/**
 * An in-process scheduler cannot run while the host is restarting. On a
 * Monday restart after the intended run, safely catch up the closed week.
 * Existing successful rows are skipped by the partial unique index.
 */
export function shouldCatchUpWeeklyReport(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === 'weekday')?.value;
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  return weekday === 'Mon' && hour >= 8;
}

async function runWeeklyReports(bot: Bot): Promise<void> {
  try {
    const result = await sendWeeklyReports(bot, previousClosedWeekReference());
    console.info('Weekly report scheduler completed', result);
  } catch (error) {
    console.error('Weekly report scheduler failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

export function startWeeklyReportScheduler(bot: Bot): void {
  // The primary run is at 08:00 Bratislava time. The two following runs only
  // reclaim rows explicitly marked "failed"; the DB unique index makes all
  // successfully sent reports no-ops, including after a process restart.
  cron.schedule('0,15,30 8 * * 1', () => runWeeklyReports(bot), {
    timezone: timeZone,
    noOverlap: true,
    name: 'weekly-telegram-financial-report',
  });

  if (shouldCatchUpWeeklyReport()) void runWeeklyReports(bot);
}
