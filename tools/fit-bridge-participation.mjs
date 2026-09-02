#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const referenceCache = JSON.parse(await readFile(new URL('../reports/reference-fidelity-features.json', import.meta.url)));
const synthCache = JSON.parse(await readFile(new URL('../reports/synth-fidelity-features.json', import.meta.url)));
const referenceByFile = new Map(referenceCache.entries.map((entry) => [entry.file, entry.features]));
const edges = [20, 40, 63, 100, 160, 250, 400, 630, 1_000, 1_600, 2_500, 4_000, 6_300, 10_000, 16_000];

function basis(midi, frequency) {
  const phase = 2 * Math.PI * (midi - 21) / 87;
  const z = Math.log(frequency / 560) / Math.log(16_000 / 20);
  const values = [];
  for (let harmonic = 1; harmonic <= 6; harmonic += 1) {
    values.push(Math.sin(harmonic * phase), Math.cos(harmonic * phase));
    values.push(z * Math.sin(harmonic * phase), z * Math.cos(harmonic * phase));
  }
  return values;
}

function solve(matrix, vector) {
  const size = vector.length, augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let index = column; index <= size; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < size; row += 1) if (row !== column) { const scale = augmented[row][column]; for (let index = column; index <= size; index += 1) augmented[row][index] -= scale * augmented[column][index]; }
  }
  return augmented.map((row) => row[size]);
}

function fit(rows) {
  const size = rows[0].inputs.length, normal = Array.from({ length: size }, () => Array(size).fill(0)), rhs = Array(size).fill(0);
  for (const row of rows) for (let i = 0; i < size; i += 1) { rhs[i] += row.inputs[i] * row.target; for (let j = 0; j < size; j += 1) normal[i][j] += row.inputs[i] * row.inputs[j]; }
  for (let index = 0; index < size; index += 1) normal[index][index] += 4;
  return solve(normal, rhs);
}

function median(values) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; }
function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function errors(rows, coefficients) { return rows.map((row) => Math.abs(row.target - row.inputs.reduce((sum, value, index) => sum + value * coefficients[index], 0))); }

const rows = [];
for (const synthesized of synthCache.entries) {
  const reference = referenceByFile.get(synthesized.file);
  for (let band = 0; band < edges.length - 1; band += 1) {
    const targets = reference.transientProfiles.map((frame, index) => frame[band] - synthesized.features.transientProfiles[index][band]).filter(Number.isFinite);
    if (targets.length) rows.push({ layer: synthesized.layer, inputs: basis(synthesized.midi, Math.sqrt(edges[band] * edges[band + 1])), target: Math.max(-12, Math.min(12, median(targets))) });
  }
}

const training = rows.filter((row) => row.layer % 2 === 0), heldout = rows.filter((row) => row.layer % 2 !== 0), heldoutCoefficients = fit(training), coefficients = fit(rows);
for (const [label, selected, fitted] of [['held-out layers', heldout, heldoutCoefficients], ['all layers', rows, coefficients]]) { const before = selected.map((row) => Math.abs(row.target)), after = errors(selected, fitted); console.log(`${label}: MAE ${mean(before).toFixed(3)} -> ${mean(after).toFixed(3)} dB; median ${median(before).toFixed(3)} -> ${median(after).toFixed(3)} dB`); }
console.log(coefficients.map((value) => Number(value.toPrecision(10))).join(', '));
