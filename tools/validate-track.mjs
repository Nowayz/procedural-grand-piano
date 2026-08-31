#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE_RATE } from '../src/grand-piano.js';
import { readWav, rmsBetween, signalStats } from './audio-analysis.mjs';
import {
  buildBwv846Performance,
  SCORE_PROVENANCE,
  TRACK_TITLE,
} from './bwv846-performance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const trackPath = path.join(root, 'demos', 'bach-bwv846-prelude-procedural.wav');
const reportPath = path.join(root, 'reports', 'public-domain-track.json');
const performance = buildBwv846Performance();
const file = await readFile(trackPath);
const wav = await readWav(trackPath, { preserveChannels: true });
const [left, right] = wav.channelSamples;
const leftStats = signalStats(left);
const rightStats = signalStats(right);
const durationSeconds = left.length / wav.sampleRate;
const expectedFrames = Math.round(performance.durationSeconds * SAMPLE_RATE);
const checks = [];

function check(name, passed, details) {
  checks.push({ name, passed, details });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}: ${details}`);
}

check('score completeness', performance.measureCount === 35 && performance.events.length === 549,
  `${performance.measureCount} measures, ${performance.events.length} note events`);
check('WAV format', wav.audioFormat === 1 && wav.bitsPerSample === 16 && wav.channels === 2,
  `PCM${wav.bitsPerSample}, ${wav.channels} channels`);
check('sample rate', wav.sampleRate === SAMPLE_RATE, `${wav.sampleRate} Hz`);
check('sample count', left.length === expectedFrames,
  `${left.length} frames (expected ${expectedFrames})`);
check('finite PCM', leftStats.finite && rightStats.finite,
  `left=${leftStats.finite}, right=${rightStats.finite}`);
const peak = Math.max(leftStats.peak, rightStats.peak);
check('master peak', peak >= 0.90 && peak <= 0.921,
  `${(20 * Math.log10(peak)).toFixed(2)} dBFS`);
const stereoRms = Math.sqrt((leftStats.rms ** 2 + rightStats.rms ** 2) / 2);
check('program RMS', stereoRms >= 0.018 && stereoRms <= 0.22,
  `${(20 * Math.log10(stereoRms)).toFixed(2)} dBFS`);
check('DC control', Math.abs(leftStats.dc) < 0.001 && Math.abs(rightStats.dc) < 0.001,
  `left=${leftStats.dc.toExponential(2)}, right=${rightStats.dc.toExponential(2)}`);
check('silent lead-in', rmsBetween(left, 0, Math.round(0.4 * SAMPLE_RATE)) < 1e-5 &&
  rmsBetween(right, 0, Math.round(0.4 * SAMPLE_RATE)) < 1e-5, 'first 400 ms is silent');
check('click-free boundaries', leftStats.first === 0 && rightStats.first === 0 &&
  leftStats.last === 0 && rightStats.last === 0,
  `first=${leftStats.first}/${rightStats.first}, last=${leftStats.last}/${rightStats.last}`);
check('complete-track duration', durationSeconds >= 150 && durationSeconds <= 170,
  `${durationSeconds.toFixed(3)} s`);

const report = {
  generatedAt: new Date().toISOString(),
  title: TRACK_TITLE,
  proceduralAudioOnly: true,
  source: SCORE_PROVENANCE,
  rendering: {
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    bitsPerSample: wav.bitsPerSample,
    frames: left.length,
    durationSeconds,
    noteEvents: performance.events.length,
    measures: performance.measureCount,
    peak,
    peakDbfs: 20 * Math.log10(peak),
    rms: stereoRms,
    rmsDbfs: 20 * Math.log10(stereoRms),
    sha256: createHash('sha256').update(file).digest('hex'),
  },
  checks,
  passed: checks.every(({ passed }) => passed),
};

await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote ${path.relative(root, reportPath)}`);
if (!report.passed) process.exitCode = 1;
