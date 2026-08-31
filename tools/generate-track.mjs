#!/usr/bin/env node

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeStereoPcm16Wav } from './audio-analysis.mjs';
import {
  renderBwv846Track,
  SCORE_PROVENANCE,
  TRACK_TITLE,
} from './bwv846-performance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'demos', 'bach-bwv846-prelude-procedural.wav');

console.log(`rendering ${TRACK_TITLE}`);
console.log(`score: ${SCORE_PROVENANCE.edition}`);
const rendered = renderBwv846Track({
  onProgress(completed, total) {
    console.log(`rendered ${completed}/${total} note events`);
  },
});

await mkdir(path.dirname(destination), { recursive: true });
await writeStereoPcm16Wav(
  destination,
  rendered.left,
  rendered.right,
  rendered.sampleRate,
);

console.log(
  `wrote ${path.relative(root, destination)} ` +
  `(${(rendered.left.length / rendered.sampleRate).toFixed(2)} s, stereo, 44.1 kHz)`,
);
