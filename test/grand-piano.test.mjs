import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  MAX_DURATION_SECONDS,
  MAX_NOTE_HZ,
  MIN_NOTE_HZ,
  SAMPLE_RATE,
  synthesizeGrandPiano,
} from '../src/grand-piano.js';
import {
  attackMetrics,
  bandPower,
  centsDifference,
  estimateFundamental,
  onsetRmsTrajectory,
  partialPeaks,
  signalStats,
  spectralCentroid,
  spectralPeakCluster,
  spectrum,
} from '../tools/audio-analysis.mjs';

test('public API returns mono Float32 PCM at exactly 44,100 Hz', () => {
  const durations = [0, 1 / SAMPLE_RATE, 0.01, 0.12345, 1];
  assert.equal(SAMPLE_RATE, 44_100);
  for (const duration of durations) {
    const pcm = synthesizeGrandPiano(440, 0.6, duration);
    assert.ok(pcm instanceof Float32Array);
    assert.equal(pcm.length, Math.round(duration * SAMPLE_RATE));
  }
});

test('finite-number validation and documented clamping policy are exact', () => {
  assert.throws(() => synthesizeGrandPiano(Number.NaN, 0.5, 1), TypeError);
  assert.throws(() => synthesizeGrandPiano(440, Number.POSITIVE_INFINITY, 1), TypeError);
  assert.throws(() => synthesizeGrandPiano(440, 0.5, undefined), TypeError);
  assert.throws(() => synthesizeGrandPiano('440', 0.5, 1), TypeError);

  assert.deepEqual(
    synthesizeGrandPiano(-1, 0.7, 0.025),
    synthesizeGrandPiano(MIN_NOTE_HZ, 0.7, 0.025),
  );
  assert.deepEqual(
    synthesizeGrandPiano(99_999, 0.7, 0.025),
    synthesizeGrandPiano(MAX_NOTE_HZ, 0.7, 0.025),
  );
  assert.deepEqual(
    synthesizeGrandPiano(440, 7, 0.025),
    synthesizeGrandPiano(440, 1, 0.025),
  );
  assert.ok(synthesizeGrandPiano(440, -1, 0.025).every((value) => value === 0));
  assert.equal(synthesizeGrandPiano(440, 0.5, -1).length, 0);
  assert.equal(
    synthesizeGrandPiano(440, 0, MAX_DURATION_SECONDS + 10).length,
    MAX_DURATION_SECONDS * SAMPLE_RATE,
  );
});

test('zero velocity is digital silence for short and ordinary durations', () => {
  for (const duration of [0, 1 / SAMPLE_RATE, 0.007, 0.5, 2]) {
    const pcm = synthesizeGrandPiano(261.625565, 0, duration);
    assert.equal(pcm.length, Math.round(duration * SAMPLE_RATE));
    assert.ok(pcm.every((value) => value === 0));
  }
});

test('representative renders are finite, bounded, DC-controlled, and click-faded', () => {
  const cases = [
    [27.5, 0.3, 0.4],
    [110, 1, 1.1],
    [261.625565, 0.55, 0.333],
    [1_760, 0.9, 0.8],
    [4_186.009045, 1, 0.2],
  ];
  for (const [frequency, velocity, duration] of cases) {
    const pcm = synthesizeGrandPiano(frequency, velocity, duration);
    const stats = signalStats(pcm);
    assert.equal(stats.finite, true);
    assert.ok(stats.peak > 0);
    assert.ok(stats.peak <= 0.940_001, `peak=${stats.peak}`);
    assert.ok(Math.abs(stats.dc) < 0.003, `dc=${stats.dc}`);
    assert.equal(stats.first, 0);
    assert.equal(stats.last, 0);

    let firstBoundaryDelta = 0;
    for (let index = 1; index < Math.min(16, pcm.length); index += 1) {
      firstBoundaryDelta = Math.max(firstBoundaryDelta, Math.abs(pcm[index] - pcm[index - 1]));
    }
    assert.ok(firstBoundaryDelta < 0.02, `first-boundary delta=${firstBoundaryDelta}`);
  }
});

test('the complete waveform, including procedural noise, is deterministic', () => {
  const first = synthesizeGrandPiano(329.627557, 0.731, 0.45);
  const second = synthesizeGrandPiano(329.627557, 0.731, 0.45);
  assert.deepEqual(first, second);
});

test('a longer requested duration preserves the pre-release waveform prefix', () => {
  const short = synthesizeGrandPiano(440, 0.731, 0.5);
  const long = synthesizeGrandPiano(440, 0.731, 1.2);
  const prefixSamples = Math.round(0.2 * SAMPLE_RATE);
  assert.deepEqual(short.slice(0, prefixSamples), long.slice(0, prefixSamples));
});

