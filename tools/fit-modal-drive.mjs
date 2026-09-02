#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const referenceCache = JSON.parse(await readFile(
  new URL('../reports/reference-fidelity-features.json', import.meta.url),
  'utf8',
));
const synthCache = JSON.parse(await readFile(
  new URL('../reports/synth-fidelity-features.json', import.meta.url),
  'utf8',
));
const referenceByFile = new Map(referenceCache.entries.map((entry) => [entry.file, entry.features]));

function basis(midi, velocity, partial) {
  const x = (midi - 64.5) / 43.5;
  const y = 2 * velocity - 1;
  const z = Math.log2(partial) / 4;
  return [
    z, z * z, z * z * z,
    x * z, x * x * z, x * x * x * z,
    y * z, y * y * z,
    x * y * z, x * x * y * z, x * y * y * z,
    x * z * z, y * z * z, x * y * z * z,
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
      for (let index = column; index <= size; index += 1) {
        augmented[row][index] -= scale * augmented[column][index];
      }
    }
  }
  return augmented.map((row) => row[size]);
}

function fit(rows, initial = null) {
  let coefficients = initial ?? Array(rows[0].inputs.length).fill(0);
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const size = coefficients.length;
    const normal = Array.from({ length: size }, () => Array(size).fill(0));
    const rhs = Array(size).fill(0);
    for (const row of rows) {
      const residual = row.target - row.inputs.reduce(
        (sum, value, index) => sum + value * coefficients[index],
        0,
      );
      const weight = Math.min(1, 5 / Math.max(1e-9, Math.abs(residual)));
      for (let i = 0; i < size; i += 1) {
        rhs[i] += weight * row.inputs[i] * row.target;
        for (let j = 0; j < size; j += 1) {
          normal[i][j] += weight * row.inputs[i] * row.inputs[j];
        }
      }
    }
    for (let index = 0; index < coefficients.length; index += 1) normal[index][index] += .03;
    coefficients = solve(normal, rhs);
  }
  return coefficients;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const rows = [];
for (const entry of synthCache.entries) {
  const reference = referenceByFile.get(entry.file);
  const synthesized = entry.features;
  const partialCount = Math.min(
    16,
    reference.inharmonicMaximumStrongPartial ?? reference.inharmonicStrongPartials ?? 1,
    reference.partialProfiles[0].length,
    synthesized.partialProfiles[0].length,
  );
  for (let partial = 2; partial <= partialCount; partial += 1) {
    const frameTargets = [];
    for (let frame = 0; frame < reference.partialProfiles.length; frame += 1) {
      const referenceValue = reference.partialProfiles[frame]?.[partial - 1];
      const synthValue = synthesized.partialProfiles[frame]?.[partial - 1];
      const referenceFundamental = reference.partialProfiles[frame]?.[0];
      const synthFundamental = synthesized.partialProfiles[frame]?.[0];
      if ([referenceValue, synthValue, referenceFundamental, synthFundamental].every(Number.isFinite)) {
        frameTargets.push(
          (referenceValue - referenceFundamental) - (synthValue - synthFundamental),
        );
      }
    }
    if (frameTargets.length) {
      rows.push({
        file: entry.file,
        midi: entry.midi,
        inputs: basis(entry.midi, entry.velocity, partial),
        target: Math.max(-24, Math.min(24, median(frameTargets))),
      });
    }
  }
}

const trainingRows = rows.filter((row) => Math.round((row.midi - 21) / 3) % 2 === 0);
const validationRows = rows.filter((row) => !trainingRows.includes(row));
const validationCoefficients = fit(trainingRows);
const allCoefficients = fit(rows, validationCoefficients);

function errors(selectedRows, coefficients) {
  return selectedRows.map((row) => Math.abs(row.target - row.inputs.reduce(
    (sum, value, index) => sum + value * coefficients[index],
    0,
  )));
}

for (const [label, selectedRows, coefficients] of [
  ['held-out notes', validationRows, validationCoefficients],
  ['all direct notes', rows, allCoefficients],
]) {
  const before = selectedRows.map((row) => Math.abs(row.target));
  const after = errors(selectedRows, coefficients);
  console.log(`${label}: ${selectedRows.length} modal observations`);
  console.log(`  MAE ${mean(before).toFixed(3)} -> ${mean(after).toFixed(3)} dB`);
  console.log(`  median ${median(before).toFixed(3)} -> ${median(after).toFixed(3)} dB`);
}
console.log('coefficients:');
console.log(allCoefficients.map((value) => Number(value.toPrecision(12))).join(', '));
