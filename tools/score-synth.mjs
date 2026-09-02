#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_DURATION_SECONDS,
  SAMPLE_RATE,
  synthesizeGrandPiano,
} from '../src/grand-piano.js';
import {
  attackMetrics,
  bandPower,
  centsDifference,
  estimateFundamental,
  estimateInharmonicity,
  onsetRmsTrajectory,
  partialPeaks,
  rmsBetween,
  signalStats,
  spectralCentroid,
  spectralPeakCluster,
  spectrum,
  transientFrameMetrics,
} from './audio-analysis.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(root, 'reports', 'validation-report.json');
const referenceReportPath = path.join(root, 'reports', 'reference-analysis.json');
const shouldWrite = process.argv.includes('--write-report');
const PASS_THRESHOLD = 90;

const NOTES = [
  ['A0', 27.5],
  ['A1', 55],
  ['A2', 110],
  ['C4', 261.625565],
  ['A4', 440],
  ['A5', 880],
  ['A6', 1_760],
  ['C8', 4_186.009045],
];
const SOFT_VELOCITY = 0.315;
const HARD_VELOCITY = 0.97;
const FALLBACK_A6_TARGET = {
  normalizedVelocityMidpoint: 0.976378,
  causalAttack: { onsetToPeakSeconds: 0.021202, peakEnvelope: 0.292775 },
  frameRmsRelativeDb: [-6.814, -3.137, 0, -0.312, -5.789],
  frameCrestFactors: [2.612, 2.171, 1.885, 1.87, 2.294],
  frameCentroidsHz: [2_379.14, 1_837.94, 1_787.69, 1_768.19, 1_770.9],
  frameBandsDb: [
    [-12.319, -7.724, -4.693, -7.695, -20.137, -34.641],
    [-15.304, -3.976, -12.634, -11.343, -26.996, -45.194],
    [-20.408, -0.696, -31.832, -17.389, -30.96, -54.116],
    [-21.07, -0.112, -34.344, -22.914, -36.397, -54.477],
    [-23.151, -0.041, -36.979, -27.105, -34.04, -51.202],
  ],
  trajectoryDb: [0, -6.541, -18.22, -12.504, -22.924, -19.768, -27.372,
    -38.636, -46.831, -49.512, -55.943],
  unisonSpanHz: 5.7295,
};
const A6_BAND_NAMES = [
  'lowBody',
  'fundamental',
  'woodAndString',
  'secondPartial',
  'presence',
  'air',
];

function round(value, digits = 5) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function decibels(ratio) {
  return 20 * Math.log10(Math.max(ratio, Number.MIN_VALUE));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
}

function maximumBoundaryDelta(samples, start, end) {
  let maximum = 0;
  const lower = Math.max(1, start);
  const upper = Math.min(samples.length, end);
  for (let index = lower; index < upper; index += 1) {
    maximum = Math.max(maximum, Math.abs(samples[index] - samples[index - 1]));
  }
  return maximum;
}

