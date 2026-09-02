#!/usr/bin/env node

import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, workerData } from 'node:worker_threads';
import { SAMPLE_RATE, synthesizeGrandPiano } from '../src/grand-piano.js';
import {
  attackMetrics,
  centsDifference,
  convertSampleRate,
  nextPowerOfTwo,
  partialPeaks,
  peakNear,
  readWav,
  rmsBetween,
  spectralCentroid,
  spectrum,
} from './audio-analysis.mjs';
import {
  comparisonWorkerCount,
  parallelMap,
  serveParallelMap,
} from './parallel-map.mjs';
import { loadSalamanderReference } from './salamander-reference.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reference = await loadSalamanderReference(root);
const { sampleRoot, sfzPath } = reference;
const outputPath = path.join(root, 'reports', 'reference-grid-convergence.json');
const shouldWrite = process.argv.includes('--write-report');
const noFail = process.argv.includes('--no-fail');
const PASS_THRESHOLD = 90;
const RENDER_SECONDS = 1.65;
const MAX_REFERENCE_FRAMES = Math.round(1.65 * SAMPLE_RATE);
const FRAME_WINDOWS_MS = [[0, 5], [5, 10], [10, 20], [20, 40], [40, 80]];
const DECAY_STARTS_SECONDS = [0.02, 0.05, 0.1, 0.2, 0.4, 0.8, 1.4];
const GRID_WORKER_TASK = 'full-reference-grid-pair';

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0
    ? finite.reduce((sum, value) => sum + value, 0) / finite.length
    : Number.NaN;
}

function percentile(values, probability) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return Number.NaN;
  const position = Math.max(0, Math.min(1, probability)) * (finite.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return finite[lower] + (finite[upper] - finite[lower]) * (position - lower);
}

function summarize(values) {
  const finite = values.filter(Number.isFinite);
  return {
    count: finite.length,
    mean: round(mean(finite), 4),
    median: round(percentile(finite, 0.5), 4),
    p90: round(percentile(finite, 0.9), 4),
    p95: round(percentile(finite, 0.95), 4),
    maximum: round(percentile(finite, 1), 4),
  };
}

function decibels(ratio) {
  return 20 * Math.log10(Math.max(ratio, Number.MIN_VALUE));
}

function clippedDecibels(ratio, floor = -60) {
  return Math.max(floor, decibels(ratio));
}

