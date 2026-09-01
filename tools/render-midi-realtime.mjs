#!/usr/bin/env node

import { readFile, mkdir } from 'node:fs/promises';
import { performance as clock } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REVERB_IR_URL, DEFAULT_REVERB_WET } from '../src/reverb.js';
import { readWav, writeStereoPcm16Wav } from './audio-analysis.mjs';
import { applyConvolverReverb } from './convolution-reverb.mjs';
import { parseStandardMidi, renderMidiPerformance } from './midi-performance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] && path.resolve(process.argv[2]);
if (!source) throw new Error('usage: node tools/render-midi-realtime.mjs <score.mid> [output.wav]');
const destination = process.argv[3] ? path.resolve(process.argv[3]) : path.join(root, 'demos', `${path.basename(source, path.extname(source))}-procedural.wav`);
const performance = parseStandardMidi(await readFile(source));
console.log(`rendering ${performance.noteCount} notes from ${performance.trackCount} MIDI track${performance.trackCount === 1 ? '' : 's'}${performance.names.length ? ` (${performance.names.join(', ')})` : ''}`);
const started = clock.now();
const rendered = renderMidiPerformance(performance);
const synthesisSeconds = (clock.now() - started) / 1000, left = new Float32Array(rendered.mono.length), right = new Float32Array(rendered.mono.length);
for (let index = 0; index < rendered.mono.length; index += 1) left[index] = right[index] = rendered.mono[index] * Math.SQRT1_2;
const impulse = await readWav(fileURLToPath(DEFAULT_REVERB_IR_URL), { preserveChannels: true });
const reverb = applyConvolverReverb(left, right, impulse.channelSamples[0], impulse.channelSamples[1], { wet: DEFAULT_REVERB_WET, normalize: true, sampleRate: rendered.sampleRate });
await mkdir(path.dirname(destination), { recursive: true });
await writeStereoPcm16Wav(destination, left, right, rendered.sampleRate);
console.log(`wrote ${path.relative(root, destination)} (${(rendered.mono.length / rendered.sampleRate).toFixed(2)} s, ${synthesisSeconds.toFixed(2)} s synthesis, ${(rendered.mono.length / rendered.sampleRate / synthesisSeconds).toFixed(1)}x realtime, ${rendered.maximumVoices} peak voices, ${rendered.clippedFrames} clipped source frames, reverb gain ${reverb.normalizationScale.toFixed(4)})`);