function analyzeNote(name, frequency, velocity, duration = 2.2) {
  const samples = synthesizeGrandPiano(frequency, velocity, duration);
  const stats = signalStats(samples);
  const attack = attackMetrics(samples, SAMPLE_RATE);
  const spectralData = spectrum(samples, SAMPLE_RATE, {
    start: Math.round(0.03 * SAMPLE_RATE),
    length: Math.min(32_768, samples.length - Math.round(0.03 * SAMPLE_RATE)),
    fftSize: 131_072,
  });
  const fundamentalHz = estimateFundamental(samples, SAMPLE_RATE, frequency);
  const peaks = partialPeaks(spectralData, fundamentalHz, 12);
  // Fit stiffness after the short impact-board modes have died away. The
  // 30 ms spectrum is intentionally retained for timbre/brightness metrics,
  // but those broadband collision modes can win a narrow partial search and
  // make the fitted dispersion trend meaningless around middle C.
  const inharmonicitySpectrum = spectrum(samples, SAMPLE_RATE, {
    start: Math.round(0.12 * SAMPLE_RATE),
    length: Math.min(32_768, samples.length - Math.round(0.12 * SAMPLE_RATE)),
    fftSize: 131_072,
  });
  const inharmonicityPeaks = partialPeaks(
    inharmonicitySpectrum,
    fundamentalHz,
    12,
  );
  const strongest = Math.max(...peaks.map((peak) => peak.power));
  const earlyRms = rmsBetween(samples, 0.08 * SAMPLE_RATE, 0.28 * SAMPLE_RATE);
  const lateRms = rmsBetween(samples, 1.25 * SAMPLE_RATE, 1.65 * SAMPLE_RATE);

  return {
    name,
    frequency,
    velocity,
    duration,
    samples,
    stats,
    attack,
    spectralData,
    fundamentalHz,
    pitchErrorCents: centsDifference(fundamentalHz, frequency),
    centroidHz: spectralCentroid(spectralData, 20, 16_000),
    inharmonicityB: estimateInharmonicity(inharmonicityPeaks),
    partials: peaks.map((peak) => ({
      number: peak.partial,
      frequencyHz: peak.frequencyHz,
      relativeDb: 10 * Math.log10(peak.power / strongest),
    })),
    earlyRms,
    lateRms,
    totalDecayDb: decibels(lateRms / earlyRms),
    // Only the fade-in boundary is a click test; later high-frequency slope is
    // legitimate signal, especially in the top octave.
    startBoundaryDelta: maximumBoundaryDelta(samples, 1, Math.min(16, samples.length)),
    endBoundaryDelta: maximumBoundaryDelta(
      samples,
      Math.max(1, samples.length - 384),
      samples.length,
    ),
  };
}

function partialBandChange(samples, frequency, partial) {
  const makeSpectrum = (seconds) => spectrum(samples, SAMPLE_RATE, {
    start: Math.round(seconds * SAMPLE_RATE),
    length: 8_192,
    fftSize: 16_384,
  });
  const early = makeSpectrum(0.12);
  const late = makeSpectrum(1.25);
  const nominal = frequency * partial;
  const low = nominal * 0.975;
  const high = nominal * (1.025 + Math.min(0.08, partial * partial * 0.0006));
  return 10 * Math.log10(
    Math.max(bandPower(late, low, high), Number.MIN_VALUE) /
      Math.max(bandPower(early, low, high), Number.MIN_VALUE),
  );
}

function serializeNote(analysis) {
  return {
    note: analysis.name,
    frequencyHz: round(analysis.frequency, 5),
    velocity: analysis.velocity,
    durationSeconds: analysis.duration,
    sampleCount: analysis.stats.sampleCount,
    peak: round(analysis.stats.peak),
    rms: round(analysis.stats.rms),
    dc: round(analysis.stats.dc, 7),
    attackToPeakMs: round(analysis.attack.peakSeconds * 1_000, 2),
    fundamentalEstimateHz: round(analysis.fundamentalHz, 5),
    pitchErrorCents: round(analysis.pitchErrorCents, 3),
    centroidHz: round(analysis.centroidHz, 2),
    centroidToFundamental: round(analysis.centroidHz / analysis.frequency, 3),
    inharmonicityB: round(analysis.inharmonicityB, 8),
    totalDecayDb_0_18s_to_1_45s: round(analysis.totalDecayDb, 2),
    startBoundaryDelta: round(analysis.startBoundaryDelta, 6),
    endBoundaryDelta: round(analysis.endBoundaryDelta, 6),
    partials: analysis.partials.map((partial) => ({
      number: partial.number,
      frequencyHz: round(partial.frequencyHz, 3),
      relativeDb: round(partial.relativeDb, 2),
    })),
  };
}

async function loadReferenceTargets() {
  try {
    const report = JSON.parse(await readFile(referenceReportPath, 'utf8'));
    return report.derivedTargets;
  } catch {
    return null;
  }
}

function focusedTarget(referenceTargets) {
  const target = referenceTargets?.focusA6v16;
  if (!target) return FALLBACK_A6_TARGET;
  return {
    normalizedVelocityMidpoint: target.normalizedVelocityMidpoint,
    causalAttack: target.causalAttack,
    frameRmsRelativeDb: target.transientFrames.map(
      (frame) => frame.rmsRelativeToStrongestFrameDb,
    ),
    frameCrestFactors: target.transientFrames.map((frame) => frame.crestFactor),
    frameCentroidsHz: target.transientFrames.map((frame) => frame.centroidHz),
    frameBandsDb: target.transientFrames.map((frame) =>
      A6_BAND_NAMES.map((name) => frame.bandRelativeDb[name])),
    trajectoryDb: target.rmsTrajectory.map((point) => point.relativeDb),
    unisonSpanHz: target.unisonCluster.spanHz,
  };
}

