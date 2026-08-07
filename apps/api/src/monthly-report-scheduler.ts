import cron from 'node-cron';
import type { Bot } from 'grammy';
import { sendMonthlyReports } from './reports.js';

const timeZone = 'Europe/Bratislava';

function isLastDayOfMonth(date: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return day === new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function startMonthlyReportScheduler(bot: Bot): void {
  cron.schedule('0 20 28-31 * *', async () => {
    if (!isLastDayOfMonth(new Date())) return;
    try {
      const result = await sendMonthlyReports(bot);
      console.info('Monthly report scheduler completed', result);
    } catch (error) {
      console.error('Monthly report scheduler failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }, { timezone: timeZone, noOverlap: true, name: 'monthly-financial-report' });
}
