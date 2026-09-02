#!/usr/bin/env node

// Fit a smooth late/early bridge-participation correction. The target is the
// median partial-power residual at 0.8–2.05 s relative to 180 ms, expressed in
// dB. Runtime use must remain bounded and affect observation only, not energy.

import { readFile } from 'node:fs/promises';

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
      const weight = Math.min(1, 3 / Math.max(1e-9, Math.abs(residual)));
      for (let i = 0; i < size; i += 1) {
        rhs[i] += weight * row.inputs[i] * row.target;
        for (let j = 0; j < size; j += 1) normal[i][j] += weight * row.inputs[i] * row.inputs[j];
      }
    }
    for (let index = 0; index < size; index += 1) normal[index][index] += .1;
    coefficients = solve(normal, rhs);
  }
  return coefficients;
}

function median(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  return finite[Math.floor(finite.length / 2)];
}

function summarize(label, rows, coefficients) {
  const before = rows.map((row) => Math.abs(row.target));
  const after = rows.map((row) => Math.abs(row.target - row.inputs.reduce(
    (sum, value, index) => sum + value * coefficients[index], 0,
  )));
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  console.log(`${label}: ${rows.length} participation observations`);
  console.log(`  MAE ${mean(before).toFixed(3)} -> ${mean(after).toFixed(3)} dB`);
  console.log(`  median ${median(before).toFixed(3)} -> ${median(after).toFixed(3)} dB`);
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
    const referenceAnchor = reference.partialPowers[2]?.[partial - 1];
    const synthAnchor = synthesized.partialPowers[2]?.[partial - 1];
    if (![referenceAnchor, synthAnchor].every(Number.isFinite)) continue;
    const correction = [];
    for (let frame = 4; frame <= 6; frame += 1) {
      const referencePower = reference.partialPowers[frame]?.[partial - 1];
      const synthPower = synthesized.partialPowers[frame]?.[partial - 1];
      if (![referencePower, synthPower].every(Number.isFinite)) continue;
      const signedResidual = dbPower(synthPower / synthAnchor) - dbPower(referencePower / referenceAnchor);
      correction.push(-signedResidual);
    }
    if (correction.length) rows.push({
      midi: entry.midi,
      inputs: basis(entry.midi, entry.velocity, partial),
      target: Math.max(-12, Math.min(12, median(correction))),
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
