#!/usr/bin/env node

import { performance as clock } from 'node:perf_hooks';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRealtimeGrandPianoEngine, REALTIME_BLOCK_SIZE, SAMPLE_RATE } from '../src/grand-piano.js';
import { DEFAULT_REVERB_IR_URL, DEFAULT_REVERB_WET } from '../src/reverb.js';
import { readWav, writeStereoPcm16Wav } from './audio-analysis.mjs';
import { buildBwv846Performance, SCORE_PROVENANCE, TRACK_TITLE } from './bwv846-performance.mjs';
import { applyConvolverReverb } from './convolution-reverb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'demos', 'bach-bwv846-prelude-procedural.wav');
const performance = buildBwv846Performance();
const frameCount = Math.round(performance.durationSeconds * SAMPLE_RATE);
const timeline = new Array(performance.events.length * 2);
for (let index = 0; index < performance.events.length; index += 1) { const event = performance.events[index], id = index + 1; timeline[index * 2] = { frame: Math.round(event.start * SAMPLE_RATE), id, on: true, frequency: event.frequency, velocity: event.velocity }; timeline[index * 2 + 1] = { frame: Math.round((event.start + event.duration) * SAMPLE_RATE), id, on: false }; }
timeline.sort((left, right) => left.frame - right.frame || left.on - right.on || left.id - right.id);

console.log(`rendering ${TRACK_TITLE} through the realtime voice engine`);
console.log(`score: ${SCORE_PROVENANCE.edition}`);
const engine = createRealtimeGrandPianoEngine(64);
const block = new Float32Array(REALTIME_BLOCK_SIZE);
const left = new Float32Array(frameCount);
const right = new Float32Array(frameCount);
const stereoGain = Math.SQRT1_2;
let timelineIndex = 0, clippedFrames = 0, maximumVoices = 0;
const renderStarted = clock.now();
for (let blockStart = 0; blockStart < frameCount; blockStart += REALTIME_BLOCK_SIZE) { const blockEnd = Math.min(frameCount, blockStart + REALTIME_BLOCK_SIZE), blockFrames = blockEnd - blockStart; while (timelineIndex < timeline.length && timeline[timelineIndex].frame < blockEnd) { const event = timeline[timelineIndex], delay = Math.max(0, event.frame - blockStart); if (event.on) engine.noteOn(event.id, event.frequency, event.velocity, delay); else engine.noteOff(event.id, 64 / 127, delay); timelineIndex += 1; } engine.process(block, blockFrames); maximumVoices = Math.max(maximumVoices, engine.activeVoiceCount()); for (let frame = 0; frame < blockFrames; frame += 1) { const sample = block[frame]; if (Math.abs(sample) >= .939999) clippedFrames += 1; left[blockStart + frame] = sample * stereoGain; right[blockStart + frame] = sample * stereoGain; } }
const renderSeconds = (clock.now() - renderStarted) / 1000;

const impulse = await readWav(fileURLToPath(DEFAULT_REVERB_IR_URL), { preserveChannels: true });
console.log(`applying Small Hall convolution reverb (${Math.round(DEFAULT_REVERB_WET * 100)}% wet)`);
const reverb = applyConvolverReverb(left, right, impulse.channelSamples[0], impulse.channelSamples[1], { wet: DEFAULT_REVERB_WET, normalize: true, sampleRate: SAMPLE_RATE });
await mkdir(path.dirname(destination), { recursive: true });
await writeStereoPcm16Wav(destination, left, right, SAMPLE_RATE);
console.log(`wrote ${path.relative(root, destination)} (${(frameCount / SAMPLE_RATE).toFixed(2)} s, ${renderSeconds.toFixed(2)} s synthesis, ${(frameCount / SAMPLE_RATE / renderSeconds).toFixed(1)}x realtime, ${maximumVoices} peak voices, ${clippedFrames} clipped source frames, reverb gain ${reverb.normalizationScale.toFixed(4)})`);
