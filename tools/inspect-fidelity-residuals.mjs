#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reference = JSON.parse(await readFile(
  path.join(root, 'reports', 'reference-fidelity-features.json'),
));
const synthesized = JSON.parse(await readFile(
  path.join(root, 'reports', 'synth-fidelity-features.json'),
));
const referenceByFile = new Map(reference.entries.map((entry) => [entry.file, entry.features]));
const bands = [
  '20-40', '40-63', '63-100', '100-160', '160-250', '250-400', '400-630',
  '630-1k', '1-1.6k', '1.6-2.5k', '2.5-4k', '4-6.3k', '6.3-10k', '10-16k',
];
const sustainTimes = ['25ms', '80ms', '180ms', '400ms', '800ms', '1.35s', '2.05s'];
const transientTimes = ['0-6ms', '6-14ms', '14-28ms', '28-55ms', '55-110ms'];

function clippedDbPower(value, floor = -72) {
  return Math.max(floor, 10 * Math.log10(Math.max(value, Number.MIN_VALUE)));
}

function percentile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const position = probability * (sorted.length - 1);
  const lower = Math.floor(position);
  const mix = position - lower;
  return sorted[lower] * (1 - mix) + sorted[Math.min(lower + 1, sorted.length - 1)] * mix;
}

function summary(values) {
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    median: percentile(values, .5),
    mae: values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length,
    p90: percentile(values.map(Math.abs), .9),
    count: values.length,
  };
}

function renderTable(title, labels, groups) {
  console.log(`\n${title}`);
  console.log('group'.padEnd(13), 'mean'.padStart(8), 'median'.padStart(8), 'MAE'.padStart(8), 'p90|e|'.padStart(8), 'n'.padStart(7));
  groups.forEach((values, index) => {
    if (values.length === 0) return;
    const row = summary(values);
    console.log(
      labels[index].padEnd(13),
      row.mean.toFixed(2).padStart(8),
      row.median.toFixed(2).padStart(8),
      row.mae.toFixed(2).padStart(8),
      row.p90.toFixed(2).padStart(8),
      String(row.count).padStart(7),
    );
  });
}

const pairs = synthesized.entries.map((entry) => ({
  ...entry,
  reference: referenceByFile.get(entry.file),
  synthesized: entry.features,
})).filter((entry) => entry.reference);

function profileResiduals(property, frameLabels, thresholdDb) {
  const byBand = bands.map(() => []);
  const byFrame = frameLabels.map(() => []);
  const byRegister = ['A0-B1', 'C2-B3', 'C4-B5', 'C6-C8'].map(() => []);
  const byVelocity = ['v1-v4', 'v5-v8', 'v9-v12', 'v13-v16'].map(() => []);
  for (const pair of pairs) {
    const activeFrames = pair.reference.sustainRawRms.map((rawRms) =>
      pair.reference.noiseRms <= 0 || 20 * Math.log10(rawRms / pair.reference.noiseRms) >= 8);
    const referenceMatrix = pair.reference[property];
    const synthesizedMatrix = pair.synthesized[property];
    for (let frame = 0; frame < referenceMatrix.length; frame += 1) {
      if (property === 'sustainProfiles' && !activeFrames[frame]) continue;
      for (let band = 0; band < referenceMatrix[frame].length; band += 1) {
        if (Math.max(referenceMatrix[frame][band], synthesizedMatrix[frame][band]) < thresholdDb) continue;
        const residual = synthesizedMatrix[frame][band] - referenceMatrix[frame][band];
        byBand[band].push(residual);
        byFrame[frame].push(residual);
        byRegister[Math.min(3, Math.floor((pair.midi - 21) / 24))].push(residual);
        byVelocity[Math.min(3, Math.floor((pair.layer - 1) / 4))].push(residual);
      }
    }
  }
  renderTable(`${property}: signed synth-reference dB by frequency`, bands, byBand);
  renderTable(`${property}: signed synth-reference dB by time`, frameLabels, byFrame);
  renderTable(`${property}: signed synth-reference dB by register`, ['A0-B1', 'C2-B3', 'C4-B5', 'C6-C8'], byRegister);
  renderTable(`${property}: signed synth-reference dB by velocity`, ['v1-v4', 'v5-v8', 'v9-v12', 'v13-v16'], byVelocity);
}

function decayResiduals(property, labels, thresholdDb, partials = false) {
  const byColumn = labels.map(() => []);
  const byFrame = sustainTimes.slice(2).map(() => []);
  const byRegister = ['A0-B1', 'C2-B3', 'C4-B5', 'C6-C8'].map(() => []);
  const byVelocity = ['v1-v4', 'v5-v8', 'v9-v12', 'v13-v16'].map(() => []);
  for (const pair of pairs) {
    const referenceMatrix = pair.reference[property];
    const synthesizedMatrix = pair.synthesized[property];
    const referenceAnchor = referenceMatrix[1];
    const synthesizedAnchor = synthesizedMatrix[1];
    const strongestReference = Math.max(...referenceAnchor, Number.MIN_VALUE);
    const reliableColumns = partials
      ? Math.max(1, Math.min(
        referenceAnchor.length,
        pair.reference.inharmonicMaximumStrongPartial ?? pair.reference.inharmonicStrongPartials ?? 1,
      ))
      : referenceAnchor.length;
    for (let column = 0; column < reliableColumns; column += 1) {
      if (clippedDbPower(referenceAnchor[column] / strongestReference) < thresholdDb) continue;
      for (let frame = 2; frame < referenceMatrix.length; frame += 1) {
        const referenceChange = clippedDbPower(
          referenceMatrix[frame][column] / Math.max(referenceAnchor[column], Number.MIN_VALUE), -90,
        );
        const synthesizedChange = clippedDbPower(
          synthesizedMatrix[frame][column] / Math.max(synthesizedAnchor[column] ?? 0, Number.MIN_VALUE), -90,
        );
        const residual = synthesizedChange - referenceChange;
        byColumn[column].push(residual);
        byFrame[frame - 2].push(residual);
        byRegister[Math.min(3, Math.floor((pair.midi - 21) / 24))].push(residual);
        byVelocity[Math.min(3, Math.floor((pair.layer - 1) / 4))].push(residual);
      }
    }
  }
  renderTable(`${property}: signed synth-reference decay dB by ${partials ? 'partial' : 'frequency'}`, labels, byColumn);
  renderTable(`${property}: signed synth-reference decay dB by time`, sustainTimes.slice(2), byFrame);
  renderTable(`${property}: signed synth-reference decay dB by register`, ['A0-B1', 'C2-B3', 'C4-B5', 'C6-C8'], byRegister);
  renderTable(`${property}: signed synth-reference decay dB by velocity`, ['v1-v4', 'v5-v8', 'v9-v12', 'v13-v16'], byVelocity);
}

console.log(`Matched ${pairs.length} directly recorded note/velocity pairs (no pitch shifting).`);
profileResiduals('sustainProfiles', sustainTimes, -58);
profileResiduals('transientProfiles', transientTimes, -58);
decayResiduals('partialPowers', Array.from({ length: 16 }, (_, index) => `partial ${index + 1}`), -45, true);
decayResiduals('sustainBandPowers', bands, -48);