function analyzeFocusedA6(target) {
  const velocity = target.normalizedVelocityMidpoint;
  const samples = synthesizeGrandPiano(1_760, velocity, 3.4);
  const attack = attackMetrics(samples, SAMPLE_RATE);
  const frames = transientFrameMetrics(samples, SAMPLE_RATE, attack.onsetSeconds);
  const maximumFrameRms = Math.max(...frames.map((frame) => frame.rms));
  const frameRmsRelativeDb = frames.map((frame) =>
    decibels(frame.rms / maximumFrameRms));
  const trajectory = onsetRmsTrajectory(
    samples,
    SAMPLE_RATE,
    attack.onsetSeconds,
  );
  const clusterStart = Math.round((attack.onsetSeconds + 0.08) * SAMPLE_RATE);
  const clusterLength = Math.min(
    Math.round(1.5 * SAMPLE_RATE),
    samples.length - clusterStart,
  );
  const cluster = spectralPeakCluster(
    spectrum(samples, SAMPLE_RATE, {
      start: clusterStart,
      length: clusterLength,
      fftSize: 262_144,
    }),
    1_760,
    { relativeThresholdDb: -14, minimumSeparationHz: 0.65 },
  );
  const rmsShapeMaeDb = mean(frameRmsRelativeDb.map(
    (value, index) => Math.abs(value - target.frameRmsRelativeDb[index]),
  ));
  const crestMae = mean(frames.map(
    (frame, index) => Math.abs(frame.crestFactor - target.frameCrestFactors[index]),
  ));
  const centroidMeanAbsolutePercent = 100 * mean(frames.map(
    (frame, index) =>
      Math.abs(frame.centroidHz / target.frameCentroidsHz[index] - 1),
  ));
  const bandErrors = frames.flatMap((frame, frameIndex) =>
    A6_BAND_NAMES.map((name, bandIndex) =>
      Math.abs(frame.bandRelativeDb[name] - target.frameBandsDb[frameIndex][bandIndex])));
  const bandMaeDb = mean(bandErrors);
  const trajectoryMaeDb = mean(trajectory.map(
    (point, index) => Math.abs(point.relativeDb - target.trajectoryDb[index]),
  ));
  return {
    velocity,
    samples,
    attack,
    frames,
    frameRmsRelativeDb,
    trajectory,
    cluster,
    rmsShapeMaeDb,
    crestMae,
    centroidMeanAbsolutePercent,
    bandMaeDb,
    maximumBandErrorDb: Math.max(...bandErrors),
    trajectoryMaeDb,
    earlyBeatReboundDb: trajectory[3].relativeDb - trajectory[2].relativeDb,
  };
}

