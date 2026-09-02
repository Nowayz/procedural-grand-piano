#!/usr/bin/env node

// Fit the residual loss rate after 400 ms. This is deliberately separate from
// fit-modal-loss.mjs: the ordinary loss fit follows the whole sustain, while
// this fit targets late curvature for the weakly radiating slow string mode.

import { readFile } from 'node:fs/promises';

const TIMES = [.025, .08, .18, .4, .8, 1.35, 2.05];
const ANCHOR_FRAME = 3;
const referenceCache = JSON.parse(await readFile(
  new URL('../reports/reference-fidelity-features.json', import.meta.url), 'utf8',
));
const synthCache = JSON.parse(await readFile(
  new URL('../reports/synth-fidelity-features.json', import.meta.url), 'utf8',
));
const referenceByFile = new Map(referenceCache.entries.map((entry) => [entry.file, entry.features]));

function dbPower(ratio) {
  return 10 * Math.log10(Math.max(Number.MIN_VALUE, ratio));
}

function basis(midi, velocity, partial) {
  const x = (midi - 64.5) / 43.5;
  const y = 2 * velocity - 1;
  const z = Math.log2(partial) * .25;
  const xy = x * y;
  return [
    1, x, x * x, x * x * x, y, y * y, xy, x * xy, y * xy,
    z, x * z, x * x * z, y * z, y * y * z, xy * z,
    z * z, x * z * z, y * z * z, z * z * z,
  ];
}

function solve(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let index = column; index <= size; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const scale = augmented[row][column];
      for (let index = column; index <= size; index += 1) augmented[row][index] -= scale * augmented[column][index];
    }
  }
  return augmented.map((row) => row[size]);
}

function fit(rows) {
  let coefficients = Array(rows[0].inputs.length).fill(0);
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const size = coefficients.length;
    const normal = Array.from({ length: size }, () => Array(size).fill(0));
    const rhs = Array(size).fill(0);
    for (const row of rows) {
      const predicted = row.inputs.reduce((sum, value, index) => sum + value * coefficients[index], 0);
      const residual = row.target - predicted;
      const weight = Math.min(1, 2.5 / Math.max(1e-9, Math.abs(residual)));
      for (let i = 0; i < size; i += 1) {
        rhs[i] += weight * row.inputs[i] * row.target;
        for (let j = 0; j < size; j += 1) normal[i][j] += weight * row.inputs[i] * row.inputs[j];
      }
    }
    for (let index = 0; index < size; index += 1) normal[index][index] += .08;
    coefficients = solve(normal, rhs);
  }
  return coefficients;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function summarize(label, rows, coefficients) {
  const before = rows.map((row) => Math.abs(row.target));
  const after = rows.map((row) => Math.abs(row.target - row.inputs.reduce(
    (sum, value, index) => sum + value * coefficients[index], 0,
  )));
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  console.log(`${label}: ${rows.length} late partial-loss slopes`);
  console.log(`  MAE ${mean(before).toFixed(3)} -> ${mean(after).toFixed(3)} dB/s`);
  console.log(`  median ${median(before).toFixed(3)} -> ${median(after).toFixed(3)} dB/s`);
}

const rows = [];
for (const entry of synthCache.entries) {
  const reference = referenceByFile.get(entry.file);
  const synthesized = entry.features;
  const partialCount = Math.min(
    16,
    reference.inharmonicMaximumStrongPartial ?? reference.inharmonicStrongPartials ?? 1,
    reference.partialPowers[0].length,
    synthesized.partialPowers[0].length,
  );
  for (let partial = 1; partial <= partialCount; partial += 1) {
    const referenceAnchor = reference.partialPowers[ANCHOR_FRAME]?.[partial - 1];
    const synthAnchor = synthesized.partialPowers[ANCHOR_FRAME]?.[partial - 1];
    if (![referenceAnchor, synthAnchor].every(Number.isFinite)) continue;
    let numerator = 0;
    let denominator = 0;
    for (let frame = ANCHOR_FRAME + 1; frame < TIMES.length; frame += 1) {
      const referencePower = reference.partialPowers[frame]?.[partial - 1];
      const synthPower = synthesized.partialPowers[frame]?.[partial - 1];
      if (![referencePower, synthPower].every(Number.isFinite)) continue;
      const elapsed = TIMES[frame] - TIMES[ANCHOR_FRAME];
      const signedResidual = dbPower(synthPower / synthAnchor) - dbPower(referencePower / referenceAnchor);
      numerator += elapsed * signedResidual;
      denominator += elapsed * elapsed;
    }
    if (denominator > 0) rows.push({
      midi: entry.midi,
      inputs: basis(entry.midi, entry.velocity, partial),
      target: Math.max(-18, Math.min(18, numerator / denominator)),
    });
  }
}

const trainingRows = rows.filter((row) => Math.round((row.midi - 21) / 3) % 2 === 0);
const validationRows = rows.filter((row) => !trainingRows.includes(row));
const heldOutCoefficients = fit(trainingRows);
const coefficients = fit(rows);
summarize('held-out notes', validationRows, heldOutCoefficients);
summarize('all direct notes', rows, coefficients);
console.log('coefficients:');
console.log(coefficients.map((value) => Number(value.toPrecision(12))).join(', '));