test('fundamental remains accurate across the piano range', () => {
  for (const frequency of [27.5, 110, 261.625565, 440, 1_760, 4_186.009045]) {
    const pcm = synthesizeGrandPiano(frequency, 0.8, 1);
    const estimate = estimateFundamental(pcm, SAMPLE_RATE, frequency);
    const cents = centsDifference(estimate, frequency);
    assert.ok(Math.abs(cents) <= 3, `${frequency} Hz error=${cents} cents`);
  }
});

test('velocity changes both energy and attack-spectrum brightness', () => {
  for (const frequency of [55, 261.625565, 440, 1_760]) {
    const soft = synthesizeGrandPiano(frequency, 0.25, 1);
    const hard = synthesizeGrandPiano(frequency, 0.9, 1);
    assert.ok(signalStats(hard).rms > signalStats(soft).rms * 2);

    const analyze = (pcm) => spectralCentroid(
      spectrum(pcm, SAMPLE_RATE, {
        start: Math.round(0.01 * SAMPLE_RATE),
        length: 8_192,
        fftSize: 32_768,
      }),
      20,
      16_000,
    );
    assert.ok(analyze(hard) > analyze(soft));
  }
});

test('middle C retains a measured bridge-presence plateau', () => {
  const pcm = synthesizeGrandPiano(261.625565, 0.62, 1.65);
  const attack = attackMetrics(pcm, SAMPLE_RATE);
  const spectralData = spectrum(pcm, SAMPLE_RATE, {
    start: Math.round((attack.onsetSeconds + 0.025) * SAMPLE_RATE),
    length: 32_768,
    fftSize: 131_072,
  });
  const total = bandPower(spectralData, 20, 8_000);
  const relativeBandDb = (minimumHz, maximumHz) => 10 * Math.log10(
    bandPower(spectralData, minimumHz, maximumHz) / total,
  );
  const lowPresenceDb = relativeBandDb(800, 1_600);
  const highPresenceDb = relativeBandDb(1_600, 3_200);
  const airDb = relativeBandDb(3_200, 8_000);
  const partials = partialPeaks(spectralData, 261.625565, 7);
  const strongestPartial = Math.max(...partials.map((partial) => partial.power));
  const thirdPartialDb = 10 * Math.log10(partials[2].power / strongestPartial);

  assert.ok(
    lowPresenceDb >= -18 && lowPresenceDb <= -11,
    `800–1600 Hz relative power=${lowPresenceDb} dB`,
  );
  assert.ok(
    highPresenceDb >= -25 && highPresenceDb <= -17,
    `1600–3200 Hz relative power=${highPresenceDb} dB`,
  );
  assert.ok(
    airDb >= -42 && airDb <= -25,
    `3200–8000 Hz relative power=${airDb} dB`,
  );
  assert.ok(
    thirdPartialDb >= -30 && thirdPartialDb <= -15,
    `C4 third partial relative power=${thirdPartialDb} dB`,
  );
});

test('hard A6 exposes unequal unison lines, two-stage loss, and a beat rebound', () => {
  const pcm = synthesizeGrandPiano(1_760, 0.976378, 3.4);
  const attack = attackMetrics(pcm, SAMPLE_RATE);
  assert.ok(attack.peakSeconds >= 0.014 && attack.peakSeconds <= 0.028);

  const cluster = spectralPeakCluster(
    spectrum(pcm, SAMPLE_RATE, {
      start: Math.round((attack.onsetSeconds + 0.08) * SAMPLE_RATE),
      length: Math.round(1.5 * SAMPLE_RATE),
      fftSize: 262_144,
    }),
    1_760,
    { relativeThresholdDb: -14, minimumSeparationHz: 0.65 },
  );
  assert.ok(cluster.peakCount >= 3);
  assert.ok(cluster.spanHz >= 4.5 && cluster.spanHz <= 7);

  const trajectory = onsetRmsTrajectory(pcm, SAMPLE_RATE, attack.onsetSeconds);
  assert.ok(trajectory[2].relativeDb <= -12);
  assert.ok(trajectory[3].relativeDb - trajectory[2].relativeDb >= 2);
  assert.ok(trajectory.at(-1).relativeDb <= -45);
});

test('runtime implementation has no sample-loading or playback path', async () => {
  const source = await readFile(new URL('../src/grand-piano.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from\s+['"]node:/);
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|atob)\s*\(/);
  assert.doesNotMatch(source, /\.(?:wav|mp3|flac|ogg)\b/i);
  assert.doesNotMatch(source, /AudioBufferSourceNode|decodeAudioData|base64/i);
});

test('runtime implementation stays within its compact source budgets', async () => {
  const source = await readFile(new URL('../src/grand-piano.js', import.meta.url));
  assert.ok(source.length <= 32_000, `raw module is ${source.length} bytes`);
  const gzipBytes = gzipSync(source, { level: 9 }).length;
  assert.ok(gzipBytes <= 8_800, `gzip module is ${gzipBytes} bytes`);
});
