#!/usr/bin/env node

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE_RATE, synthesizeGrandPiano } from '../src/grand-piano.js';
import { writeMonoPcm16Wav } from './audio-analysis.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'demos');

function mixEvents(events, durationSeconds) {
  const output = new Float32Array(Math.round(durationSeconds * SAMPLE_RATE));
  for (const event of events) {
    const note = synthesizeGrandPiano(event.frequency, event.velocity, event.duration);
    const start = Math.round(event.start * SAMPLE_RATE);
    for (let index = 0; index < note.length && start + index < output.length; index += 1) {
      output[start + index] += note[index] * (event.gain ?? 1);
    }
  }

  let peak = 0;
  for (const value of output) peak = Math.max(peak, Math.abs(value));
  if (peak > 0.94) {
    const gain = 0.94 / peak;
    for (let index = 0; index < output.length; index += 1) output[index] *= gain;
  }
  output[0] = 0;
  output[output.length - 1] = 0;
  return output;
}

const note = (midi) => 440 * 2 ** ((midi - 69) / 12);
const demonstrations = [
  {
    file: 'A1-soft.wav',
    audio: synthesizeGrandPiano(55, 0.28, 3),
  },
  {
    file: 'C4-medium.wav',
    audio: synthesizeGrandPiano(note(60), 0.62, 3),
  },
  {
    file: 'A6-hard.wav',
    audio: synthesizeGrandPiano(1_760, 0.94, 2),
  },
  {
    file: 'A6v16-procedural.wav',
    audio: synthesizeGrandPiano(1_760, 0.976378, 6.833583),
  },
  {
    file: 'C-major-chord.wav',
    audio: mixEvents(
      [48, 52, 55, 60].map((midi, index) => ({
        frequency: note(midi),
        velocity: 0.68 - index * 0.035,
        duration: 3.8,
        start: index * 0.012,
        gain: 0.48,
      })),
      4,
    ),
  },
  {
    file: 'short-phrase.wav',
    audio: mixEvents(
      [
        [60, 0, 0.66],
        [64, 0.42, 0.57],
        [67, 0.82, 0.7],
        [72, 1.24, 0.78],
        [67, 1.73, 0.52],
        [64, 2.12, 0.58],
        [60, 2.52, 0.72],
        [55, 2.52, 0.55],
        [48, 2.52, 0.62],
      ].map(([midi, start, velocity]) => ({
        frequency: note(midi),
        velocity,
        duration: start >= 2.5 ? 2.7 : 1.15,
        start,
        gain: 0.63,
      })),
      5.25,
    ),
  },
];

await mkdir(demoRoot, { recursive: true });
for (const demonstration of demonstrations) {
  const destination = path.join(demoRoot, demonstration.file);
  await writeMonoPcm16Wav(destination, demonstration.audio, SAMPLE_RATE);
  console.log(
    `wrote ${path.relative(root, destination)} ` +
      `(${(demonstration.audio.length / SAMPLE_RATE).toFixed(2)} s)`,
  );
}
