import assert from 'node:assert/strict';
import test from 'node:test';
import { applyConvolverReverb, applyStereoLoudnessCeiling } from '../tools/convolution-reverb.mjs';
import { DEFAULT_REVERB_WET } from '../src/reverb.js';

test('offline convolution uses the same default send as the browser helper', () => {
  const left = new Float32Array([1, 0, 0, 0]), right = left.slice();
  applyConvolverReverb(left, right, new Float32Array([1]), new Float32Array([1]), { normalize: false, master: false, blockSize: 2 });
  assert.ok(Math.abs(left[0] - (1 + DEFAULT_REVERB_WET)) < 1e-6);
  assert.deepEqual(left, right);
});

test('partitioned offline convolution matches direct stereo convolution', () => {
  const left = new Float32Array([1, 2, 0, 0, 0, 0, 0, 0]);
  const right = new Float32Array([2, 1, 0, 0, 0, 0, 0, 0]);
  const impulseLeft = new Float32Array([1, 0.5]);
  const impulseRight = new Float32Array([0.5, 0.25]);
  const result = applyConvolverReverb(left, right, impulseLeft, impulseRight, { wet: 1, normalize: false, master: false, blockSize: 4 });
  const expectedLeft = [2, 4.5, 1, 0, 0, 0, 0, 0];
  const expectedRight = [3, 2, 0.25, 0, 0, 0, 0, 0];
  for (let index = 0; index < left.length; index += 1) { assert.ok(Math.abs(left[index] - expectedLeft[index]) < 1e-6); assert.ok(Math.abs(right[index] - expectedRight[index]) < 1e-6); }
  assert.equal(result.normalizationScale, 1);
  assert.equal(result.masteringGain, 1);
});

test('stereo loudness ceiling leaves quiet audio intact and controls dense energy', () => {
  const sampleRate = 2_000, frames = 8 * sampleRate, left = new Float32Array(frames), right = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) { const amplitude = index < 4 * sampleRate ? .01 : .12, sample = amplitude * Math.sin(2 * Math.PI * 100 * index / sampleRate); left[index] = sample; right[index] = .5 * sample; }
  const quietBefore = left.slice(2 * sampleRate, 3 * sampleRate), result = applyStereoLoudnessCeiling(left, right, { ceilingDb: -26, sampleRate });
  assert.deepEqual(left.slice(2 * sampleRate, 3 * sampleRate), quietBefore);
  let loudPower = 0; for (let index = 6 * sampleRate; index < 7 * sampleRate; index += 1) loudPower += .5 * (left[index] ** 2 + right[index] ** 2);
  assert.ok(10 * Math.log10(loudPower / sampleRate) <= -25.5);
  assert.ok(result.maximumReductionDb > 2);
  for (let index = 0; index < frames; index += 1) if (left[index] !== 0) assert.ok(Math.abs(right[index] / left[index] - .5) < 1e-6);
});
