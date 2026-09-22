import { Jimp, JimpMime, loadFont } from 'jimp';
import { SANS_16_WHITE, SANS_32_WHITE } from '@jimp/plugin-print/fonts';
import type { MonthlyReport } from './reports.js';

const WIDTH = 1000;
const HEIGHT = 600;
const COLORS = [0x2563ebff, 0x16a34aff, 0xf59e0bff, 0xdc2626ff, 0x7c3aedff, 0x0891b2ff, 0xdb2777ff, 0x65a30dff];
let fonts: Promise<[Awaited<ReturnType<typeof loadFont>>, Awaited<ReturnType<typeof loadFont>>]> | null = null;

function chartLabel(value: string): string {
  // The bundled bitmap font lacks some Slovak glyphs. The exact category names
  // remain in the Telegram caption and HTML table; this is only the image label.
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '').slice(0, 28);
}

/** Render a report entirely in-process; category names and amounts never enter a chart URL. */
export async function renderMonthlyChart(report: MonthlyReport): Promise<Buffer> {
  fonts ??= Promise.all([loadFont(SANS_16_WHITE), loadFont(SANS_32_WHITE)]);
  const [smallFont, titleFont] = await fonts;
  const image = new Jimp({ width: WIDTH, height: HEIGHT, color: 0x121212ff });
  const categories = report.categories.slice(0, COLORS.length).filter((item) => item.amountMinor > 0);
  const total = categories.reduce((sum, item) => sum + item.amountMinor, 0);
  const cumulative: number[] = [];
  let running = 0;
  for (const item of categories) {
    running += item.amountMinor / total;
    cumulative.push(running);
  }

  const cx = 275;
  const cy = 320;
  const radius = 215;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > radius * radius) continue;
      if (total === 0) {
        image.setPixelColor(0x374151ff, x, y);
        continue;
      }
      const fraction = ((Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2);
      const index = cumulative.findIndex((end) => fraction < end);
      const boundary = cumulative.some((end) => Math.abs(fraction - end) * 2 * Math.PI * Math.sqrt(dx * dx + dy * dy) < 2);
      image.setPixelColor(boundary ? 0xffffffff : COLORS[Math.max(index, 0)]!, x, y);
    }
  }

  image.print({ font: titleFont, x: 34, y: 25, text: `Vydavky podla kategorii - ${chartLabel(report.monthLabel)}` });
  if (total === 0) image.print({ font: smallFont, x: 218, y: 310, text: 'Bez vydavkov' });

  const formatAmount = new Intl.NumberFormat('sk-SK', { style: 'currency', currency: report.currencyCode });
  for (const [index, item] of categories.entries()) {
    const y = 112 + index * 55;
    for (let sy = y; sy < y + 20; sy++) {
      for (let sx = 565; sx < 585; sx++) image.setPixelColor(COLORS[index]!, sx, sy);
    }
    const percentage = Math.round((item.amountMinor / total) * 100);
    image.print({ font: smallFont, x: 600, y: y - 1, text: `${chartLabel(item.name)} (${percentage} %)` });
    image.print({ font: smallFont, x: 600, y: y + 20, text: formatAmount.format(item.amountMinor / 100) });
  }
  return image.getBuffer(JimpMime.png);
}