async function main() {
  const referenceTargets = await loadReferenceTargets();
  const a6Target = focusedTarget(referenceTargets);
  const focusedA6 = analyzeFocusedA6(a6Target);
  const soft = new Map();
  const hard = new Map();
  for (const [name, frequency] of NOTES) {
    soft.set(name, analyzeNote(name, frequency, SOFT_VELOCITY));
    hard.set(name, analyzeNote(name, frequency, HARD_VELOCITY));
  }

  const checks = [];
  const addCheck = (category, name, weight, passed, actual, target, proxy) => {
    checks.push({
      category,
      name,
      weight,
      earned: passed ? weight : 0,
      passed,
      actual,
      target,
      proxy,
    });
  };

  const allAnalyses = [...soft.values(), ...hard.values()];
  const countDurations = [0, 1 / SAMPLE_RATE, 0.12345, 0.75];
  const countResults = countDurations.map((duration) => ({
    duration,
    expected: Math.round(duration * SAMPLE_RATE),
    actual: synthesizeGrandPiano(440, 0.5, duration).length,
  }));
  addCheck(
    'signal-contract',
    '44.1 kHz constant and exact rounded sample counts',
    4,
    SAMPLE_RATE === 44_100 && countResults.every((item) => item.actual === item.expected),
    { sampleRate: SAMPLE_RATE, counts: countResults },
    'SAMPLE_RATE=44100; length=round(duration*rate)',
    'Direct API contract, not a perceptual proxy.',
  );
  addCheck(
    'signal-contract',
    'all representative output values are finite',
    4,
    allAnalyses.every((item) => item.stats.finite),
    allAnalyses.map((item) => [item.name, item.velocity, item.stats.finite]),
    'true for low/mid/high and soft/hard renders',
    'Direct numerical-safety criterion.',
  );
  const maximumPeak = Math.max(...allAnalyses.map((item) => item.stats.peak));
  addCheck(
    'signal-contract',
    'fixed transfer remains normalized and bounded',
    4,
    maximumPeak > 0.05 && maximumPeak <= 0.940_001,
    round(maximumPeak, 6),
    '(0.05, 0.940001]',
    'Bounds prevent clipping; peak level alone does not measure realism.',
  );
  const rmsValues = allAnalyses.map((item) => item.stats.rms);
  addCheck(
    'signal-contract',
    'representative RMS is audible without being continuously hot',
    3,
    Math.min(...rmsValues) >= 0.0005 && Math.max(...rmsValues) <= 0.32,
    { minimum: round(Math.min(...rmsValues)), maximum: round(Math.max(...rmsValues)) },
    '[0.0005, 0.32]',
    'A coarse gain/crest-factor guard, not loudness matching.',
  );
  const maximumDc = Math.max(...allAnalyses.map((item) => Math.abs(item.stats.dc)));
  addCheck(
    'signal-contract',
    'absolute DC offset remains small',
    3,
    maximumDc < 0.002,
    round(maximumDc, 7),
    '<0.002',
    'Direct electrical/PCM hygiene criterion.',
  );
  const maximumStartDelta = Math.max(...allAnalyses.map((item) => item.startBoundaryDelta));
  const maximumEndDelta = Math.max(...allAnalyses.map((item) => item.endBoundaryDelta));
  addCheck(
    'signal-contract',
    'zero endpoints and controlled boundary deltas resist clicks',
    2,
    allAnalyses.every((item) => item.stats.first === 0 && item.stats.last === 0) &&
      maximumStartDelta < 0.035 && maximumEndDelta < 0.035,
    {
      endpointsExact: allAnalyses.every((item) => item.stats.first === 0 && item.stats.last === 0),
      maximumStartDelta: round(maximumStartDelta, 6),
      maximumEndDelta: round(maximumEndDelta, 6),
    },
    'endpoints=0 and boundary delta <0.035',
    'Boundary discontinuity is a strong click proxy; it cannot catch every audible artifact.',
  );

  const maximumPitchError = Math.max(
    ...allAnalyses.map((item) => Math.abs(item.pitchErrorCents)),
  );
  addCheck(
    'pitch',
    'fundamental accuracy across A0..C8',
    12,
    maximumPitchError <= 3,
    {
      maximumAbsoluteCents: round(maximumPitchError, 3),
      perNoteHardCents: Object.fromEntries(
        [...hard].map(([name, item]) => [name, round(item.pitchErrorCents, 3)]),
      ),
    },
    '<=3 cents',
    'Windowed spectral peak near f0; unison beating can move the peak slightly.',
  );

  const attackTimes = allAnalyses.map((item) => item.attack.peakSeconds * 1_000);
  addCheck(
    'attack-and-dynamics',
    'onset-to-peak timing is percussive but not impulse-like',
    3,
    Math.min(...attackTimes) >= 3 && Math.max(...attackTimes) <= 65,
    { minimumMs: round(Math.min(...attackTimes), 2), maximumMs: round(Math.max(...attackTimes), 2) },
    '3..65 ms (reference median 22.7 ms)',
    '3 ms RMS attack timing is a proxy for hammer immediacy.',
  );
  const velocityRmsRatios = Object.fromEntries(
    NOTES.map(([name]) => [name, hard.get(name).stats.rms / soft.get(name).stats.rms]),
  );
  addCheck(
    'attack-and-dynamics',
    'hard strikes have substantially greater energy than soft strikes',
    4,
    Object.values(velocityRmsRatios).every((ratio) => ratio >= 2.2 && ratio <= 10),
    Object.fromEntries(
      Object.entries(velocityRmsRatios).map(([name, ratio]) => [name, round(ratio, 3)]),
    ),
    'every hard/soft RMS ratio in [2.2, 10]',
    'RMS is a useful dynamics proxy, but perceived loudness also depends on spectrum.',
  );
  const velocitySweep = [0.18, 0.4, 0.65, 0.9].map((velocity) => ({
    velocity,
    rms: signalStats(synthesizeGrandPiano(261.625565, velocity, 1)).rms,
  }));
  addCheck(
    'attack-and-dynamics',
    'continuous velocity sweep increases monotonically',
    3,
    velocitySweep.every((item, index) => index === 0 || item.rms > velocitySweep[index - 1].rms),
    velocitySweep.map((item) => ({ velocity: item.velocity, rms: round(item.rms) })),
    'strictly increasing RMS at v=.18,.40,.65,.90',
    'Guards against layer-like discontinuities; it does not prove an ideal loudness curve.',
  );
  const brightnessRatios = Object.fromEntries(
    NOTES.map(([name]) => [name, hard.get(name).centroidHz / soft.get(name).centroidHz]),
  );
  addCheck(
    'attack-and-dynamics',
    'harder strikes are spectrally brighter in every register',
    3,
    Object.values(brightnessRatios).every((ratio) => ratio > 1.001),
    Object.fromEntries(
      Object.entries(brightnessRatios).map(([name, ratio]) => [name, round(ratio, 3)]),
    ),
    'every hard/soft centroid ratio >1.001; reference ratios 1.038..1.671',
    'Spectral centroid is a brightness proxy and can be influenced by attack noise.',
  );

  const modalNotes = ['A0', 'A2', 'C4'];
  const audiblePartialCounts = Object.fromEntries(
    modalNotes.map((name) => [
      name,
      hard.get(name).partials.filter((partial) => partial.relativeDb >= -48).length,
    ]),
  );
  addCheck(
    'spectrum',
    'low and middle notes contain multiple resolvable partials',
    4,
    Object.values(audiblePartialCounts).every((count) => count >= 6),
    audiblePartialCounts,
    'at least 6 of first 12 partials above -48 dB for A0, A2, C4',
    'Resolved modal peaks distinguish a piano-like string spectrum from a sine tone.',
  );
  const bValues = Object.fromEntries(
    ['A0', 'A2', 'C4', 'A4', 'A6'].map((name) => [name, hard.get(name).inharmonicityB]),
  );
  addCheck(
    'spectrum',
    'partial locations show plausible positive stiff-string dispersion',
    4,
    Object.values(bValues).every((value) => Number.isFinite(value) && value > 1e-6 && value < 0.015),
    Object.fromEntries(Object.entries(bValues).map(([name, value]) => [name, round(value, 8)])),
    '1e-6 < B < 0.015',
    'A single fitted B summarizes inharmonicity; real strings have local deviations and coupled modes.',
  );
  addCheck(
    'spectrum',
    'treble stiffness exceeds middle-register stiffness',
    3,
    bValues.A6 > bValues.C4 * 5 && bValues.C4 > bValues.A2,
    { A2: round(bValues.A2, 8), C4: round(bValues.C4, 8), A6: round(bValues.A6, 8) },
    'A6 > 5*C4 and C4 > A2',
    'Register trend was measured in the reference; fitted peak ambiguity limits exact matching.',
  );
  const secondPartialDb = hard.get('C4').partials.find((partial) => partial.number === 2)?.relativeDb;
  addCheck(
    'spectrum',
    'middle-C bridge/body response gives a strong second partial',
    2,
    secondPartialDb >= -6 && secondPartialDb <= 3,
    round(secondPartialDb, 2),
    '-6..+3 dB relative to strongest of first 12',
    'Matches a salient reference spectral feature but does not encode the reference waveform.',
  );
  const richness = Object.fromEntries(
    ['A0', 'A2', 'C4', 'A6'].map((name) => [name, hard.get(name).centroidHz / hard.get(name).frequency]),
  );
  addCheck(
    'spectrum',
    'register-dependent normalized richness decreases toward the treble',
    2,
    richness.A0 > richness.A2 && richness.A2 > richness.C4 && richness.C4 > richness.A6,
    Object.fromEntries(Object.entries(richness).map(([name, value]) => [name, round(value, 3)])),
    'A0 > A2 > C4 > A6 in centroid/f0',
    'Normalized centroid captures broad register contrast, not fine timbral identity.',
  );

  const totalDecay = Object.fromEntries(
    ['A0', 'A2', 'C4', 'A4', 'A6'].map((name) => [name, hard.get(name).totalDecayDb]),
  );
  addCheck(
    'decay',
    'sustained energy decays before the explicit note-off tail',
    4,
    Object.values(totalDecay).every((change) => change < -1.5),
    Object.fromEntries(Object.entries(totalDecay).map(([name, value]) => [name, round(value, 2)])),
    'late/early RMS change <-1.5 dB',
    'Broadband RMS decay is robust to beating but collapses many partial envelopes.',
  );
  addCheck(
    'decay',
    'bass outlasts the middle/treble two-stage energy loss',
    4,
    totalDecay.C4 < totalDecay.A0 - 10 &&
      totalDecay.A6 < totalDecay.A0 - 10 &&
      Math.abs(totalDecay.C4 - totalDecay.A6) <= 10,
    { A0: round(totalDecay.A0, 2), C4: round(totalDecay.C4, 2), A6: round(totalDecay.A6, 2) },
    'C4 and A6 each lose >=10 dB more than A0; C4/A6 finite-window loss within 10 dB',
    'The supplied reference loses 6.0 dB at A0, 28.9 dB at C4, and 31.7 dB at A6 in these finite windows; beating makes a strict C4/A6 ordering brittle.',
  );
  const a2FundamentalChange = partialBandChange(hard.get('A2').samples, 110, 1);
  const a2FourthChange = partialBandChange(hard.get('A2').samples, 110, 4);
  const c4FundamentalChange = partialBandChange(hard.get('C4').samples, 261.625565, 1);
  const c4FourthChange = partialBandChange(hard.get('C4').samples, 261.625565, 4);
  addCheck(
    'decay',
    'partial-dependent loss changes across the string scale',
    4,
    a2FourthChange < a2FundamentalChange - 2 &&
      c4FundamentalChange < c4FourthChange - 2,
    {
      A2Partial1Db: round(a2FundamentalChange, 2),
      A2Partial4Db: round(a2FourthChange, 2),
      C4Partial1Db: round(c4FundamentalChange, 2),
      C4Partial4Db: round(c4FourthChange, 2),
    },
    'A2 partial 4 loses >=2 dB more than f0; C4 f0 loses >=2 dB more than partial 4',
    'The reference reverses ordering at C4 (f0 −30.4 dB, partial 4 −16.0 dB) because fast vertical low modes expose a slower upper body; narrow bands remain beat-sensitive.',
  );

  const focusedAttackErrorMs = Math.abs(
    focusedA6.attack.peakSeconds - a6Target.causalAttack.onsetToPeakSeconds,
  ) * 1_000;
  const focusedPeakEnvelopeRatio =
    focusedA6.attack.peakEnvelope / a6Target.causalAttack.peakEnvelope;
  addCheck(
    'hammer-and-resonance',
    'A6 hammer collision and bridge buildup follow the measured attack shape',
    5,
    focusedAttackErrorMs <= 6 &&
      focusedA6.rmsShapeMaeDb <= 2.5 &&
      focusedA6.crestMae <= 0.75 &&
      focusedPeakEnvelopeRatio >= 0.7 && focusedPeakEnvelopeRatio <= 1.3,
    {
      attackErrorMs: round(focusedAttackErrorMs, 3),
      frameRmsShapeMaeDb: round(focusedA6.rmsShapeMaeDb, 3),
      frameCrestFactorMae: round(focusedA6.crestMae, 3),
      peakEnvelopeRatio: round(focusedPeakEnvelopeRatio, 3),
      frameRmsRelativeDb: focusedA6.frameRmsRelativeDb.map((value) => round(value, 2)),
    },
    'attack error <=6 ms, frame RMS MAE <=2.5 dB, crest MAE <=0.75, envelope ratio .7..1.3',
    'Causal RMS and crest factor capture hammer immediacy and buildup, but not the tactile identity of the action.',
  );

  const focusedSecondPartialDropDb =
    focusedA6.frames[4].bandRelativeDb.secondPartial -
    focusedA6.frames[1].bandRelativeDb.secondPartial;
  addCheck(
    'hammer-and-resonance',
    'A6 impact/body spectrum evolves into a damped string spectrum',
    6,
    focusedA6.bandMaeDb <= 4 &&
      focusedA6.centroidMeanAbsolutePercent <= 10 &&
      focusedSecondPartialDropDb >= -22 && focusedSecondPartialDropDb <= -10,
    {
      onsetFrameBandMaeDb: round(focusedA6.bandMaeDb, 3),
      maximumSingleBandErrorDb: round(focusedA6.maximumBandErrorDb, 3),
      centroidMeanAbsolutePercent: round(focusedA6.centroidMeanAbsolutePercent, 3),
      secondPartial_5to10ms_to_40to80ms_Db: round(focusedSecondPartialDropDb, 3),
      centroidsHz: focusedA6.frames.map((frame) => round(frame.centroidHz, 1)),
    },
    '30 onset-aligned band values MAE <=4 dB, centroid MAE <=10%, f2 drop 10..22 dB',
    'Short-window band energy is a proxy for audible wood/felt/string presence; room and stereo cues are intentionally absent.',
  );

  addCheck(
    'hammer-and-resonance',
    'A6 resolves a reference-scale unequal unison cluster',
    5,
    focusedA6.cluster.peakCount >= 3 &&
      Math.abs(focusedA6.cluster.spanHz - a6Target.unisonSpanHz) <= 1.5,
    {
      peakCount: focusedA6.cluster.peakCount,
      spanHz: round(focusedA6.cluster.spanHz, 4),
      referenceSpanHz: round(a6Target.unisonSpanHz, 4),
      peaks: focusedA6.cluster.peaks.map((peak) => ({
        frequencyHz: round(peak.frequencyHz, 4),
        relativeDb: round(peak.relativeDb, 3),
      })),
    },
    '>=3 lines and span within 1.5 Hz of the directly recorded 5.73 Hz span',
    'Resolved line spacing predicts unison beating without calibrating absolute oscillator frequencies to a retuned recording.',
  );

  const focusedTrajectoryAt100ms = focusedA6.trajectory[2].relativeDb;
  const focusedTrajectoryAt3s = focusedA6.trajectory.at(-1).relativeDb;
  addCheck(
    'hammer-and-resonance',
    'A6 has two-stage bridge loss plus an audible unison-beat rebound',
    4,
    focusedA6.trajectoryMaeDb <= 8 &&
      focusedA6.earlyBeatReboundDb >= 2 &&
      focusedTrajectoryAt100ms >= -24 && focusedTrajectoryAt100ms <= -12 &&
      focusedTrajectoryAt3s >= -65 && focusedTrajectoryAt3s <= -45,
    {
      trajectoryMaeDb: round(focusedA6.trajectoryMaeDb, 3),
      rebound_100to150ms_Db: round(focusedA6.earlyBeatReboundDb, 3),
      trajectoryDb: focusedA6.trajectory.map((point) => round(point.relativeDb, 2)),
    },
    'trajectory MAE <=8 dB, 100->150 ms rebound >=2 dB, 100 ms -24..-12 dB, 3 s -65..-45 dB',
    'Windowed RMS exposes rapid vertical-polarization loss and beating; the reference noise floor limits late-tail precision.',
  );

  const deterministicA = synthesizeGrandPiano(440, 0.73, 0.35);
  const deterministicB = synthesizeGrandPiano(440, 0.73, 0.35);
  let identical = deterministicA.length === deterministicB.length;
  for (let index = 0; identical && index < deterministicA.length; index += 1) {
    identical = Object.is(deterministicA[index], deterministicB[index]);
  }
  addCheck(
    'edges-and-repeatability',
    'procedural hammer/damper noise is sample-exact deterministic',
    2,
    identical,
    identical,
    'true',
    'Direct repeatability criterion.',
  );
  const silent = synthesizeGrandPiano(440, 0, 0.25);
  addCheck(
    'edges-and-repeatability',
    'zero velocity returns correctly sized digital silence',
    2,
    silent.length === Math.round(0.25 * SAMPLE_RATE) && silent.every((value) => value === 0),
    { sampleCount: silent.length, allZero: silent.every((value) => value === 0) },
    `${Math.round(0.25 * SAMPLE_RATE)} zero samples`,
    'Direct edge-case criterion.',
  );
  const lowClamp = synthesizeGrandPiano(-100, 0.5, 0.03);
  const lowBoundary = synthesizeGrandPiano(27.5, 0.5, 0.03);
  const highVelocity = synthesizeGrandPiano(440, 9, 0.03);
  const boundaryVelocity = synthesizeGrandPiano(440, 1, 0.03);
  addCheck(
    'edges-and-repeatability',
    'documented frequency and velocity clamping is exact',
    2,
    Buffer.from(lowClamp.buffer).equals(Buffer.from(lowBoundary.buffer)) &&
      Buffer.from(highVelocity.buffer).equals(Buffer.from(boundaryVelocity.buffer)),
    true,
    'out-of-range render equals corresponding boundary render',
    'Direct input-policy criterion.',
  );
  const durationCases = [1 / SAMPLE_RATE, 0.007, 0.08, 0.333, 1.1].map((duration) => {
    const samples = synthesizeGrandPiano(880, 0.6, duration);
    const stats = signalStats(samples);
    return { duration, length: samples.length, finite: stats.finite, first: stats.first, last: stats.last };
  });
  const clampedLongSilence = synthesizeGrandPiano(440, 0, MAX_DURATION_SECONDS + 5);
  addCheck(
    'edges-and-repeatability',
    'short/multiple durations and maximum-duration clamp are safe',
    2,
    durationCases.every(
      (item) => item.finite && item.first === 0 && item.last === 0 &&
        item.length === Math.round(item.duration * SAMPLE_RATE),
    ) && clampedLongSilence.length === MAX_DURATION_SECONDS * SAMPLE_RATE,
    { durationCases, maximumClampedSamples: clampedLongSilence.length },
    'finite zero-boundary output and duration<=30 s',
    'Direct buffer-safety and click-boundary criterion.',
  );

  const score = checks.reduce((sum, check) => sum + check.earned, 0);
  const possible = checks.reduce((sum, check) => sum + check.weight, 0);
  if (possible !== 100) throw new Error(`validation weights total ${possible}, expected 100`);
  const categoryScores = {};
  for (const check of checks) {
    categoryScores[check.category] ??= { earned: 0, possible: 0 };
    categoryScores[check.category].earned += check.earned;
    categoryScores[check.category].possible += check.weight;
  }
  const report = {
    schemaVersion: 2,
    passThreshold: PASS_THRESHOLD,
    score,
    possible,
    passed: score >= PASS_THRESHOLD,
    sampleRate: SAMPLE_RATE,
    referenceCalibration: referenceTargets
      ? {
          source: 'reports/reference-analysis.json',
          globalAttackToPeakMedianSeconds: referenceTargets.globalAttackToPeakMedianSeconds,
          allHarderLayersAreBrighter: referenceTargets.allHarderLayersAreBrighter,
          focusedRecording: 'A6v16.wav',
          focusedVelocity: a6Target.normalizedVelocityMidpoint,
        }
      : { source: null, note: 'Reference report not present; synthesis-only checks still run.' },
    categoryScores,
    checks,
    measurements: {
      softVelocity: SOFT_VELOCITY,
      hardVelocity: HARD_VELOCITY,
      focusedA6: {
        velocity: focusedA6.velocity,
        attackToPeakMs: round(focusedA6.attack.peakSeconds * 1_000, 3),
        frameBandMaeDb: round(focusedA6.bandMaeDb, 3),
        trajectoryMaeDb: round(focusedA6.trajectoryMaeDb, 3),
        unisonSpanHz: round(focusedA6.cluster.spanHz, 4),
      },
      soft: [...soft.values()].map(serializeNote),
      hard: [...hard.values()].map(serializeNote),
    },
    interpretation:
      'This score detects acoustic-structure and PCM regressions. Its spectral, attack, and decay metrics are proxies; passing does not establish perceptual equivalence to a recorded concert grand.',
  };

  console.log(`Procedural grand-piano validation: ${score}/100 ${report.passed ? 'PASS' : 'FAIL'}`);
  for (const [category, categoryScore] of Object.entries(categoryScores)) {
    console.log(`  ${category.padEnd(24)} ${categoryScore.earned}/${categoryScore.possible}`);
  }
  for (const check of checks.filter((item) => !item.passed)) {
    console.log(`  FAIL ${check.name}: ${JSON.stringify(check.actual)}`);
  }

  if (shouldWrite) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${path.relative(root, outputPath)}`);
  }
  if (!report.passed) process.exitCode = 1;
}

await main();
