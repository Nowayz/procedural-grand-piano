#!/usr/bin/env node

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REVERB_IR_URL, DEFAULT_REVERB_WET } from '../src/reverb.js';
import { readWav, writeStereoPcm16Wav } from './audio-analysis.mjs';
import {
  renderBwv846Track,
  SCORE_PROVENANCE,
  TRACK_TITLE,
} from './bwv846-performance.mjs';
import { applyConvolverReverb } from './convolution-reverb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'demos', 'bach-bwv846-prelude-procedural.wav');

console.log(`rendering ${TRACK_TITLE}`);
console.log(`score: ${SCORE_PROVENANCE.edition}`);
const rendered = renderBwv846Track({ proceduralRoom: false, onProgress(completed, total) { console.log(`rendered ${completed}/${total} note events`); } });
const impulse = await readWav(fileURLToPath(DEFAULT_REVERB_IR_URL), { preserveChannels: true });
console.log(`applying Small Hall convolution reverb (${Math.round(DEFAULT_REVERB_WET * 100)}% wet)`);
const reverb = applyConvolverReverb(rendered.left, rendered.right, impulse.channelSamples[0], impulse.channelSamples[1], { wet: DEFAULT_REVERB_WET, normalize: true, sampleRate: rendered.sampleRate });

await mkdir(path.dirname(destination), { recursive: true });
await writeStereoPcm16Wav(destination, rendered.left, rendered.right, rendered.sampleRate);
console.log(`wrote ${path.relative(root, destination)} (${(rendered.left.length / rendered.sampleRate).toFixed(2)} s, stereo, 44.1 kHz, reverb gain ${reverb.normalizationScale.toFixed(4)})`);
