import cron from 'node-cron';
import type { Bot } from 'grammy';
import { sendMonthlyReports } from './reports.js';

const timeZone = 'Europe/Bratislava';

function previousMonthReference(now = new Date()): Date {
  const reference = new Date(now);
  // Day 0 is the final day of the preceding month, so the report period is
  // always the complete month that has just ended.
  reference.setDate(0);
  return reference;
}

export function startMonthlyReportScheduler(bot: Bot): void {
  cron.schedule('0 8 1 * *', async () => {
    try {
      const result = await sendMonthlyReports(bot, previousMonthReference());
      console.info('Monthly report scheduler completed', result);
    } catch (error) {
      console.error('Monthly report scheduler failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }, { timezone: timeZone, noOverlap: true, name: 'monthly-financial-email-report' });
}
