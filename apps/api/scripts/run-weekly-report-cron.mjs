import { pathToFileURL } from 'node:url';

const timeZone = 'Europe/Bratislava';

export function localScheduleParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return { weekday: value('weekday'), hour: Number(value('hour')), minute: Number(value('minute')) };
}

export function isScheduledRun(now = new Date()) {
  const { weekday, hour, minute } = localScheduleParts(now);
  return weekday === 'Mon' && hour === 8 && minute === 0;
}

export async function main() {
  if (!isScheduledRun()) {
    console.info('Weekly report cron skipped outside Monday 08:00 Europe/Bratislava.', localScheduleParts());
    return;
  }

  const baseUrl = process.env.BASE_URL?.trim().replace(/\/$/, '');
  const secret = process.env.INTERNAL_CRON_SECRET?.trim();
  if (!baseUrl || !secret) throw new Error('BASE_URL and INTERNAL_CRON_SECRET are required for the weekly report cron job.');

  const response = await fetch(`${baseUrl}/internal/reports/weekly/run`, {
    method: 'POST',
    headers: { 'x-internal-cron-secret': secret },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Weekly report endpoint failed with HTTP ${response.status}.`);
  console.info('Weekly report endpoint completed successfully.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Weekly report cron failed.', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
