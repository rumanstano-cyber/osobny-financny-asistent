import assert from 'node:assert/strict';
import test from 'node:test';
import { Jimp, JimpMime } from 'jimp';
import { InvalidReceiptImageError, inspectReceiptImage, optimizeReceiptImage } from './receipt-image.js';

function pngHeader(width: number, height: number): Buffer {
  const source = Buffer.alloc(80);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(source);
  source.writeUInt32BE(13, 8);
  source.write('IHDR', 12, 'ascii');
  source.writeUInt32BE(width, 16);
  source.writeUInt32BE(height, 20);
  source.writeUInt32BE(0, source.length - 12);
  source.write('IEND', source.length - 8, 'ascii');
  return source;
}

test('rejects empty, unsupported, truncated and decompression-bomb receipt images', () => {
  for (const source of [Buffer.alloc(0), Buffer.alloc(100), Buffer.from([0xff, 0xd8, ...new Array(100).fill(0)])]) {
    assert.throws(() => inspectReceiptImage(source), InvalidReceiptImageError);
  }
  assert.throws(() => inspectReceiptImage(pngHeader(10_000, 10_000)), /safe pixel limit/u);
});

test('valid receipt image is decoded and bounded to 1600px', async () => {
  const source = await new Jimp({ width: 2000, height: 1000, color: 0xffffffff }).getBuffer(JimpMime.jpeg, { quality: 90 });
  const result = await optimizeReceiptImage(source);
  assert.equal(result.width, 1600);
  assert.equal(result.height, 800);
  assert.ok(result.bytes.length > 0);
});
