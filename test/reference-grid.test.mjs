import assert from 'node:assert/strict';
import test from 'node:test';
import { convertSampleRate, estimateFundamental } from '../tools/audio-analysis.mjs';
import { parseSustainRegions } from '../tools/compare-reference-grid.mjs';

test('SFZ parsing retains only directly recorded sustain regions', () => {
  const regions = parseSustainRegions([
    '<region> sample=audio\\C4v1.wav lokey=59 hikey=61 lovel=1 hivel=26 pitch_keycenter=60',
    '<region> sample=audio\\C4v16.wav lokey=59 hikey=61 lovel=121 pitch_keycenter=60',
  ].join('\n'));
  assert.deepEqual(regions, [
    {
      file: 'C4v1.wav', note: 'C4', layer: 1, midi: 60,
      keyLow: 59, keyHigh: 61, velocityLow: 1, velocityHigh: 26,
    },
    {
      file: 'C4v16.wav', note: 'C4', layer: 16, midi: 60,
      keyLow: 59, keyHigh: 61, velocityLow: 121, velocityHigh: 127,
    },
  ]);
});

test('sample-rate conversion preserves physical pitch and duration', () => {
  const sourceRate = 48_000;
  const targetRate = 44_100;
  const source = Float32Array.from(
    { length: sourceRate },
    (_, index) => Math.sin(2 * Math.PI * 440 * index / sourceRate),
  );
  assert.deepEqual(convertSampleRate(source, sourceRate, sourceRate), source);
  const converted = convertSampleRate(source, sourceRate, targetRate);
  assert.equal(converted.length, targetRate);
  const measured = estimateFundamental(converted, targetRate, 440, 0.04);
  assert.ok(Math.abs(1_200 * Math.log2(measured / 440)) < 0.5, `${measured} Hz`);
  assert.throws(() => convertSampleRate(source, 0, targetRate), RangeError);
  assert.throws(() => convertSampleRate(source, sourceRate, targetRate, targetRate + 1), RangeError);
});