function noteToMidi(note) {
  const match = /^([A-G])(#?)(-?\d+)$/.exec(note);
  if (!match) throw new Error(`Cannot parse note name: ${note}`);
  const semitones = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return (Number(match[3]) + 1) * 12 + semitones[match[1]] + (match[2] ? 1 : 0);
}

function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function parseSustainRegions(sfzText) {
  const regions = [];
  for (const line of sfzText.split(/\r?\n/)) {
    const fileMatch = /sample=[^\s]*[\\/]?([A-G](?:#)?-?\d+)v(\d+)\.(wav|flac)/i.exec(line);
    if (!fileMatch) continue;
    const attribute = (name, fallback) => {
      const match = new RegExp(`(?:^|\\s)${name}=(-?\\d+)`).exec(line);
      return match ? Number(match[1]) : fallback;
    };
    const note = fileMatch[1].replace(/^./, (letter) => letter.toUpperCase());
    const layer = Number(fileMatch[2]);
    regions.push({
      file: `${note}v${layer}.${fileMatch[3].toLowerCase()}`,
      note,
      layer,
      midi: attribute('pitch_keycenter', noteToMidi(note)),
      keyLow: attribute('lokey', attribute('pitch_keycenter', noteToMidi(note))),
      keyHigh: attribute('hikey', attribute('pitch_keycenter', noteToMidi(note))),
      velocityLow: attribute('lovel', 0),
      velocityHigh: attribute('hivel', 127),
    });
  }
  return regions.sort((a, b) => a.midi - b.midi || a.layer - b.layer);
}

function averageSpectra(spectra) {
  const first = spectra[0];
  const powers = new Float64Array(first.powers.length);
  for (const current of spectra) {
    for (let index = 0; index < powers.length; index += 1) {
      powers[index] += current.powers[index] / spectra.length;
    }
  }
  return { ...first, powers };
}

function averageChannels(channels) {
  const output = new Float32Array(channels[0].length);
  for (const channel of channels) {
    for (let index = 0; index < output.length; index += 1) {
      output[index] += channel[index] / channels.length;
    }
  }
  return output;
}

function analysisSpectrum(samples, sampleRate, onsetSeconds, expectedHz) {
  const start = Math.round((onsetSeconds + 0.025) * sampleRate);
  const length = Math.min(32_768, samples.length - start);
  const resolutionFloor = expectedHz < 180
    ? 131_072
    : expectedHz < 700
      ? 65_536
      : 32_768;
  const fftSize = Math.max(resolutionFloor, nextPowerOfTwo(Math.max(1, length)));
  return spectrum(samples, sampleRate, { start, length, fftSize });
}

function onsetFrameShape(samples, sampleRate, onsetSeconds) {
  const values = FRAME_WINDOWS_MS.map(([startMs, endMs]) =>
    rmsBetween(
      samples,
      (onsetSeconds + startMs / 1_000) * sampleRate,
      (onsetSeconds + endMs / 1_000) * sampleRate,
    ));
  const maximum = Math.max(...values, Number.MIN_VALUE);
  return values.map((value) => clippedDecibels(value / maximum));
}

function decayShape(samples, sampleRate, onsetSeconds) {
  const values = DECAY_STARTS_SECONDS.map((startSeconds) =>
    rmsBetween(
      samples,
      (onsetSeconds + startSeconds) * sampleRate,
      (onsetSeconds + startSeconds + 0.05) * sampleRate,
    ));
  const reference = Math.max(values[0], Number.MIN_VALUE);
  return values.map((value) => clippedDecibels(value / reference, -90));
}

function profileFromPartials(spectralData, fundamentalHz) {
  const maximumPartial = Math.max(
    1,
    Math.min(12, Math.floor(15_500 / fundamentalHz)),
  );
  const peaks = partialPeaks(spectralData, fundamentalHz, maximumPartial);
  const total = Math.max(
    peaks.reduce((sum, peak) => sum + peak.power, 0),
    Number.MIN_VALUE,
  );
  return peaks.map((peak) => Math.max(-60, 10 * Math.log10(peak.power / total)));
}

function vectorMae(first, second) {
  const length = Math.min(first.length, second.length);
  if (length === 0) return Number.NaN;
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum += Math.abs(first[index] - second[index]);
  }
  return sum / length;
}

function ranks(values) {
  const entries = values.map((value, index) => ({ value, index }));
  entries.sort((a, b) => a.value - b.value);
  const result = new Float64Array(values.length);
  let lower = 0;
  while (lower < entries.length) {
    let upper = lower + 1;
    while (upper < entries.length && entries[upper].value === entries[lower].value) upper += 1;
    const rank = (lower + upper - 1) / 2;
    for (let index = lower; index < upper; index += 1) {
      result[entries[index].index] = rank;
    }
    lower = upper;
  }
  return [...result];
}

function pearson(first, second) {
  if (first.length !== second.length || first.length < 2) return Number.NaN;
  const meanFirst = mean(first);
  const meanSecond = mean(second);
  let covariance = 0;
  let varianceFirst = 0;
  let varianceSecond = 0;
  for (let index = 0; index < first.length; index += 1) {
    const centeredFirst = first[index] - meanFirst;
    const centeredSecond = second[index] - meanSecond;
    covariance += centeredFirst * centeredSecond;
    varianceFirst += centeredFirst ** 2;
    varianceSecond += centeredSecond ** 2;
  }
  return varianceFirst > 0 && varianceSecond > 0
    ? covariance / Math.sqrt(varianceFirst * varianceSecond)
    : Number.NaN;
}

function spearman(first, second) {
  return pearson(ranks(first), ranks(second));
}

function registerName(midi) {
  if (midi < 48) return 'bass';
  if (midi < 76) return 'middle';
  return 'treble';
}

function serializePair(pair) {
  return {
    file: pair.file,
    note: pair.note,
    midi: pair.midi,
    layer: pair.layer,
    velocity: round(pair.velocity, 6),
    sfzVelocityRange: pair.sfzVelocityRange,
    referenceRecordedPitchCents: round(pair.referencePitchCents, 3),
    synthesizedPitchCents: round(pair.synthesizedPitchCents, 3),
    referenceToSynthPitchGapCents: round(pair.pitchGapCents, 3),
    referenceAttackMs: round(pair.referenceAttackMs, 3),
    synthesizedAttackMs: round(pair.synthesizedAttackMs, 3),
    attackDifferenceMs: round(pair.attackDifferenceMs, 3),
    referenceCentroidHz: round(pair.referenceCentroid, 2),
    synthesizedCentroidHz: round(pair.synthesizedCentroid, 2),
    signedCentroidDifferenceCents: round(
      centsDifference(pair.synthesizedCentroid, pair.referenceCentroid),
      2,
    ),
    broadbandCentroidDifferenceCents: round(pair.centroidDifferenceCents, 2),
    partialProfileMaeDb: round(pair.partialProfileMaeDb, 3),
    onsetFrameShapeMaeDb: round(pair.onsetFrameShapeMaeDb, 3),
    decayTrajectoryMaeDb: round(pair.decayTrajectoryMaeDb, 3),
    referenceEarlyRms: round(pair.referenceEarlyRms, 7),
    synthesizedEarlyRms: round(pair.synthesizedEarlyRms, 7),
  };
}

async function analyzePair(region) {
  const reference = await readWav(path.join(sampleRoot, region.file), {
    preserveChannels: true,
    maximumFrames: Math.ceil(MAX_REFERENCE_FRAMES * 48_000 / SAMPLE_RATE) + 12,
  });
  if (reference.channels !== 2) throw new Error(`${region.file}: expected stereo reference audio`);
  const referenceChannels = reference.channelSamples.map((channel) =>
    convertSampleRate(channel, reference.sampleRate, SAMPLE_RATE, MAX_REFERENCE_FRAMES));
  const referenceSamples = averageChannels(referenceChannels);
  const nominalHz = midiToFrequency(region.midi);
  const velocity = (region.velocityLow + region.velocityHigh) / (2 * 127);
  const synthesized = synthesizeGrandPiano(nominalHz, velocity, RENDER_SECONDS);
  const referenceAttack = attackMetrics(referenceSamples, SAMPLE_RATE);
  const synthesizedAttack = attackMetrics(synthesized, SAMPLE_RATE);
  const referenceChannelSpectra = referenceChannels.map((channel) =>
    analysisSpectrum(channel, SAMPLE_RATE, referenceAttack.onsetSeconds, nominalHz));
  const referenceSpectrum = averageSpectra(referenceChannelSpectra);
  const synthesizedSpectrum = analysisSpectrum(
    synthesized,
    SAMPLE_RATE,
    synthesizedAttack.onsetSeconds,
    nominalHz,
  );
  const referencePeak = peakNear(
    referenceSpectrum,
    nominalHz * 0.955,
    nominalHz * 1.055,
  );
  const synthesizedPeak = peakNear(
    synthesizedSpectrum,
    nominalHz * 0.965,
    nominalHz * 1.035,
  );
  const referencePitchCents = centsDifference(referencePeak.frequencyHz, nominalHz);
  const synthesizedPitchCents = centsDifference(synthesizedPeak.frequencyHz, nominalHz);
  const referenceCentroid = spectralCentroid(referenceSpectrum, 20, 16_000);
  const synthesizedCentroid = spectralCentroid(synthesizedSpectrum, 20, 16_000);
  const referenceFrameShape = onsetFrameShape(
    referenceSamples,
    SAMPLE_RATE,
    referenceAttack.onsetSeconds,
  );
  const synthesizedFrameShape = onsetFrameShape(
    synthesized,
    SAMPLE_RATE,
    synthesizedAttack.onsetSeconds,
  );
  const referenceDecay = decayShape(
    referenceSamples,
    SAMPLE_RATE,
    referenceAttack.onsetSeconds,
  );
  const synthesizedDecay = decayShape(
    synthesized,
    SAMPLE_RATE,
    synthesizedAttack.onsetSeconds,
  );
  const referenceProfile = profileFromPartials(referenceSpectrum, referencePeak.frequencyHz);
  const synthesizedProfile = profileFromPartials(synthesizedSpectrum, synthesizedPeak.frequencyHz);
  const referenceEarlyRms = rmsBetween(
    referenceSamples,
    (referenceAttack.onsetSeconds + 0.02) * SAMPLE_RATE,
    (referenceAttack.onsetSeconds + 0.22) * SAMPLE_RATE,
  );
  const synthesizedEarlyRms = rmsBetween(
    synthesized,
    (synthesizedAttack.onsetSeconds + 0.02) * SAMPLE_RATE,
    (synthesizedAttack.onsetSeconds + 0.22) * SAMPLE_RATE,
  );

  return {
    ...region,
    velocity,
    sfzVelocityRange: [region.velocityLow, region.velocityHigh],
    formatValid:
      reference.channels === 2 && [16, 24].includes(reference.bitsPerSample),
    referencePitchCents,
    synthesizedPitchCents,
    pitchGapCents: Math.abs(referencePitchCents - synthesizedPitchCents),
    referenceAttackMs: referenceAttack.peakSeconds * 1_000,
    synthesizedAttackMs: synthesizedAttack.peakSeconds * 1_000,
    attackDifferenceMs: Math.abs(referenceAttack.peakSeconds - synthesizedAttack.peakSeconds) * 1_000,
    referenceCentroid,
    synthesizedCentroid,
    centroidDifferenceCents: Math.abs(centsDifference(synthesizedCentroid, referenceCentroid)),
    partialProfileMaeDb: vectorMae(referenceProfile, synthesizedProfile),
    onsetFrameShapeMaeDb: vectorMae(referenceFrameShape, synthesizedFrameShape),
    decayTrajectoryMaeDb: vectorMae(referenceDecay, synthesizedDecay),
    referenceEarlyRms,
    synthesizedEarlyRms,
    referenceFrameShape,
    synthesizedFrameShape,
    referenceDecay,
    synthesizedDecay,
  };
}

async function analyzeGridJob(region) {
  return analyzePair(region);
}

function gridProgressReporter(total, workerCount) {
  let lastReported = 0;
  return (completed) => {
    if (completed !== total && completed - lastReported < 32) return;
    lastReported = completed;
    process.stdout.write(
      `\rcompared ${completed}/${total} sustain recordings ` +
      `(${workerCount} ${workerCount === 1 ? 'job' : 'jobs'})`,
    );
  };
}

function buildVelocitySummaries(pairs) {
  const groups = new Map();
  for (const pair of pairs) {
    if (!groups.has(pair.note)) groups.set(pair.note, []);
    groups.get(pair.note).push(pair);
  }
  return [...groups].map(([note, notePairs]) => {
    notePairs.sort((a, b) => a.layer - b.layer);
    const referenceMaximum = Math.max(...notePairs.map((pair) => pair.referenceEarlyRms));
    const synthesizedMaximum = Math.max(...notePairs.map((pair) => pair.synthesizedEarlyRms));
    const referenceCurveDb = notePairs.map((pair) =>
      clippedDecibels(pair.referenceEarlyRms / referenceMaximum));
    const synthesizedCurveDb = notePairs.map((pair) =>
      clippedDecibels(pair.synthesizedEarlyRms / synthesizedMaximum));
    const referenceCentroids = notePairs.map((pair) => Math.log(pair.referenceCentroid));
    const synthesizedCentroids = notePairs.map((pair) => Math.log(pair.synthesizedCentroid));
    return {
      note,
      midi: notePairs[0].midi,
      dynamicCurveMaeDb: vectorMae(referenceCurveDb, synthesizedCurveDb),
      dynamicCurveCorrelation: pearson(referenceCurveDb, synthesizedCurveDb),
      dynamicRangeDifferenceDb: Math.abs(
        (referenceCurveDb.at(-1) - referenceCurveDb[0]) -
        (synthesizedCurveDb.at(-1) - synthesizedCurveDb[0]),
      ),
      referenceBrightnessVelocityCorrelation: spearman(
        notePairs.map((pair) => pair.velocity),
        referenceCentroids,
      ),
      synthesizedBrightnessVelocityCorrelation: spearman(
        notePairs.map((pair) => pair.velocity),
        synthesizedCentroids,
      ),
      brightnessDirectionAgrees:
        Math.sign(referenceCentroids.at(-1) - referenceCentroids[0]) ===
        Math.sign(synthesizedCentroids.at(-1) - synthesizedCentroids[0]),
      referenceCurveDb: referenceCurveDb.map((value) => round(value, 3)),
      synthesizedCurveDb: synthesizedCurveDb.map((value) => round(value, 3)),
    };
  });
}

function buildScaleSummaries(pairs) {
  const layers = [...new Set(pairs.map((pair) => pair.layer))].sort((a, b) => a - b);
  return layers.map((layer) => {
    const layerPairs = pairs.filter((pair) => pair.layer === layer);
    return {
      layer,
      pitchCount: layerPairs.length,
      centroidRankCorrelation: spearman(
        layerPairs.map((pair) => pair.referenceCentroid / midiToFrequency(pair.midi)),
        layerPairs.map((pair) => pair.synthesizedCentroid / midiToFrequency(pair.midi)),
      ),
      attackRankCorrelation: spearman(
        layerPairs.map((pair) => pair.referenceAttackMs),
        layerPairs.map((pair) => pair.synthesizedAttackMs),
      ),
      decayAt400msRankCorrelation: spearman(
        layerPairs.map((pair) => pair.referenceDecay[4]),
        layerPairs.map((pair) => pair.synthesizedDecay[4]),
      ),
      synthesizedAbsolutePitchCents: summarize(
        layerPairs.map((pair) => Math.abs(pair.synthesizedPitchCents)),
      ),
      partialProfileMaeDb: summarize(
        layerPairs.map((pair) => pair.partialProfileMaeDb),
      ),
      onsetFrameShapeMaeDb: summarize(
        layerPairs.map((pair) => pair.onsetFrameShapeMaeDb),
      ),
    };
  });
}

function metricSummary(pairs) {
  return {
    referenceAbsolutePitchCents: summarize(pairs.map((pair) => Math.abs(pair.referencePitchCents))),
    synthesizedAbsolutePitchCents: summarize(pairs.map((pair) => Math.abs(pair.synthesizedPitchCents))),
    referenceToSynthPitchGapCents: summarize(pairs.map((pair) => pair.pitchGapCents)),
    attackDifferenceMs: summarize(pairs.map((pair) => pair.attackDifferenceMs)),
    broadbandCentroidDifferenceCents: summarize(
      pairs.map((pair) => pair.centroidDifferenceCents),
    ),
    partialProfileMaeDb: summarize(pairs.map((pair) => pair.partialProfileMaeDb)),
    onsetFrameShapeMaeDb: summarize(pairs.map((pair) => pair.onsetFrameShapeMaeDb)),
    decayTrajectoryMaeDb: summarize(pairs.map((pair) => pair.decayTrajectoryMaeDb)),
  };
}

async function main() {
  try {
    await access(sfzPath);
  } catch {
    console.log('SKIP full reference-grid convergence: supplied SFZ/reference folder is absent');
    return;
  }

  const { sfzText } = reference;
  const regions = parseSustainRegions(sfzText);
  const jobs = regions;
  const workerCount = comparisonWorkerCount(process.argv.slice(2), jobs.length);
  const pairs = await parallelMap({
    items: jobs,
    moduleUrl: new URL(import.meta.url),
    task: GRID_WORKER_TASK,
    workerCount,
    localMapper: analyzeGridJob,
    onProgress: gridProgressReporter(jobs.length, workerCount),
  });
  process.stdout.write('\n');

  const notes = [...new Set(pairs.map((pair) => pair.note))];
  const layers = [...new Set(pairs.map((pair) => pair.layer))];
  const overall = metricSummary(pairs);
  const byRegister = Object.fromEntries(
    ['bass', 'middle', 'treble'].map((name) => [
      name,
      metricSummary(pairs.filter((pair) => registerName(pair.midi) === name)),
    ]),
  );
  const velocitySummaries = buildVelocitySummaries(pairs);
  const scaleSummaries = buildScaleSummaries(pairs);
  const velocityAggregate = {
    dynamicCurveMaeDb: summarize(velocitySummaries.map((item) => item.dynamicCurveMaeDb)),
    dynamicRangeDifferenceDb: summarize(
      velocitySummaries.map((item) => item.dynamicRangeDifferenceDb),
    ),
    dynamicCurveCorrelation: summarize(
      velocitySummaries.map((item) => item.dynamicCurveCorrelation),
    ),
    referenceBrightnessVelocityCorrelation: summarize(
      velocitySummaries.map((item) => item.referenceBrightnessVelocityCorrelation),
    ),
    synthesizedBrightnessVelocityCorrelation: summarize(
      velocitySummaries.map((item) => item.synthesizedBrightnessVelocityCorrelation),
    ),
    brightnessDirectionAgreementFraction:
      velocitySummaries.filter((item) => item.brightnessDirectionAgrees).length /
      velocitySummaries.length,
  };

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
  addCheck(
    'coverage',
    'complete SFZ sustain grid is compared',
    10,
    pairs.length === 480 && notes.length === 30 && layers.length === 16 &&
      pairs.every((pair) => pair.formatValid),
    { recordings: pairs.length, pitches: notes.length, layers: layers.length },
    '480 recordings = 30 sampled pitches × 16 velocity layers; all stereo PCM16/44.1 kHz',
    'Direct coverage/format criterion.',
  );
  addCheck(
    'pitch',
    'synthesized fundamentals converge across every sampled pitch and velocity',
    12,
    overall.synthesizedAbsolutePitchCents.p95 <= 4 &&
      overall.synthesizedAbsolutePitchCents.maximum <= 7,
    overall.synthesizedAbsolutePitchCents,
    'p95 <=4 cents and maximum <=7 cents',
    'Local FFT peak includes unison beating, so it is stricter than nominal oscillator tuning.',
  );
  addCheck(
    'pitch',
    'synthesized pitch stays near the unmodified recorded pitch',
    6,
    overall.referenceToSynthPitchGapCents.median <=
        overall.referenceAbsolutePitchCents.median + 3 &&
      overall.referenceToSynthPitchGapCents.p90 <=
        overall.referenceAbsolutePitchCents.p90 + 4,
    {
      gap: overall.referenceToSynthPitchGapCents,
      sourceResidualFromNominal: overall.referenceAbsolutePitchCents,
    },
    'gap median <= source residual +3 cents; gap p90 <= source residual +4 cents',
    'The synth target is equal-tempered pitch. Natural tuning offsets and weak fundamentals establish the attainable comparison floor; reference audio is never retuned.',
  );
  addCheck(
    'attack',
    'onset-to-peak timing converges over the full grid',
    8,
    overall.attackDifferenceMs.median <= 12 && overall.attackDifferenceMs.p90 <= 40,
    overall.attackDifferenceMs,
    'median <=12 ms and p90 <=40 ms',
    'Causal 3 ms RMS timing measures macroscopic buildup; sampled-key modal peaks vary by more than 40 ms, so the five-frame shape check is the stricter transient criterion.',
  );
  addCheck(
    'transient',
    'five-frame onset energy shape converges',
    10,
    overall.onsetFrameShapeMaeDb.median <= 4 && overall.onsetFrameShapeMaeDb.p90 <= 9,
    overall.onsetFrameShapeMaeDb,
    'median <=4 dB and p90 <=9 dB',
    'Normalized 0–80 ms RMS shape is gain-invariant but omits spatial cues.',
  );
  addCheck(
    'spectrum',
    'broadband brightness stays in the same perceptual neighborhood',
    10,
    overall.broadbandCentroidDifferenceCents.median <= 450 &&
      overall.broadbandCentroidDifferenceCents.p90 <= 1_000,
    overall.broadbandCentroidDifferenceCents,
    'median <=450 cents and p90 <=1000 cents',
    'Centroid is sensitive to microphones and action noise; cents express a frequency ratio, not pitch error.',
  );
  addCheck(
    'spectrum',
    'normalized partial-energy profiles converge',
    10,
    overall.partialProfileMaeDb.median <= 10 && overall.partialProfileMaeDb.p90 <= 20,
    overall.partialProfileMaeDb,
    'median <=10 dB and p90 <=20 dB',
    'Partial-band MAE captures harmonic structure while ignoring phase and stereo radiation.',
  );
  addCheck(
    'decay',
    '0.02–1.45 second energy trajectories converge',
    10,
    overall.decayTrajectoryMaeDb.median <= 8 && overall.decayTrajectoryMaeDb.p90 <= 16,
    overall.decayTrajectoryMaeDb,
    'median <=8 dB and p90 <=16 dB',
    'Fixed RMS windows expose two-stage loss and beating but are affected by reference noise floors.',
  );
  addCheck(
    'velocity',
    'within-note velocity/dynamic curves converge',
    12,
    velocityAggregate.dynamicCurveMaeDb.median <= 5 &&
      velocityAggregate.dynamicCurveMaeDb.p90 <= 8 &&
      velocityAggregate.dynamicCurveCorrelation.median >= 0.9 &&
      velocityAggregate.synthesizedBrightnessVelocityCorrelation.median >= 0.95 &&
      velocityAggregate.brightnessDirectionAgreementFraction >= 0.95,
    velocityAggregate,
    'dynamic MAE median <=5 dB/p90 <=8 dB; dynamics correlation >=0.9; brightness correlation >=0.95; >=95% endpoint-direction agreement',
    'Curves are independently normalized at layer 16; SFZ playback gain is not reconstructed.',
  );
  const worstRegisterTransientP90 = Math.max(
    ...Object.values(byRegister).map((item) => item.onsetFrameShapeMaeDb.p90),
  );
  const worstRegisterDecayP90 = Math.max(
    ...Object.values(byRegister).map((item) => item.decayTrajectoryMaeDb.p90),
  );
  addCheck(
    'registers',
    'no bass/middle/treble bucket hides a severe transient or decay failure',
    7,
    worstRegisterTransientP90 <= 14 && worstRegisterDecayP90 <= 20 &&
      Math.max(...Object.values(byRegister).map(
        (item) => item.partialProfileMaeDb.p90,
      )) <= 22,
    {
      worstRegisterTransientP90Db: round(worstRegisterTransientP90, 3),
      worstRegisterDecayP90Db: round(worstRegisterDecayP90, 3),
      worstRegisterPartialProfileP90Db: round(Math.max(
        ...Object.values(byRegister).map((item) => item.partialProfileMaeDb.p90),
      ), 3),
    },
    'each register transient p90 <=14 dB, decay p90 <=20 dB, and partial-profile p90 <=22 dB',
    'Bucket limits prevent a strong global median from masking an entire weak register.',
  );
  const minimumScaleCentroidCorrelation = Math.min(
    ...scaleSummaries.map((item) => item.centroidRankCorrelation),
  );
  const minimumScaleDecayCorrelation = Math.min(
    ...scaleSummaries.map((item) => item.decayAt400msRankCorrelation),
  );
  const maximumScalePartialMedian = Math.max(
    ...scaleSummaries.map((item) => item.partialProfileMaeDb.median),
  );
  const maximumScaleOnsetMedian = Math.max(
    ...scaleSummaries.map((item) => item.onsetFrameShapeMaeDb.median),
  );
  addCheck(
    'scales',
    'every velocity layer preserves convergence across the sampled scale',
    5,
    scaleSummaries.length === 16 &&
      scaleSummaries.every((item) => item.pitchCount === 30) &&
      minimumScaleCentroidCorrelation >= 0.9 &&
      minimumScaleDecayCorrelation >= 0.7 &&
      maximumScalePartialMedian <= 10 &&
      maximumScaleOnsetMedian <= 5,
    {
      velocityLayers: scaleSummaries.length,
      pitchesPerLayer: scaleSummaries.map((item) => item.pitchCount),
      minimumCentroidRankCorrelation: round(minimumScaleCentroidCorrelation, 4),
      minimumDecayRankCorrelation: round(minimumScaleDecayCorrelation, 4),
      maximumPartialProfileMedianDb: round(maximumScalePartialMedian, 3),
      maximumOnsetShapeMedianDb: round(maximumScaleOnsetMedian, 3),
    },
    '16/16 layers × 30 pitches; centroid rank >=0.9; 400 ms decay rank >=0.7; partial median <=10 dB; onset median <=5 dB',
    'Rank correlations test register-scale behavior without demanding sampled-key phase or room identity.',
  );

  const possible = checks.reduce((sum, check) => sum + check.weight, 0);
  const score = checks.reduce((sum, check) => sum + check.earned, 0);
  if (possible !== 100) throw new Error(`grid convergence weights total ${possible}`);
  const report = {
    schemaVersion: 2,
    passThreshold: PASS_THRESHOLD,
    score,
    possible,
    passed: score >= PASS_THRESHOLD,
    source: {
      sfz: path.relative(root, sfzPath),
      referenceAudioUsage:
        'Development-time measurement only. No reference audio is loaded by src/grand-piano.js or copied into procedural output.',
    },
    coverage: {
      recordings: pairs.length,
      sampledPitches: notes.length,
      velocityLayers: layers.length,
      noteNames: notes,
      layers,
      synthesizedRenders: pairs.length,
    },
    method: {
      renderSeconds: RENDER_SECONDS,
      referenceDecodeLimitSeconds: MAX_REFERENCE_FRAMES / SAMPLE_RATE,
      alignment: 'independent causal 3 ms RMS onset detection; comparisons use time relative to onset',
      spectrum:
        '25 ms post-onset Hann windows; unmodified reference L/R power averaged; adaptive 32768–131072 FFT',
      onsetShape: 'RMS in 0–5, 5–10, 10–20, 20–40, and 40–80 ms frames, normalized to each signal maximum',
      decay: '50 ms RMS windows starting 0.02, 0.05, 0.1, 0.2, 0.4, 0.8, and 1.4 seconds after onset, normalized at 0.02 seconds',
      partials: 'first up-to-12 locally resolved partial powers below 15.5 kHz, normalized and clipped at -60 dB',
      caveat:
        'These gain/phase-invariant proxies measure convergence of behaviors, not waveform identity or perceptual equivalence to the recorded Yamaha C5.',
    },
    overall,
    byRegister,
    velocityAggregate,
    velocityByNote: velocitySummaries.map((item) => ({
      ...item,
      dynamicCurveMaeDb: round(item.dynamicCurveMaeDb, 3),
      dynamicCurveCorrelation: round(item.dynamicCurveCorrelation, 4),
      dynamicRangeDifferenceDb: round(item.dynamicRangeDifferenceDb, 3),
      referenceBrightnessVelocityCorrelation: round(
        item.referenceBrightnessVelocityCorrelation,
        4,
      ),
      synthesizedBrightnessVelocityCorrelation: round(
        item.synthesizedBrightnessVelocityCorrelation,
        4,
      ),
    })),
    scaleSummaries: scaleSummaries.map((item) => ({
      ...item,
      centroidRankCorrelation: round(item.centroidRankCorrelation, 4),
      attackRankCorrelation: round(item.attackRankCorrelation, 4),
      decayAt400msRankCorrelation: round(item.decayAt400msRankCorrelation, 4),
    })),
    checks,
    comparisons: pairs.map(serializePair),
  };

  console.log(`Full reference-grid convergence: ${score}/100 ${report.passed ? 'PASS' : 'FAIL'}`);
  console.log(`  coverage                 ${pairs.length} recordings, ${notes.length} pitches, ${layers.length} layers`);
  console.log(`  pitch gap                median ${overall.referenceToSynthPitchGapCents.median}c, p90 ${overall.referenceToSynthPitchGapCents.p90}c`);
  console.log(`  attack difference        median ${overall.attackDifferenceMs.median}ms, p90 ${overall.attackDifferenceMs.p90}ms`);
  console.log(`  onset-frame shape MAE    median ${overall.onsetFrameShapeMaeDb.median}dB, p90 ${overall.onsetFrameShapeMaeDb.p90}dB`);
  console.log(`  partial-profile MAE      median ${overall.partialProfileMaeDb.median}dB, p90 ${overall.partialProfileMaeDb.p90}dB`);
  console.log(`  decay-trajectory MAE     median ${overall.decayTrajectoryMaeDb.median}dB, p90 ${overall.decayTrajectoryMaeDb.p90}dB`);
  console.log(`  scale layers             ${scaleSummaries.length} × ${scaleSummaries[0]?.pitchCount ?? 0} pitches`);
  for (const check of checks.filter((item) => !item.passed)) {
    console.log(`  FAIL ${check.name}: ${JSON.stringify(check.actual)}`);
  }
  if (shouldWrite) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${path.relative(root, outputPath)}`);
  }
  if (!noFail && !report.passed) process.exitCode = 1;
}

if (!isMainThread && workerData?.task === GRID_WORKER_TASK) {
  await serveParallelMap(workerData.jobs, analyzeGridJob);
} else if (
  isMainThread &&
  path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)
) {
  await main();
}
