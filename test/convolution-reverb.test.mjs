import assert from 'node:assert/strict';
import test from 'node:test';
import { applyConvolverReverb } from '../tools/convolution-reverb.mjs';

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
