import assert from 'node:assert/strict';
import test from 'node:test';
import { Jimp } from 'jimp';
import { renderMonthlyChart } from './report-chart.js';
import { reportEmailPayload, type MonthlyReport } from './reports.js';

const report: MonthlyReport = {
  periodStart: new Date('2026-09-01T00:00:00Z'),
  periodEnd: new Date('2026-10-01T00:00:00Z'),
  monthLabel: 'september 2026',
  currencyCode: 'EUR',
  incomeMinor: 150_000,
  expenseMinor: 15_000,
  balanceMinor: 135_000,
  categories: [
    { name: 'Potraviny', slug: 'potraviny', amountMinor: 10_000 },
    { name: 'Reštaurácie', slug: 'restauracie', amountMinor: 5_000 },
  ],
};

test('monthly chart is a local PNG with distinct category slices and no network request', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Chart rendering must not call an external service'); };
  try {
    const png = await renderMonthlyChart(report);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const image = await Jimp.read(png);
    assert.equal(image.width, 1000);
    assert.equal(image.height, 600);
    assert.equal(image.getPixelColor(275, 200), 0x2563ebff);
    assert.equal(image.getPixelColor(100, 320), 0x16a34aff);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('monthly email embeds the local image via CID, without any external chart URL', async () => {
  const png = await renderMonthlyChart(report);
  const payload = reportEmailPayload(report, 'Stručný komentár.', png, 'recipient@example.invalid', 'sender@example.invalid');
  assert.match(payload.html, /src="cid:ofa-monthly-chart"/);
  assert.doesNotMatch(JSON.stringify(payload), /quickchart\.io|https?:\/\/[^" ]*chart/u);
  assert.equal(payload.attachments[0]?.content_id, 'ofa-monthly-chart');
  assert.deepEqual(Buffer.from(payload.attachments[0]!.content, 'base64'), png);
  assert.match(payload.html, /Potraviny/u);
  assert.match(payload.html, /Reštaurácie/u);
});

test('email category names are escaped and an empty month still renders a local chart', async () => {
  const emptyReport = { ...report, categories: [], expenseMinor: 0 };
  const png = await renderMonthlyChart(emptyReport);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const unsafeReport = { ...report, categories: [{ name: '<script>', slug: 'x', amountMinor: 15_000 }] };
  const payload = reportEmailPayload(unsafeReport, '', png, 'recipient@example.invalid', 'sender@example.invalid');
  assert.match(payload.html, /&lt;script&gt;/u);
  assert.doesNotMatch(payload.html, /<script>/u);
});
