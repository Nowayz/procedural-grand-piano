#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, workerData } from 'node:worker_threads';
import { SAMPLE_RATE, synthesizeGrandPiano } from '../src/grand-piano.js';
import {
  attackMetrics,
  bandPower,
  centsDifference,
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
import {
  buildChromaticJobs,
  resampleChannel,
} from './compare-reference-grid.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const referenceRoot = path.join(root, 'SalamanderGrandPianoV3_44.1khz16bit');
const sampleRoot = path.join(referenceRoot, '44.1khz16bit');
const sfzPath = path.join(referenceRoot, 'SalamanderGrandPianoV3.sfz');
const retunedSfzPath = path.join(referenceRoot, 'SalamanderGrandPianoV3Retuned.sfz');
const chromaticMode = process.argv.includes('--chromatic');
const cachePath = path.join(
  root,
  'reports',
  chromaticMode
    ? 'chromatic-reference-fidelity-features.json'
    : 'reference-fidelity-features.json',
);
const quickMode = process.argv.includes('--quick');
const baselineSnapshot = process.argv.includes('--baseline-snapshot');
const reportPath = path.join(
  root,
  'reports',
  chromaticMode
    ? 'chromatic-strict-fidelity-report.json'
    : baselineSnapshot
    ? 'strict-fidelity-baseline.json'
    : quickMode
      ? 'strict-fidelity-quick.json'
      : 'strict-fidelity-report.json',
);
const shouldWrite = process.argv.includes('--write-report');
const noFail = process.argv.includes('--no-fail');
const rebuildCache = process.argv.includes('--rebuild-reference-cache');

const CACHE_SCHEMA_VERSION = 4;
const REPORT_SCHEMA_VERSION = 1;
const PASS_THRESHOLD = 85;
const RENDER_SECONDS = 2.55;
const MAX_REFERENCE_FRAMES = Math.round(RENDER_SECONDS * SAMPLE_RATE);
const SUSTAIN_STARTS_SECONDS = Object.freeze([0.025, 0.08, 0.18, 0.4, 0.8, 1.35, 2.05]);
const TRANSIENT_WINDOWS_SECONDS = Object.freeze([
  [0, 0.006],
  [0.006, 0.014],
  [0.014, 0.028],
  [0.028, 0.055],
  [0.055, 0.11],
]);
const AUDITORY_BAND_EDGES_HZ = Object.freeze([
  20, 40, 63, 100, 160, 250, 400, 630, 1_000, 1_600,
  2_500, 4_000, 6_300, 10_000, 16_000,
]);
const DB_FLOOR = -72;
const SYNTHESIS_WORKER_TASK = 'strict-reference-synthesis';
const CHROMATIC_REFERENCE_WORKER_TASK = 'strict-chromatic-reference';
const REFERENCE_NOISE_TAIL_SECONDS = 1.5;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

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

function median(values) {
  return percentile(values, 0.5);
}

function percentile(values, probability) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return Number.NaN;
  const position = clamp(probability, 0, 1) * (finite.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return finite[lower] + (finite[upper] - finite[lower]) * (position - lower);
}

function summarize(values) {
  const finite = values.filter(Number.isFinite);
  return {
    count: finite.length,
    mean: round(mean(finite)),
    median: round(percentile(finite, 0.5)),
    p90: round(percentile(finite, 0.9)),
    p95: round(percentile(finite, 0.95)),
    maximum: round(percentile(finite, 1)),
  };
}

function dbAmplitude(value) {
  return 20 * Math.log10(Math.max(value, Number.MIN_VALUE));
}

function dbPower(value) {
  return 10 * Math.log10(Math.max(value, Number.MIN_VALUE));
}

function clippedDbAmplitude(value, floor = DB_FLOOR) {
  return Math.max(floor, dbAmplitude(value));
}

function clippedDbPower(value, floor = DB_FLOOR) {
  return Math.max(floor, dbPower(value));
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

function parseSustainRegions(sfzText) {
  const regions = [];
  for (const line of sfzText.split(/\r?\n/)) {
    const fileMatch = /sample=[^\s]*[\\/]?([A-G](?:#)?-?\d+)v(\d+)\.wav/i.exec(line);
    if (!fileMatch) continue;
    const attribute = (name, fallback) => {
      const match = new RegExp(`(?:^|\\s)${name}=(-?\\d+)`).exec(line);
      return match ? Number(match[1]) : fallback;
    };
    const note = fileMatch[1].replace(/^./, (letter) => letter.toUpperCase());
    const midi = attribute('pitch_keycenter', noteToMidi(note));
    regions.push({
      file: `${note}v${Number(fileMatch[2])}.wav`,
      note,
      layer: Number(fileMatch[2]),
      midi,
      keyLow: attribute('lokey', midi),
      keyHigh: attribute('hikey', midi),
      velocityLow: attribute('lovel', 0),
      velocityHigh: attribute('hivel', 127),
      tuneCents: attribute('tune', 0),
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

function channelPowerRms(channels, start, end) {
  let energy = 0;
  for (const channel of channels) {
    const rms = rmsBetween(channel, start, end);
    energy += rms * rms / channels.length;
  }
  return Math.sqrt(energy);
}

function channelPeak(channels, start, end) {
  const lower = Math.max(0, Math.floor(start));
  const upper = Math.min(channels[0].length, Math.ceil(end));
  let peak = 0;
  for (const channel of channels) {
    for (let index = lower; index < upper; index += 1) {
      peak = Math.max(peak, Math.abs(channel[index]));
    }
  }
  return peak;
}

function channelSpectrum(channels, sampleRate, start, length, fftSize) {
  return averageSpectra(channels.map((channel) =>
    spectrum(channel, sampleRate, { start, length, fftSize })));
}

function auditoryBandPowers(spectralData) {
  const values = [];
  for (let index = 0; index < AUDITORY_BAND_EDGES_HZ.length - 1; index += 1) {
    values.push(bandPower(
      spectralData,
      AUDITORY_BAND_EDGES_HZ[index],
      AUDITORY_BAND_EDGES_HZ[index + 1],
    ));
  }
  return values;
}

function normalizedPowerProfile(powers) {
  const total = Math.max(powers.reduce((sum, value) => sum + value, 0), Number.MIN_VALUE);
  return powers.map((value) => clippedDbPower(value / total));
}

function vectorMae(first, second) {
  const length = Math.min(first.length, second.length);
  if (length === 0) return Number.NaN;
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    total += Math.abs(first[index] - second[index]);
  }
  return total / length;
}

function activeProfileMae(reference, synthesized, thresholdDb = -58) {
  let total = 0;
  let count = 0;
  const length = Math.min(reference.length, synthesized.length);
  for (let index = 0; index < length; index += 1) {
    if (Math.max(reference[index], synthesized[index]) < thresholdDb) continue;
    total += Math.abs(reference[index] - synthesized[index]);
    count += 1;
  }
  return count > 0 ? total / count : 0;
}

function matrixProfileMae(reference, synthesized, thresholdDb = -58, activeFrames, maximumColumns = Number.POSITIVE_INFINITY) {
  const values = [];
  const length = Math.min(reference.length, synthesized.length);
  for (let index = 0; index < length; index += 1) {
    if (activeFrames && !activeFrames[index]) continue;
    values.push(activeProfileMae(
      reference[index].slice(0, maximumColumns),
      synthesized[index].slice(0, maximumColumns),
      thresholdDb,
    ));
  }
  return mean(values);
}

function normalizedEnvelope(channels, sampleRate, onsetSeconds, expectedHz) {
  // A fixed 4 ms window follows phase rather than energy below the tenor.
  // Span at least 1.25 fundamental cycles, while retaining millisecond attack
  // resolution through the middle and treble registers.
  const windowSeconds = clamp(1.25 / expectedHz, 0.004, 0.035);
  const windowSamples = Math.round(windowSeconds * sampleRate);
  const hopSamples = Math.round(0.002 * sampleRate);
  const onsetSample = Math.round(onsetSeconds * sampleRate);
  const values = [];
  for (let offset = 0; offset < Math.round(0.12 * sampleRate); offset += hopSamples) {
    values.push(channelPowerRms(
      channels,
      onsetSample + offset,
      onsetSample + offset + windowSamples,
    ));
  }
  const maximum = Math.max(...values, Number.MIN_VALUE);
  return values.map((value) => clippedDbAmplitude(value / maximum));
}

function attackEnergyQuantiles(channels, sampleRate, onsetSeconds) {
  const start = Math.max(0, Math.round(onsetSeconds * sampleRate));
  const end = Math.min(channels[0].length, start + Math.round(0.12 * sampleRate));
  const energies = new Float64Array(Math.max(0, end - start));
  let total = 0;
  for (let index = start; index < end; index += 1) {
    let value = 0;
    for (const channel of channels) value += channel[index] ** 2 / channels.length;
    total += value;
    energies[index - start] = total;
  }
  return [0.1, 0.5, 0.9].map((quantile) => {
    const target = total * quantile;
    let index = 0;
    while (index < energies.length && energies[index] < target) index += 1;
    return index / sampleRate;
  });
}

function transientProfiles(channels, sampleRate, onsetSeconds) {
  return TRANSIENT_WINDOWS_SECONDS.map(([startSeconds, endSeconds]) => {
    const start = Math.round((onsetSeconds + startSeconds) * sampleRate);
    const length = Math.max(1, Math.round((endSeconds - startSeconds) * sampleRate));
    const fftSize = Math.max(2_048, nextPowerOfTwo(length));
    const spectralData = channelSpectrum(channels, sampleRate, start, length, fftSize);
    return normalizedPowerProfile(auditoryBandPowers(spectralData));
  });
}

function harmonicToResidualDb(spectralData, fundamentalHz, maximumPartial) {
  const peaks = partialPeaks(spectralData, fundamentalHz, maximumPartial);
  const selectedBins = new Uint8Array(spectralData.powers.length);
  const halfWidthBins = Math.max(
    3,
    Math.ceil(Math.max(3, fundamentalHz * 0.006) / spectralData.binHz),
  );
  for (const peak of peaks) {
    for (
      let bin = Math.max(1, peak.bin - halfWidthBins);
      bin <= Math.min(selectedBins.length - 1, peak.bin + halfWidthBins);
      bin += 1
    ) selectedBins[bin] = 1;
  }
  const lower = Math.max(1, Math.ceil(20 / spectralData.binHz));
  const upper = Math.min(selectedBins.length - 1, Math.floor(16_000 / spectralData.binHz));
  let harmonic = 0;
  let residual = 0;
  for (let bin = lower; bin <= upper; bin += 1) {
    if (selectedBins[bin]) harmonic += spectralData.powers[bin];
    else residual += spectralData.powers[bin];
  }
  return clamp(dbPower(harmonic / Math.max(residual, Number.MIN_VALUE)), -30, 60);
}

function longSpectrum(channels, sampleRate, onsetSeconds) {
  const start = Math.round((onsetSeconds + 0.07) * sampleRate);
  const length = Math.min(Math.round(0.82 * sampleRate), channels[0].length - start);
  return channelSpectrum(channels, sampleRate, start, length, 131_072);
}

function fitStiffString(spectralData, expectedHz, maximumPartial) {
  const peaks = partialPeaks(spectralData, expectedHz, maximumPartial);
  const strongest = Math.max(...peaks.map(({ power }) => power), Number.MIN_VALUE);
  let selected = peaks.filter(({ power }) => clippedDbPower(power / strongest) >= -35);

  const fit = (items) => {
    let weightSum = 0;
    let meanX = 0;
    let meanY = 0;
    for (const peak of items) {
      const weight = Math.sqrt(peak.power / strongest);
      const x = peak.partial ** 2 - 1;
      const y = (peak.frequencyHz / peak.partial) ** 2;
      weightSum += weight;
      meanX += weight * x;
      meanY += weight * y;
    }
    meanX /= weightSum;
    meanY /= weightSum;
    let covariance = 0;
    let variance = 0;
    for (const peak of items) {
      const weight = Math.sqrt(peak.power / strongest);
      const x = peak.partial ** 2 - 1;
      const y = (peak.frequencyHz / peak.partial) ** 2;
      covariance += weight * (x - meanX) * (y - meanY);
      variance += weight * (x - meanX) ** 2;
    }
    const slope = variance > 0 ? covariance / variance : 0;
    const intercept = meanY - slope * meanX;
    const stiffness = intercept > slope && slope >= 0
      ? slope / (intercept - slope)
      : 0;
    const fundamentalHz = Math.sqrt(Math.max(intercept, Number.MIN_VALUE));
    return { stiffness, fundamentalHz };
  };

  if (selected.length < 3) {
    const peak = peakNear(spectralData, expectedHz * 0.95, expectedHz * 1.065);
    return {
      stiffness: Number.NaN,
      fundamentalHz: peak.frequencyHz,
      residualCents: Number.NaN,
      strongPartials: selected.length,
      stretchCents: Number.NaN,
    };
  }

  let model = fit(selected);
  // Reject isolated room/noise peaks once, then refit the physical f_n curve.
  selected = selected.filter((peak) => {
    const predicted =
      peak.partial * model.fundamentalHz *
      Math.sqrt((1 + model.stiffness * peak.partial ** 2) / (1 + model.stiffness));
    return Math.abs(centsDifference(peak.frequencyHz, predicted)) <= 12;
  });
  if (selected.length >= 3) model = fit(selected);
  const residuals = selected.map((peak) => {
    const predicted =
      peak.partial * model.fundamentalHz *
      Math.sqrt((1 + model.stiffness * peak.partial ** 2) / (1 + model.stiffness));
    return Math.abs(centsDifference(peak.frequencyHz, predicted));
  });
  const maximumStrongPartial = Math.max(...selected.map(({ partial }) => partial));
  const diagnosticPartial = Math.min(10, maximumStrongPartial);
  const stretchCents = 1_200 * Math.log2(Math.sqrt(
    (1 + model.stiffness * diagnosticPartial ** 2) /
    (1 + model.stiffness),
  ));
  return {
    ...model,
    residualCents: mean(residuals),
    strongPartials: selected.length,
    maximumStrongPartial,
    stretchCents,
  };
}

function subtractSpectrum(spectralData, noiseSpectrum) {
  if (!noiseSpectrum) return spectralData;
  const powers = new Float64Array(spectralData.powers.length);
  for (let index = 0; index < powers.length; index += 1) {
    powers[index] = Math.max(
      Number.MIN_VALUE,
      spectralData.powers[index] - noiseSpectrum.powers[index],
    );
  }
  return { ...spectralData, powers };
}

function minimumNoiseSpectrum(channels, sampleRate, windowSamples, fftSize) {
  if (channels[0].length <= MAX_REFERENCE_FRAMES + windowSamples) return undefined;
  const candidates = [1.25, 0.82, 0.4].map((secondsBeforeEnd) => {
    const start = Math.max(
      MAX_REFERENCE_FRAMES,
      channels[0].length - Math.round(secondsBeforeEnd * sampleRate) - windowSamples,
    );
    return channelSpectrum(channels, sampleRate, start, windowSamples, fftSize);
  });
  const powers = new Float64Array(candidates[0].powers.length);
  for (let bin = 0; bin < powers.length; bin += 1) {
    powers[bin] = Math.min(...candidates.map((candidate) => candidate.powers[bin]));
  }
  return { ...candidates[0], powers };
}

function toneModulation(samples, sampleRate, onsetSeconds, frequencyHz) {
  const windowSeconds = clamp(3 / frequencyHz, 0.04, 0.14);
  const windowSamples = Math.max(64, Math.round(windowSeconds * sampleRate));
  const hopSamples = Math.max(32, Math.round(windowSamples * 0.5));
  const start = Math.round((onsetSeconds + 0.12) * sampleRate);
  const end = Math.min(samples.length, Math.round((onsetSeconds + 1.85) * sampleRate));
  const angularStep = -2 * Math.PI * frequencyHz / sampleRate;
  const stepReal = Math.cos(angularStep);
  const stepImaginary = Math.sin(angularStep);
  const values = [];
  const times = [];

  for (let frameStart = start; frameStart + windowSamples <= end; frameStart += hopSamples) {
    let oscillatorReal = 1;
    let oscillatorImaginary = 0;
    let real = 0;
    let imaginary = 0;
    for (let offset = 0; offset < windowSamples; offset += 1) {
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * offset / (windowSamples - 1));
      const value = samples[frameStart + offset] * window;
      real += value * oscillatorReal;
      imaginary += value * oscillatorImaginary;
      const nextReal = oscillatorReal * stepReal - oscillatorImaginary * stepImaginary;
      oscillatorImaginary = oscillatorReal * stepImaginary + oscillatorImaginary * stepReal;
      oscillatorReal = nextReal;
    }
    values.push(dbAmplitude(Math.hypot(real, imaginary)));
    times.push((frameStart - start) / sampleRate);
  }

  if (values.length < 3) return { residualStdDb: 0, roughnessDb: 0 };
  const meanTime = mean(times);
  const meanValue = mean(values);
  let covariance = 0;
  let varianceTime = 0;
  for (let index = 0; index < values.length; index += 1) {
    covariance += (times[index] - meanTime) * (values[index] - meanValue);
    varianceTime += (times[index] - meanTime) ** 2;
  }
  const slope = varianceTime > 0 ? covariance / varianceTime : 0;
  const residuals = values.map((value, index) =>
    value - (meanValue + slope * (times[index] - meanTime)));
  const residualStdDb = Math.sqrt(mean(residuals.map((value) => value * value)));
  const differences = residuals.slice(1).map((value, index) => value - residuals[index]);
  const roughnessDb = Math.sqrt(mean(differences.map((value) => value * value)));
  return { residualStdDb, roughnessDb };
}

function averageModulation(channels, sampleRate, onsetSeconds, frequencyHz) {
  const measurements = channels.map((channel) =>
    toneModulation(channel, sampleRate, onsetSeconds, frequencyHz));
  return {
    residualStdDb: mean(measurements.map(({ residualStdDb }) => residualStdDb)),
    roughnessDb: mean(measurements.map(({ roughnessDb }) => roughnessDb)),
  };
}

export function extractFeatures(channels, sampleRate, expectedHz, { estimateNoiseFloor = false } = {}) {
  const mono = channels.length === 1
    ? channels[0]
    : (() => {
        const result = new Float32Array(channels[0].length);
        for (let index = 0; index < result.length; index += 1) {
          for (const channel of channels) result[index] += channel[index] / channels.length;
        }
        return result;
      })();
  const attack = attackMetrics(mono, sampleRate);
  const onsetSeconds = attack.onsetSeconds;
  const pitchSpectrum = longSpectrum(channels, sampleRate, onsetSeconds);
  const pitchPeak = peakNear(pitchSpectrum, expectedHz * 0.95, expectedHz * 1.065);
  const maximumPartial = Math.max(1, Math.min(16, Math.floor(15_500 / expectedHz)));
  const stiffStringFit = fitStiffString(pitchSpectrum, expectedHz, maximumPartial);
  const fittedPitchIsCredible =
    stiffStringFit.strongPartials >= 3 &&
    stiffStringFit.residualCents <= 8 &&
    Math.abs(centsDifference(stiffStringFit.fundamentalHz, expectedHz)) <= 60;
  const fundamentalHz = fittedPitchIsCredible
    ? stiffStringFit.fundamentalHz
    : pitchPeak.frequencyHz;
  const sustainProfiles = [];
  const sustainBandPowers = [];
  const partialProfiles = [];
  const partialPowers = [];
  const harmonicityDb = [];
  const centroidsHz = [];
  const sustainRms = [];
  const windowSeconds = clamp(6 / expectedHz, 0.046, 0.18);
  const windowSamples = Math.round(windowSeconds * sampleRate);
  // Zero-padding makes partial amplitudes and local peak positions much less
  // sensitive to where a bass partial lands between FFT bins. The actual
  // time resolution remains governed by the adaptive analysis window.
  const fftSize = Math.max(65_536, nextPowerOfTwo(windowSamples));
  const noiseSpectrum = estimateNoiseFloor
    ? minimumNoiseSpectrum(channels, sampleRate, windowSamples, fftSize)
    : undefined;
  const noiseBandPowers = noiseSpectrum
    ? auditoryBandPowers(noiseSpectrum)
    : new Array(AUDITORY_BAND_EDGES_HZ.length - 1).fill(0);
  const noisePeaks = noiseSpectrum
    ? partialPeaks(noiseSpectrum, fundamentalHz, maximumPartial).map(({ power }) => power)
    : new Array(maximumPartial).fill(0);
  const noiseRmsCandidates = estimateNoiseFloor && channels[0].length > MAX_REFERENCE_FRAMES
    ? [1.25, 0.82, 0.4].map((secondsBeforeEnd) => {
        const end = channels[0].length - Math.round(secondsBeforeEnd * sampleRate);
        return channelPowerRms(channels, end - windowSamples, end);
      })
    : [0];
  const noiseRms = Math.min(...noiseRmsCandidates);
  const sustainRawRms = [];

  for (const time of SUSTAIN_STARTS_SECONDS) {
    const start = Math.round((onsetSeconds + time) * sampleRate);
    const rawSpectralData = channelSpectrum(
      channels,
      sampleRate,
      start,
      Math.min(windowSamples, channels[0].length - start),
      fftSize,
    );
    const spectralData = subtractSpectrum(rawSpectralData, noiseSpectrum);
    const bands = auditoryBandPowers(spectralData);
    const peaks = partialPeaks(spectralData, fundamentalHz, maximumPartial);
    const peakPowers = peaks.map(({ power }) => power);
    sustainBandPowers.push(bands);
    sustainProfiles.push(normalizedPowerProfile(bands));
    partialPowers.push(peakPowers);
    partialProfiles.push(normalizedPowerProfile(peakPowers));
    harmonicityDb.push(harmonicToResidualDb(spectralData, fundamentalHz, maximumPartial));
    centroidsHz.push(spectralCentroid(spectralData, 20, 16_000));
    const rawRms = channelPowerRms(channels, start, start + windowSamples);
    sustainRawRms.push(rawRms);
    sustainRms.push(Math.sqrt(Math.max(
      Number.MIN_VALUE,
      rawRms * rawRms - noiseRms * noiseRms,
    )));
  }

  const earlyStart = (onsetSeconds + 0.02) * sampleRate;
  const earlyEnd = (onsetSeconds + 0.5) * sampleRate;
  const earlyRms = channelPowerRms(channels, earlyStart, earlyEnd);
  const earlyPeak = channelPeak(channels, earlyStart, earlyEnd);
  return {
    onsetSeconds,
    attackPeakSeconds: attack.peakSeconds,
    attackEnvelopeDb: normalizedEnvelope(channels, sampleRate, onsetSeconds, expectedHz),
    attackEnergyQuantilesSeconds: attackEnergyQuantiles(channels, sampleRate, onsetSeconds),
    transientProfiles: transientProfiles(channels, sampleRate, onsetSeconds),
    earlyRms,
    earlyCrestDb: dbAmplitude(earlyPeak / Math.max(earlyRms, Number.MIN_VALUE)),
    fundamentalHz,
    inharmonicity: stiffStringFit.stiffness,
    inharmonicFitResidualCents: stiffStringFit.residualCents,
    inharmonicStrongPartials: stiffStringFit.strongPartials,
    inharmonicMaximumStrongPartial: stiffStringFit.maximumStrongPartial,
    inharmonicStretchCents: stiffStringFit.stretchCents,
    sustainProfiles,
    sustainBandPowers,
    partialProfiles,
    partialPowers,
    sustainRms,
    sustainRawRms,
    noiseRms,
    noiseBandPowers,
    noisePartialPowers: noisePeaks,
    harmonicityDb,
    centroidsHz,
    modulation: averageModulation(channels, sampleRate, onsetSeconds, fundamentalHz),
  };
}

function decayMatrixMae(referencePowers, synthesizedPowers, activeThresholdDb = -50, maximumColumns = Number.POSITIVE_INFINITY) {
  const anchorIndex = 1;
  const referenceAnchor = referencePowers[anchorIndex];
  const synthesizedAnchor = synthesizedPowers[anchorIndex];
  const strongestReference = Math.max(...referenceAnchor, Number.MIN_VALUE);
  const values = [];
  for (
    let band = 0;
    band < Math.min(referenceAnchor.length, maximumColumns);
    band += 1
  ) {
    if (clippedDbPower(referenceAnchor[band] / strongestReference) < activeThresholdDb) continue;
    for (let frame = anchorIndex + 1; frame < referencePowers.length; frame += 1) {
      const referenceChange = clippedDbPower(
        referencePowers[frame][band] / Math.max(referenceAnchor[band], Number.MIN_VALUE),
        -90,
      );
      const synthesizedChange = clippedDbPower(
        synthesizedPowers[frame][band] /
          Math.max(synthesizedAnchor[band] ?? 0, Number.MIN_VALUE),
        -90,
      );
      values.push(Math.abs(referenceChange - synthesizedChange));
    }
  }
  return mean(values);
}

function broadbandDecayMae(reference, synthesized) {
  const anchorIndex = 1;
  const referenceAnchor = Math.max(reference[anchorIndex], Number.MIN_VALUE);
  const synthesizedAnchor = Math.max(synthesized[anchorIndex], Number.MIN_VALUE);
  const values = [];
  for (let index = anchorIndex + 1; index < reference.length; index += 1) {
    values.push(Math.abs(
      clippedDbAmplitude(reference[index] / referenceAnchor, -90) -
      clippedDbAmplitude(synthesized[index] / synthesizedAnchor, -90),
    ));
  }
  return mean(values);
}

function inharmonicStretchDifference(reference, synthesized) {
  if (
    reference.inharmonicStrongPartials < 3 ||
    synthesized.inharmonicStrongPartials < 3 ||
    reference.inharmonicFitResidualCents > 8 ||
    synthesized.inharmonicFitResidualCents > 8
  ) return Number.NaN;
  const diagnosticPartial = Math.min(
    10,
    reference.inharmonicMaximumStrongPartial,
    synthesized.inharmonicMaximumStrongPartial,
  );
  if (diagnosticPartial < 3) return Number.NaN;
  const stretch = (stiffness) => 1_200 * Math.log2(Math.sqrt(
    (1 + stiffness * diagnosticPartial ** 2) / (1 + stiffness),
  ));
  return Math.abs(stretch(reference.inharmonicity) - stretch(synthesized.inharmonicity));
}

function signedProfileMatrix(reference, synthesized, activeFrames) {
  return reference.map((row, frame) => row.map((value, column) =>
    !activeFrames || activeFrames[frame]
      ? synthesized[frame][column] - value
      : null));
}

function signedDecayMatrix(reference, synthesized) {
  const anchorIndex = 1;
  return reference.map((row, frame) => row.map((value, column) => {
    if (frame <= anchorIndex) return null;
    const referenceChange = clippedDbPower(
      value / Math.max(reference[anchorIndex][column], Number.MIN_VALUE),
      -90,
    );
    const synthesizedChange = clippedDbPower(
      synthesized[frame][column] /
        Math.max(synthesized[anchorIndex][column], Number.MIN_VALUE),
      -90,
    );
    return synthesizedChange - referenceChange;
  }));
}

export function compareFeatures(reference, synthesized) {
  const activeFrames = reference.sustainRawRms.map((rawRms) =>
    reference.noiseRms <= 0 || dbAmplitude(rawRms / reference.noiseRms) >= 8);
  const centroidDifferences = reference.centroidsHz.flatMap((value, index) =>
    activeFrames[index]
      ? [Math.abs(centsDifference(synthesized.centroidsHz[index], value))]
      : []);
  const modulationDifference = mean([
    Math.abs(reference.modulation.residualStdDb - synthesized.modulation.residualStdDb),
    Math.abs(reference.modulation.roughnessDb - synthesized.modulation.roughnessDb),
  ]);
  const reliablePartialCount = Math.max(
    1,
    Math.min(
      reference.partialPowers[0].length,
      reference.inharmonicMaximumStrongPartial ?? reference.inharmonicStrongPartials ?? 1,
    ),
  );
  return {
    rawLevelDifferenceDb: dbAmplitude(synthesized.earlyRms / reference.earlyRms),
    attackPeakDifferenceMs:
      Math.abs(reference.attackPeakSeconds - synthesized.attackPeakSeconds) * 1_000,
    attackEnvelopeMaeDb: vectorMae(reference.attackEnvelopeDb, synthesized.attackEnvelopeDb),
    attackEnergyQuantileMaeMs: 1_000 * vectorMae(
      reference.attackEnergyQuantilesSeconds,
      synthesized.attackEnergyQuantilesSeconds,
    ),
    transientSpectrumMaeDb: matrixProfileMae(
      reference.transientProfiles,
      synthesized.transientProfiles,
    ),
    sustainSpectrumMaeDb: matrixProfileMae(
      reference.sustainProfiles,
      synthesized.sustainProfiles,
      -58,
      activeFrames,
    ),
    partialTimbreMaeDb: matrixProfileMae(
      reference.partialProfiles,
      synthesized.partialProfiles,
      -60,
      activeFrames,
      reliablePartialCount,
    ),
    partialDecayMaeDb: decayMatrixMae(
      reference.partialPowers,
      synthesized.partialPowers,
      -45,
      reliablePartialCount,
    ),
    multibandDecayMaeDb: decayMatrixMae(
      reference.sustainBandPowers,
      synthesized.sustainBandPowers,
      -48,
    ),
    broadbandDecayMaeDb: broadbandDecayMae(reference.sustainRms, synthesized.sustainRms),
    harmonicityMaeDb: vectorMae(
      reference.harmonicityDb.filter((_, index) => activeFrames[index]),
      synthesized.harmonicityDb.filter((_, index) => activeFrames[index]),
    ),
    modulationDifferenceDb: modulationDifference,
    crestDifferenceDb: Math.abs(reference.earlyCrestDb - synthesized.earlyCrestDb),
    timeVaryingCentroidDifferenceCents: mean(centroidDifferences),
    partialLocationMaeCents: inharmonicStretchDifference(reference, synthesized),
    synthesizedPitchCents: centsDifference(synthesized.fundamentalHz, synthesized.expectedHz),
    referencePitchCents: centsDifference(reference.fundamentalHz, reference.expectedHz),
    diagnosticSurfaces: {
      transientSpectrumSignedDb: signedProfileMatrix(
        reference.transientProfiles,
        synthesized.transientProfiles,
      ),
      sustainSpectrumSignedDb: signedProfileMatrix(
        reference.sustainProfiles,
        synthesized.sustainProfiles,
        activeFrames,
      ),
      partialTimbreSignedDb: signedProfileMatrix(
        reference.partialProfiles,
        synthesized.partialProfiles,
        activeFrames,
      ),
      multibandDecaySignedDb: signedDecayMatrix(
        reference.sustainBandPowers,
        synthesized.sustainBandPowers,
      ),
      partialDecaySignedDb: signedDecayMatrix(
        reference.partialPowers,
        synthesized.partialPowers,
      ),
      broadbandDecaySignedDb: reference.sustainRms.map((value, frame) =>
        frame <= 1
          ? null
          : clippedDbAmplitude(
              synthesized.sustainRms[frame] /
                Math.max(synthesized.sustainRms[1], Number.MIN_VALUE),
              -90,
            ) - clippedDbAmplitude(
              value / Math.max(reference.sustainRms[1], Number.MIN_VALUE),
              -90,
            )),
      harmonicitySignedDb: reference.harmonicityDb.map((value, frame) =>
        activeFrames[frame] ? synthesized.harmonicityDb[frame] - value : null),
    },
  };
}

function registerName(midi) {
  if (midi < 48) return 'bass';
  if (midi < 76) return 'middle';
  return 'treble';
}

function ranks(values) {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Float64Array(values.length);
  let lower = 0;
  while (lower < sorted.length) {
    let upper = lower + 1;
    while (upper < sorted.length && sorted[upper].value === sorted[lower].value) upper += 1;
    const rank = (lower + upper - 1) / 2;
    for (let index = lower; index < upper; index += 1) result[sorted[index].index] = rank;
    lower = upper;
  }
  return [...result];
}

function pearson(first, second) {
  if (first.length !== second.length || first.length < 2) return Number.NaN;
  const firstMean = mean(first);
  const secondMean = mean(second);
  let covariance = 0;
  let firstVariance = 0;
  let secondVariance = 0;
  for (let index = 0; index < first.length; index += 1) {
    const firstCentered = first[index] - firstMean;
    const secondCentered = second[index] - secondMean;
    covariance += firstCentered * secondCentered;
    firstVariance += firstCentered ** 2;
    secondVariance += secondCentered ** 2;
  }
  return firstVariance > 0 && secondVariance > 0
    ? covariance / Math.sqrt(firstVariance * secondVariance)
    : Number.NaN;
}

function spearman(first, second) {
  return pearson(ranks(first), ranks(second));
}

function metricSummary(pairs) {
  const fields = [
    'levelResidualDb',
    'attackPeakDifferenceMs',
    'attackEnvelopeMaeDb',
    'attackEnergyQuantileMaeMs',
    'transientSpectrumMaeDb',
    'sustainSpectrumMaeDb',
    'partialTimbreMaeDb',
    'partialDecayMaeDb',
    'multibandDecayMaeDb',
    'broadbandDecayMaeDb',
    'harmonicityMaeDb',
    'modulationDifferenceDb',
    'crestDifferenceDb',
    'timeVaryingCentroidDifferenceCents',
    'partialLocationMaeCents',
  ];
  return Object.fromEntries(fields.map((field) => [
    field,
    summarize(pairs.map((pair) => Math.abs(pair[field]))),
  ]));
}

function velocitySurfaceSummaries(pairs) {
  const notes = [...new Set(pairs.map(({ note }) => note))];
  return notes.map((note) => {
    const notePairs = pairs.filter((pair) => pair.note === note).sort((a, b) => a.layer - b.layer);
    return {
      note,
      midi: notePairs[0].midi,
      levelCorrelation: pearson(
        notePairs.map(({ referenceEarlyRms }) => dbAmplitude(referenceEarlyRms)),
        notePairs.map(({ synthesizedEarlyRms }) => dbAmplitude(synthesizedEarlyRms)),
      ),
      brightnessCorrelation: spearman(
        notePairs.map(({ referenceCentroidHz }) => referenceCentroidHz),
        notePairs.map(({ synthesizedCentroidHz }) => synthesizedCentroidHz),
      ),
      maximumLevelResidualDb: Math.max(...notePairs.map(({ levelResidualDb }) =>
        Math.abs(levelResidualDb))),
    };
  });
}

function medianSurface(pairs, surfaceName) {
  const surfaces = pairs.map(({ diagnosticSurfaces }) => diagnosticSurfaces[surfaceName]);
  const rows = Math.max(...surfaces.map((surface) => surface.length));
  const result = [];
  for (let row = 0; row < rows; row += 1) {
    const columns = Math.max(...surfaces.map((surface) =>
      Array.isArray(surface[row]) ? surface[row].length : 1));
    if (columns === 1 && !Array.isArray(surfaces[0][row])) {
      result.push(round(median(surfaces.map((surface) => surface[row]))));
      continue;
    }
    const current = [];
    for (let column = 0; column < columns; column += 1) {
      current.push(round(median(surfaces.map((surface) => surface[row]?.[column]))));
    }
    result.push(current);
  }
  return result;
}

function signedResidualSummary(pairs) {
  return {
    transientSpectrumSignedDb: medianSurface(pairs, 'transientSpectrumSignedDb'),
    sustainSpectrumSignedDb: medianSurface(pairs, 'sustainSpectrumSignedDb'),
    partialTimbreSignedDb: medianSurface(pairs, 'partialTimbreSignedDb'),
    multibandDecaySignedDb: medianSurface(pairs, 'multibandDecaySignedDb'),
    partialDecaySignedDb: medianSurface(pairs, 'partialDecaySignedDb'),
    broadbandDecaySignedDb: medianSurface(pairs, 'broadbandDecaySignedDb'),
    harmonicitySignedDb: medianSurface(pairs, 'harmonicitySignedDb'),
  };
}

function boundedQuality(value, fullCredit, zeroCredit) {
  if (!Number.isFinite(value)) return 0;
  if (value <= fullCredit) return 1;
  if (value >= zeroCredit) return 0;
  return 1 - (value - fullCredit) / (zeroCredit - fullCredit);
}

function lowerBoundQuality(value, fullCredit, zeroCredit) {
  if (!Number.isFinite(value)) return 0;
  if (value >= fullCredit) return 1;
  if (value <= zeroCredit) return 0;
  return (value - zeroCredit) / (fullCredit - zeroCredit);
}

function chromaticReferenceKey(region) {
  return `${region.midi}:${region.layer}`;
}

function chromaticPlaybackRate(region, tuneCents) {
  return 2 ** ((100 * region.transpositionSemitones + tuneCents) / 1_200);
}

async function extractChromaticReferenceFeatures({ region, tuneCents }) {
  const wav = await readWav(path.join(sampleRoot, region.file), {
    preserveChannels: true,
  });
  if (wav.sampleRate !== SAMPLE_RATE || wav.channels !== 2 || wav.bitsPerSample !== 16) {
    throw new Error(`${region.file}: expected stereo PCM16 at ${SAMPLE_RATE} Hz`);
  }

  const playbackRate = chromaticPlaybackRate(region, tuneCents);
  const tailLength = Math.round(REFERENCE_NOISE_TAIL_SECONDS * SAMPLE_RATE);
  const channels = wav.channelSamples.map((channel) => {
    const combined = new Float32Array(MAX_REFERENCE_FRAMES + tailLength);
    combined.set(resampleChannel(channel, playbackRate, MAX_REFERENCE_FRAMES));
    const tailSourceOffset = Math.max(0, channel.length - tailLength * playbackRate);
    combined.set(
      resampleChannel(channel, playbackRate, tailLength, tailSourceOffset),
      MAX_REFERENCE_FRAMES,
    );
    return combined;
  });
  const expectedHz = midiToFrequency(region.midi);
  return {
    key: chromaticReferenceKey(region),
    file: region.file,
    note: region.note,
    midi: region.midi,
    layer: region.layer,
    sourceNote: region.sourceNote,
    sourceMidi: region.sourceMidi,
    transpositionSemitones: region.transpositionSemitones,
    tuneCents,
    playbackRate,
    features: {
      ...extractFeatures(channels, SAMPLE_RATE, expectedHz, {
        estimateNoiseFloor: true,
      }),
      expectedHz,
    },
  };
}

async function cacheSignature(regions, sfzText, retunedText) {
  const first = await stat(path.join(sampleRoot, regions[0].file));
  const last = await stat(path.join(sampleRoot, regions.at(-1).file));
  const hash = createHash('sha256')
    .update(`${CACHE_SCHEMA_VERSION}\n${RENDER_SECONDS}\n${sfzText}\n${retunedText}\n`);
  if (chromaticMode) {
    hash.update(
      `chromatic-v1:${REFERENCE_NOISE_TAIL_SECONDS}:lanczos-12x1024\n`,
    );
  }
  return hash
    .update(`${first.size}:${first.mtimeMs}:${last.size}:${last.mtimeMs}`)
    .digest('hex');
}

async function buildReferenceCache(regions, tuneByFile, signature) {
  const entries = [];
  let completed = 0;
  for (const region of regions) {
    const wav = await readWav(path.join(sampleRoot, region.file), {
      preserveChannels: true,
    });
    if (wav.sampleRate !== SAMPLE_RATE || wav.channels !== 2 || wav.bitsPerSample !== 16) {
      throw new Error(`${region.file}: expected stereo PCM16 at ${SAMPLE_RATE} Hz`);
    }
    const nominalHz = midiToFrequency(region.midi);
    const tuneCents = tuneByFile.get(region.file) ?? 0;
    const rawExpectedHz = nominalHz / 2 ** (tuneCents / 1_200);
    entries.push({
      file: region.file,
      features: {
        ...extractFeatures(wav.channelSamples, wav.sampleRate, rawExpectedHz, {
          estimateNoiseFloor: true,
        }),
        expectedHz: rawExpectedHz,
      },
    });
    completed += 1;
    if (completed % 16 === 0 || completed === regions.length) {
      process.stdout.write(`\rmeasured reference features ${completed}/${regions.length}`);
    }
  }
  process.stdout.write('\n');
  const cache = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    signature,
    method: {
      decodedSeconds: RENDER_SECONDS,
      onsetEnvelope: '4 ms power-RMS windows at 2 ms hops through 120 ms',
      transientSpectrum: 'five onset-aligned windows from 0–110 ms in 14 auditory bands',
      sustainSpectrum: `${SUSTAIN_STARTS_SECONDS.length} adaptive windows at ${SUSTAIN_STARTS_SECONDS.join(', ')} seconds`,
      partials: 'up to 16 locally resolved stiff-string partials, tracked through all sustain windows',
      modulation: 'detrended narrowband fundamental envelope from 0.12–1.85 seconds',
    },
    entries,
  };
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache)}\n`);
  console.log(`wrote ${path.relative(root, cachePath)}`);
  return cache;
}

async function buildChromaticReferenceCache(jobs, signature) {
  const workerCount = comparisonWorkerCount(process.argv.slice(2), jobs.length);
  const entries = await parallelMap({
    items: jobs,
    moduleUrl: new URL(import.meta.url),
    task: CHROMATIC_REFERENCE_WORKER_TASK,
    workerCount,
    localMapper: extractChromaticReferenceFeatures,
    onProgress: progressReporter(
      'measured chromatic reference features',
      jobs.length,
      workerCount,
      8,
    ),
  });
  process.stdout.write('\n');
  const cache = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    signature,
    method: {
      decodedSeconds: RENDER_SECONDS,
      referencePlayback:
        'All 88 SFZ key mappings at layers 1, 8, and 16; Retuned-SFZ tune cents; deterministic 12-tap, 1024-phase Lanczos resampling.',
      noiseFloor:
        `${REFERENCE_NOISE_TAIL_SECONDS} seconds from each source tail are resampled separately for noise-floor estimation.`,
      onsetEnvelope: '4 ms power-RMS windows at 2 ms hops through 120 ms',
      transientSpectrum: 'five onset-aligned windows from 0–110 ms in 14 auditory bands',
      sustainSpectrum: `${SUSTAIN_STARTS_SECONDS.length} adaptive windows at ${SUSTAIN_STARTS_SECONDS.join(', ')} seconds`,
      partials: 'up to 16 locally resolved stiff-string partials, tracked through all sustain windows',
      modulation: 'detrended narrowband fundamental envelope from 0.12–1.85 seconds',
    },
    entries,
  };
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache)}\n`);
  console.log(`wrote ${path.relative(root, cachePath)}`);
  return cache;
}

async function loadOrBuildReferenceCache(regions, tuneByFile, signature, chromaticJobs) {
  const expectedEntries = chromaticJobs?.length ?? regions.length;
  if (!rebuildCache) {
    try {
      const cache = JSON.parse(await readFile(cachePath, 'utf8'));
      if (
        cache.schemaVersion === CACHE_SCHEMA_VERSION &&
        cache.signature === signature &&
        cache.entries.length === expectedEntries
      ) {
        console.log(`loaded ${path.relative(root, cachePath)}`);
        return cache;
      }
    } catch {
      // A missing, stale, or interrupted cache is safely rebuilt from source audio.
    }
  }
  return chromaticJobs
    ? buildChromaticReferenceCache(chromaticJobs, signature)
    : buildReferenceCache(regions, tuneByFile, signature);
}

function serializePair(pair) {
  const fields = [
    'velocity',
    'referenceCentroidHz',
    'synthesizedCentroidHz',
    'levelResidualDb',
    'attackPeakDifferenceMs',
    'attackEnvelopeMaeDb',
    'attackEnergyQuantileMaeMs',
    'transientSpectrumMaeDb',
    'sustainSpectrumMaeDb',
    'partialTimbreMaeDb',
    'partialDecayMaeDb',
    'multibandDecayMaeDb',
    'broadbandDecayMaeDb',
    'harmonicityMaeDb',
    'modulationDifferenceDb',
    'crestDifferenceDb',
    'timeVaryingCentroidDifferenceCents',
    'partialLocationMaeCents',
    'referencePitchCents',
    'synthesizedPitchCents',
  ];
  const spectralRows = [
    ...pair.diagnosticSurfaces.transientSpectrumSignedDb,
    ...pair.diagnosticSurfaces.sustainSpectrumSignedDb,
  ];
  const spectralZones = [[0, 5], [5, 8], [8, 10], [10, 14]].map(([start, end]) =>
    median(spectralRows.flatMap((row) => row.slice(start, end))));
  const subBassResidual =
    median(spectralRows.flatMap((row) => row.slice(0, 2))) -
    median(spectralRows.flatMap((row) => row.slice(2, 5)));
  const airResidual =
    median(spectralRows.flatMap((row) => row.slice(12, 14))) -
    median(spectralRows.flatMap((row) => row.slice(10, 12)));
  const sustainBandResidualDb = Array.from({ length: AUDITORY_BAND_EDGES_HZ.length - 1 },
    (_, band) => median(
      pair.diagnosticSurfaces.sustainSpectrumSignedDb.map((row) => row[band]),
    ));
  const transientBandResidualDb = Array.from({ length: AUDITORY_BAND_EDGES_HZ.length - 1 },
    (_, band) => median(
      pair.diagnosticSurfaces.transientSpectrumSignedDb.map((row) => row[band]),
    ));
  const partialTimbreResidualDb = Array.from({ length: 16 }, (_, partial) =>
    median(pair.diagnosticSurfaces.partialTimbreSignedDb.map((row) => row[partial])));
  const decaySlope = (surface, start, end) => {
    let numerator = 0;
    let denominator = 0;
    for (let frame = 2; frame < surface.length; frame += 1) {
      const elapsed = SUSTAIN_STARTS_SECONDS[frame] - SUSTAIN_STARTS_SECONDS[1];
      const residual = median(surface[frame].slice(start, end));
      if (!Number.isFinite(residual)) continue;
      numerator += elapsed * residual;
      denominator += elapsed * elapsed;
    }
    return denominator > 0 ? numerator / denominator : Number.NaN;
  };
  const decaySurface = pair.diagnosticSurfaces.multibandDecaySignedDb;
  return {
    file: pair.file,
    note: pair.note,
    midi: pair.midi,
    ...(pair.referenceResampled
      ? {
          sourceNote: pair.sourceNote,
          sourceMidi: pair.sourceMidi,
          transpositionSemitones: pair.transpositionSemitones,
          sfzTuneCents: pair.tuneCents,
          referencePlaybackRate: round(pair.referencePlaybackRate, 8),
          directSamplePitch: pair.transpositionSemitones === 0,
        }
      : {}),
    layer: pair.layer,
    register: pair.register,
    spectralBalanceResidualDb: {
      subBass: round(subBassResidual),
      low: round(spectralZones[0] - spectralZones[1]),
      center: round(spectralZones[1] - spectralZones[2]),
      high: round(spectralZones[3] - spectralZones[2]),
      air: round(airResidual),
    },
    sustainBandResidualDb: sustainBandResidualDb.map((value) => round(value)),
    transientBandResidualDb: transientBandResidualDb.map((value) => round(value)),
    partialTimbreResidualDb: partialTimbreResidualDb.map((value) => round(value)),
    partialDecayResidualDb: pair.diagnosticSurfaces.partialDecaySignedDb.map(
      (row) => row.map((value) => round(value)),
    ),
    decaySlopeResidualDbPerSecond: {
      low: round(decaySlope(decaySurface, 0, 5)),
      center: round(decaySlope(decaySurface, 5, 8)),
      mid: round(decaySlope(decaySurface, 8, 10)),
      high: round(decaySlope(decaySurface, 10, 14)),
    },
    decaySlopeResidualDbPerSecondBands: Array.from(
      { length: AUDITORY_BAND_EDGES_HZ.length - 1 },
      (_, band) => round(decaySlope(decaySurface, band, band + 1)),
    ),
    ...Object.fromEntries(fields.map((field) => [field, round(pair[field])])),
  };
}

function extractSynthesizedFeatures(region) {
  const nominalHz = midiToFrequency(region.midi);
  const velocity = (region.velocityLow + region.velocityHigh) / (2 * 127);
  const samples = synthesizeGrandPiano(nominalHz, velocity, RENDER_SECONDS);
  return {
    ...extractFeatures([samples], SAMPLE_RATE, nominalHz),
    expectedHz: nominalHz,
  };
}

function progressReporter(label, total, workerCount, interval) {
  let lastReported = 0;
  return (completed) => {
    if (completed !== total && completed - lastReported < interval) return;
    lastReported = completed;
    process.stdout.write(
      `\r${label} ${completed}/${total} (${workerCount} ${workerCount === 1 ? 'job' : 'jobs'})`,
    );
  };
}

async function main() {
  if (chromaticMode && quickMode) {
    throw new Error('--chromatic already selects three layers; it cannot be combined with --quick');
  }
  try {
    await access(sfzPath);
    await access(retunedSfzPath);
  } catch {
    console.log('SKIP strict reference fidelity: supplied SFZ/reference folder is absent');
    return;
  }

  const [sfzText, retunedText] = await Promise.all([
    readFile(sfzPath, 'utf8'),
    readFile(retunedSfzPath, 'utf8'),
  ]);
  const regions = parseSustainRegions(sfzText);
  const retunedRegions = parseSustainRegions(retunedText);
  const tuneByFile = new Map(retunedRegions.map((region) => [
    region.file,
    region.tuneCents,
  ]));
  const chromaticJobs = chromaticMode
    ? buildChromaticJobs(regions, tuneByFile)
    : undefined;
  const analysisRegions = chromaticMode
    ? chromaticJobs.map(({ region }) => region)
    : quickMode
      ? regions.filter(({ layer }) => [1, 6, 11, 16].includes(layer))
      : regions;
  const signature = await cacheSignature(regions, sfzText, retunedText);
  const referenceCache = await loadOrBuildReferenceCache(
    regions,
    tuneByFile,
    signature,
    chromaticJobs,
  );
  const referenceByKey = new Map(referenceCache.entries.map((entry) => [
    entry.key ?? entry.file,
    entry,
  ]));
  const workerCount = comparisonWorkerCount(process.argv.slice(2), analysisRegions.length);
  const synthesizedFeatures = await parallelMap({
    items: analysisRegions,
    moduleUrl: new URL(import.meta.url),
    task: SYNTHESIS_WORKER_TASK,
    workerCount,
    localMapper: extractSynthesizedFeatures,
    onProgress: progressReporter(
      'extracted strict synth features',
      analysisRegions.length,
      workerCount,
      16,
    ),
  });
  process.stdout.write('\n');
  const pairs = [];
  for (let index = 0; index < analysisRegions.length; index += 1) {
    const region = analysisRegions[index];
    const velocity = (region.velocityLow + region.velocityHigh) / (2 * 127);
    const synthesized = synthesizedFeatures[index];
    const referenceEntry = referenceByKey.get(
      chromaticMode ? chromaticReferenceKey(region) : region.file,
    );
    if (!referenceEntry) throw new Error(`Missing reference features for ${region.note} layer ${region.layer}`);
    const reference = referenceEntry.features;
    const comparison = compareFeatures(reference, synthesized);
    pairs.push({
      ...region,
      tuneCents: referenceEntry.tuneCents,
      referencePlaybackRate: referenceEntry.playbackRate,
      velocity,
      register: registerName(region.midi),
      referenceEarlyRms: reference.earlyRms,
      synthesizedEarlyRms: synthesized.earlyRms,
      referenceCentroidHz: mean(reference.centroidsHz.slice(0, 3)),
      synthesizedCentroidHz: mean(synthesized.centroidsHz.slice(0, 3)),
      ...comparison,
    });
  }

  // One robust calibration offset is allowed for microphone/output gain. No
  // per-note, per-register, or per-velocity level normalization is permitted.
  const globalLevelOffsetDb = median(pairs.map(({ rawLevelDifferenceDb }) => rawLevelDifferenceDb));
  for (const pair of pairs) pair.levelResidualDb = pair.rawLevelDifferenceDb - globalLevelOffsetDb;

  const overall = metricSummary(pairs);
  const byRegister = Object.fromEntries(['bass', 'middle', 'treble'].map((register) => [
    register,
    metricSummary(pairs.filter((pair) => pair.register === register)),
  ]));
  const byLayer = Object.fromEntries([...new Set(pairs.map(({ layer }) => layer))].map((layer) => [
    layer,
    metricSummary(pairs.filter((pair) => pair.layer === layer)),
  ]));
  const velocitySurfaces = velocitySurfaceSummaries(pairs);
  const velocityAggregate = {
    levelCorrelation: summarize(velocitySurfaces.map(({ levelCorrelation }) => levelCorrelation)),
    brightnessCorrelation: summarize(
      velocitySurfaces.map(({ brightnessCorrelation }) => brightnessCorrelation),
    ),
    maximumLevelResidualByNoteDb: summarize(
      velocitySurfaces.map(({ maximumLevelResidualDb }) => maximumLevelResidualDb),
    ),
  };

  const checks = [];
  function addErrorCheck(category, name, weight, summary, medianFull, medianZero, p90Full, p90Zero, proxy) {
    const quality = mean([
      boundedQuality(summary.median, medianFull, medianZero),
      boundedQuality(summary.p90, p90Full, p90Zero),
    ]);
    checks.push({
      category,
      name,
      weight,
      earned: round(weight * quality, 3),
      passed: summary.median <= medianFull && summary.p90 <= p90Full,
      actual: summary,
      target: `median <=${medianFull}, p90 <=${p90Full}`,
      proxy,
    });
  }

  checks.push({
    category: 'coverage',
    name: chromaticMode
      ? 'all 88 SFZ-mapped keys are independently analyzed at low, midpoint, and hard velocity'
      : 'every supplied sustain recording is independently analyzed',
    weight: 5,
    earned:
      pairs.length === analysisRegions.length &&
      referenceCache.entries.length === (chromaticMode ? 264 : 480)
        ? 5
        : 0,
    passed:
      pairs.length === analysisRegions.length &&
      referenceCache.entries.length === (chromaticMode ? 264 : 480),
    actual: { references: referenceCache.entries.length, synthesizedRenders: pairs.length },
    target: chromaticMode
      ? '264 SFZ-playback references and fresh renders = 88 pitches × layers 1, 8, and 16'
      : quickMode
      ? '120 representative renders (30 pitches × layers 1, 6, 11, 16) backed by the 480-reference cache'
      : '480 references and 480 new procedural renders',
    proxy: 'Direct coverage criterion.',
  });
  addErrorCheck('level', 'one global gain aligns loudness over pitch and velocity', 10,
    overall.levelResidualDb, 2, 8, 5, 14,
    '0.02–0.50 s stereo-power RMS; one median offset only, preserving all cross-note differences.');
  addErrorCheck('attack', 'fine-grained 120 ms attack envelope converges', 8,
    overall.attackEnvelopeMaeDb, 2.5, 7, 5.5, 12,
    'Sixty 4 ms RMS measurements replace the old five-bin onset summary.');
  addErrorCheck('attack', 'attack energy accumulation timing converges', 4,
    overall.attackEnergyQuantileMaeMs, 6, 20, 16, 45,
    'Differences at 10%, 50%, and 90% of first-120-ms energy.');
  addErrorCheck('transient', 'hammer/board spectrum converges through 110 ms', 13,
    overall.transientSpectrumMaeDb, 4.5, 10, 8, 16,
    'Five time-localized 14-band spectra; frame energy is normalized but spectral shape is not collapsed to centroid.');
  addErrorCheck('spectrum', 'auditory-band color converges over 2.05 seconds', 12,
    overall.sustainSpectrumMaeDb, 4, 10, 7, 15,
    'Seven adaptive-window spectral profiles expose time-varying color rather than one long FFT.');
  addErrorCheck('spectrum', 'resolved partial balance converges over time', 9,
    overall.partialTimbreMaeDb, 4, 10, 7, 15,
    'Up to 16 partials are normalized within each of seven time frames.');
  addErrorCheck('spectrum', 'stiff-string partial locations converge', 5,
    overall.partialLocationMaeCents, 4, 18, 12, 45,
    'Strong partial stretch relative to each measured fundamental; phase and tuning offset are removed.');
  addErrorCheck('decay', 'individual partial decay trajectories converge', 8,
    overall.partialDecayMaeDb, 4, 12, 8, 20,
    'Every audible partial is normalized at 80 ms and followed to 2.05 seconds.');
  addErrorCheck('decay', 'frequency-dependent decay trajectories converge', 7,
    overall.multibandDecayMaeDb, 4, 12, 8, 20,
    'Auditory bands are independently normalized, preventing broadband RMS from hiding wrong spectral decay.');
  addErrorCheck('decay', 'broadband two-stage energy loss converges', 3,
    overall.broadbandDecayMaeDb, 3, 9, 6, 15,
    'Adaptive RMS frames through 2.05 seconds.');
  addErrorCheck('texture', 'harmonic-to-residual balance converges', 5,
    overall.harmonicityMaeDb, 4, 12, 9, 22,
    'Resolved partial energy versus non-partial hammer/body energy in every sustain frame.');
  addErrorCheck('texture', 'fundamental beating/modulation converges', 3,
    overall.modulationDifferenceDb, 2.5, 8, 6, 14,
    'Linear decay is removed from a narrowband 0.12–1.85 s envelope before modulation depth and roughness are compared.');

  const minimumLevelCorrelation = percentile(
    velocitySurfaces.map(({ levelCorrelation }) => levelCorrelation),
    0.1,
  );
  const minimumBrightnessCorrelation = percentile(
    velocitySurfaces.map(({ brightnessCorrelation }) => brightnessCorrelation),
    0.1,
  );
  const worstRegisterP90 = Math.max(...Object.values(byRegister).flatMap((summary) => [
    summary.transientSpectrumMaeDb.p90,
    summary.sustainSpectrumMaeDb.p90,
    summary.partialTimbreMaeDb.p90,
    summary.partialDecayMaeDb.p90,
  ]));
  const surfaceQuality = mean([
    lowerBoundQuality(minimumLevelCorrelation, 0.96, 0.75),
    lowerBoundQuality(minimumBrightnessCorrelation, 0.9, 0.5),
    boundedQuality(worstRegisterP90, 10, 22),
  ]);
  checks.push({
    category: 'surfaces',
    name: 'velocity curves and every register converge without hidden buckets',
    weight: 8,
    earned: round(8 * surfaceQuality, 3),
    passed:
      minimumLevelCorrelation >= 0.96 &&
      minimumBrightnessCorrelation >= 0.9 &&
      worstRegisterP90 <= 10,
    actual: {
      tenthPercentileLevelCorrelation: round(minimumLevelCorrelation),
      tenthPercentileBrightnessCorrelation: round(minimumBrightnessCorrelation),
      worstRegisterCriticalMetricP90: round(worstRegisterP90),
    },
    target: '10th-percentile level correlation >=0.96, brightness >=0.90, worst critical register p90 <=10',
    proxy: 'Cross-layer correlations and register-specific tails prevent favorable global medians from masking scale regions.',
  });

  const possible = checks.reduce((sum, check) => sum + check.weight, 0);
  const score = round(checks.reduce((sum, check) => sum + check.earned, 0), 2);
  if (possible !== 100) throw new Error(`strict fidelity weights total ${possible}, expected 100`);
  const failedCriticalChecks = checks.filter((check) => !check.passed).length;
  const compositeFields = [
    ['attackEnvelopeMaeDb', 2.5],
    ['transientSpectrumMaeDb', 4.5],
    ['sustainSpectrumMaeDb', 4],
    ['partialTimbreMaeDb', 4],
    ['partialDecayMaeDb', 4],
    ['multibandDecayMaeDb', 4],
    ['harmonicityMaeDb', 4],
  ];
  for (const pair of pairs) {
    pair.compositeError = mean(compositeFields.map(([field, target]) => pair[field] / target));
  }
  const worstPairs = [...pairs]
    .sort((a, b) => b.compositeError - a.compositeError)
    .slice(0, 30)
    .map((pair) => ({ ...serializePair(pair), compositeError: round(pair.compositeError) }));

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    passThreshold: PASS_THRESHOLD,
    score,
    possible,
    failedCriticalChecks,
    passed: score >= PASS_THRESHOLD && failedCriticalChecks === 0,
    baselineIntent: chromaticMode
      ? 'This companion strict suite exposes interpolation behavior on every key while sampling low, midpoint, and hard velocity; it uses the same stretch targets as the 480-recorded-root suite.'
      : 'This score deliberately supersedes the permissive 100-point grid. It is expected to fail until time-varying timbre, decay, texture, and global level residuals are corrected.',
    source: {
      sfz: path.relative(root, sfzPath),
      retunedSfz: path.relative(root, retunedSfzPath),
      referenceFeatureCache: path.relative(root, cachePath),
      cacheSignature: signature,
      audioPolicy:
        'Reference WAVs are decoded only by this development tool. The cache contains scalar/time-frequency measurements, not PCM, and runtime synthesis reads neither.',
    },
    method: {
      renderSeconds: RENDER_SECONDS,
      alignment: 'independent causal 3 ms RMS onset detection; all temporal comparisons are onset-relative',
      gain: `one robust global synth/reference offset (${round(globalLevelOffsetDb)} dB); no per-note, per-register, or per-layer normalization for level`,
      ...(chromaticMode
        ? {
            referencePlayback:
              'All SFZ key-zone transpositions and Retuned-SFZ tune cents are applied with deterministic 12-tap, 1024-phase Lanczos resampling before feature extraction.',
            velocitySampling:
              'Layers 1, 8, and 16 are rendered at their SFZ range midpoints, representing low, lower-median, and highest recorded velocity.',
          }
        : {}),
      referenceStereo: 'left/right spectra and RMS energies are power-averaged; waveform phase is not scored',
      attackEnvelope: '4 ms power-RMS windows every 2 ms from 0–120 ms, locally peak-normalized',
      attackTiming: '10%, 50%, and 90% cumulative-energy times in the first 120 ms',
      transientSpectrum: `${TRANSIENT_WINDOWS_SECONDS.length} independent auditory-band profiles spanning 0–110 ms`,
      sustainSpectrum: `${SUSTAIN_STARTS_SECONDS.length} profiles from 25 ms–2.05 s using 6-cycle windows clamped to 46–180 ms`,
      partials: 'up to 16 local partial peaks; frame-wise balance plus per-partial decay and long-window location stretch',
      decay: 'broadband, per-auditory-band, and per-partial changes, all normalized once at 80 ms',
      texture: 'harmonic-to-residual ratio plus detrended fundamental modulation depth/roughness',
      limitations:
        'These are perceptual proxies, not a claim of waveform identity. They intentionally ignore source microphone phase/stereo image, and level permits one global output-gain calibration.',
    },
    coverage: chromaticMode
      ? {
          references: referenceCache.entries.length,
          synthesizedRenders: pairs.length,
          pitches: new Set(pairs.map(({ midi }) => midi)).size,
          velocityLayers: new Set(pairs.map(({ layer }) => layer)).size,
          layers: [...new Set(pairs.map(({ layer }) => layer))],
          uniqueSourceRecordings: new Set(pairs.map(({ file }) => file)).size,
          directSampleEvaluations: pairs.filter(({ transpositionSemitones }) =>
            transpositionSemitones === 0).length,
          transposedSampleEvaluations: pairs.filter(({ transpositionSemitones }) =>
            transpositionSemitones !== 0).length,
          chromaticMode: true,
          quickMode: false,
        }
      : {
          references: referenceCache.entries.length,
          synthesizedRenders: pairs.length,
          pitches: new Set(pairs.map(({ midi }) => midi)).size,
          velocityLayers: new Set(pairs.map(({ layer }) => layer)).size,
          quickMode,
        },
    globalLevelOffsetDb: round(globalLevelOffsetDb),
    overall,
    byRegister,
    byLayer,
    signedResiduals: {
      overall: signedResidualSummary(pairs),
      byRegister: Object.fromEntries(['bass', 'middle', 'treble'].map((register) => [
        register,
        signedResidualSummary(pairs.filter((pair) => pair.register === register)),
      ])),
      byLayer: Object.fromEntries([...new Set(pairs.map(({ layer }) => layer))].map((layer) => [
        layer,
        signedResidualSummary(pairs.filter((pair) => pair.layer === layer)),
      ])),
      byRegisterAndLayer: Object.fromEntries(['bass', 'middle', 'treble'].flatMap((register) =>
        [...new Set(pairs.map(({ layer }) => layer))].map((layer) => [
          `${register}:${layer}`,
          signedResidualSummary(pairs.filter((pair) =>
            pair.register === register && pair.layer === layer)),
        ]))),
      byNote: Object.fromEntries([...new Set(pairs.map(({ note }) => note))].map((note) => [
        note,
        signedResidualSummary(pairs.filter((pair) => pair.note === note)),
      ])),
    },
    velocityAggregate,
    velocityByNote: velocitySurfaces.map((item) => Object.fromEntries(
      Object.entries(item).map(([key, value]) => [key, typeof value === 'number' ? round(value) : value]),
    )),
    checks,
    worstPairs,
    comparisons: pairs.map(serializePair),
  };

  const suiteName = chromaticMode
    ? 'Chromatic strict reference fidelity'
    : 'Strict reference fidelity';
  console.log(`${suiteName}: ${score}/100 ${report.passed ? 'PASS' : 'FAIL'}`);
  console.log(`  global level residual     median ${overall.levelResidualDb.median} dB, p90 ${overall.levelResidualDb.p90} dB`);
  console.log(`  attack envelope           median ${overall.attackEnvelopeMaeDb.median} dB, p90 ${overall.attackEnvelopeMaeDb.p90} dB`);
  console.log(`  transient spectrum        median ${overall.transientSpectrumMaeDb.median} dB, p90 ${overall.transientSpectrumMaeDb.p90} dB`);
  console.log(`  sustain spectrum          median ${overall.sustainSpectrumMaeDb.median} dB, p90 ${overall.sustainSpectrumMaeDb.p90} dB`);
  console.log(`  partial timbre            median ${overall.partialTimbreMaeDb.median} dB, p90 ${overall.partialTimbreMaeDb.p90} dB`);
  console.log(`  partial decay             median ${overall.partialDecayMaeDb.median} dB, p90 ${overall.partialDecayMaeDb.p90} dB`);
  console.log(`  multiband decay           median ${overall.multibandDecayMaeDb.median} dB, p90 ${overall.multibandDecayMaeDb.p90} dB`);
  console.log(`  harmonic/residual         median ${overall.harmonicityMaeDb.median} dB, p90 ${overall.harmonicityMaeDb.p90} dB`);
  console.log(`  partial locations         median ${overall.partialLocationMaeCents.median} c, p90 ${overall.partialLocationMaeCents.p90} c`);
  for (const check of checks.filter((check) => !check.passed)) {
    console.log(`  FAIL ${check.category}: ${check.name}`);
  }
  if (shouldWrite) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${path.relative(root, reportPath)}`);
  }
  if (!noFail && !report.passed) process.exitCode = 1;
}

if (!isMainThread && workerData?.task === CHROMATIC_REFERENCE_WORKER_TASK) {
  await serveParallelMap(workerData.jobs, extractChromaticReferenceFeatures, 1);
} else if (!isMainThread && workerData?.task === SYNTHESIS_WORKER_TASK) {
  await serveParallelMap(workerData.jobs, extractSynthesizedFeatures);
} else if (
  isMainThread &&
  path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)
) {
  await main();
}
