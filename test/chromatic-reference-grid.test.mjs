import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildChromaticJobs,
  CHROMATIC_VELOCITY_LAYERS,
  midiToFrequency,
  midiToNote,
  parseSustainRegions,
  resampleChannel,
} from '../tools/compare-reference-grid.mjs';
import { centsDifference, peakNear, spectrum } from '../tools/audio-analysis.mjs';

test('SFZ sustain parsing retains key zones and open-ended hard velocity', () => {
  const regions = parseSustainRegions([
    '<region> sample=audio\\C4v1.wav lokey=59 hikey=61 lovel=1 hivel=26 pitch_keycenter=60',
    '<region> sample=audio\\C4v16.wav lokey=59 hikey=61 lovel=121 pitch_keycenter=60 tune=-7',
  ].join('\n'));
  assert.deepEqual(regions, [
    {
      file: 'C4v1.wav', note: 'C4', layer: 1, midi: 60,
      keyLow: 59, keyHigh: 61, velocityLow: 1, velocityHigh: 26, tuneCents: 0,
    },
    {
      file: 'C4v16.wav', note: 'C4', layer: 16, midi: 60,
      keyLow: 59, keyHigh: 61, velocityLow: 121, velocityHigh: 127, tuneCents: -7,
    },
  ]);
});

test('SFZ sustain parsing accepts the upstream FLAC sample mapping', () => {
  const [region] = parseSustainRegions(
    '<region> lovel=121 hivel=127 sample=A6v16.flac lokey=92 hikey=94 pitch_keycenter=93 tune=-12',
  );
  assert.deepEqual(region, {
    file: 'A6v16.flac', note: 'A6', layer: 16, midi: 93,
    keyLow: 92, keyHigh: 94, velocityLow: 121, velocityHigh: 127, tuneCents: -12,
  });
});

test('chromatic expansion covers all 88 keys at layers 1, 8, and 16', () => {
  const regions = [];
  const tuneByFile = new Map();
  for (let sourceMidi = 21; sourceMidi <= 108; sourceMidi += 3) {
    for (const layer of CHROMATIC_VELOCITY_LAYERS) {
      const note = midiToNote(sourceMidi);
      const file = `${note}v${layer}.wav`;
      regions.push({
        file,
        note,
        layer,
        midi: sourceMidi,
        keyLow: sourceMidi === 21 ? 21 : sourceMidi - 1,
        keyHigh: sourceMidi === 108 ? 108 : sourceMidi + 1,
        velocityLow: layer === 1 ? 1 : layer === 8 ? 57 : 121,
        velocityHigh: layer === 1 ? 26 : layer === 8 ? 64 : 127,
      });
      tuneByFile.set(file, sourceMidi % 5 - 2);
    }
  }

  const jobs = buildChromaticJobs(regions, tuneByFile);
  assert.equal(jobs.length, 88 * 3);
  assert.deepEqual([...new Set(jobs.map(({ region }) => region.midi))],
    Array.from({ length: 88 }, (_, index) => 21 + index));
  assert.deepEqual([...new Set(jobs.map(({ region }) => region.layer))], [1, 8, 16]);
  assert.equal(jobs.filter(({ region }) => region.transpositionSemitones === 0).length, 30 * 3);
  assert.equal(jobs.filter(({ region }) => region.transpositionSemitones !== 0).length, 58 * 3);
  assert.ok(jobs.every(({ region }) => Math.abs(region.transpositionSemitones) <= 1));
});

test('reference resampler preserves identity and applies sampler pitch rate', () => {
  const sampleRate = 44_100;
  const input = Float32Array.from(
    { length: sampleRate },
    (_, index) => Math.sin(2 * Math.PI * 440 * index / sampleRate),
  );
  assert.deepEqual(resampleChannel(input, 1, 2_048), input.slice(0, 2_048));
  assert.deepEqual(resampleChannel(input, 1, 4, 100), input.slice(100, 104));

  const playbackRate = 2 ** (1 / 12);
  const shifted = resampleChannel(input, playbackRate, 24_000);
  const spectralData = spectrum(shifted, sampleRate, {
    start: 1_024,
    length: 16_384,
    fftSize: 65_536,
  });
  const expectedHz = midiToFrequency(70);
  const peak = peakNear(spectralData, expectedHz * 0.98, expectedHz * 1.02);
  assert.ok(Math.abs(centsDifference(peak.frequencyHz, expectedHz)) < 0.1);
  assert.throws(() => resampleChannel(input, 0, 10), RangeError);
  assert.throws(() => resampleChannel(input, 1, -1), RangeError);
  assert.throws(() => resampleChannel(input, 1, 10, -1), RangeError);
});
