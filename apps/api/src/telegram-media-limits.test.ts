import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_RECEIPT_IMAGE_BYTES,
  MAX_VOICE_BYTES,
  MAX_VOICE_DURATION_SECONDS,
  receiptImageIsWithinLimits,
  voiceIsWithinLimits,
} from './telegram-media-limits.js';

test('receipt image size boundary is enforced', () => {
  assert.equal(receiptImageIsWithinLimits(undefined), true);
  assert.equal(receiptImageIsWithinLimits(MAX_RECEIPT_IMAGE_BYTES), true);
  assert.equal(receiptImageIsWithinLimits(MAX_RECEIPT_IMAGE_BYTES + 1), false);
  assert.equal(receiptImageIsWithinLimits(-1), false);
});

test('voice size and duration boundaries are enforced', () => {
  assert.equal(voiceIsWithinLimits(undefined, undefined), true);
  assert.equal(voiceIsWithinLimits(MAX_VOICE_BYTES, MAX_VOICE_DURATION_SECONDS), true);
  assert.equal(voiceIsWithinLimits(MAX_VOICE_BYTES + 1, MAX_VOICE_DURATION_SECONDS), false);
  assert.equal(voiceIsWithinLimits(MAX_VOICE_BYTES, MAX_VOICE_DURATION_SECONDS + 1), false);
});
