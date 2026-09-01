import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { estimateFundamental } from '../tools/audio-analysis.mjs';
import { createGrandPianoProcessorOptions, createRealtimeGrandPianoEngine, MAX_REALTIME_VOICES, REALTIME_BLOCK_SIZE, synthesizeGrandPiano } from '../src/grand-piano.js';
import { createRealtimeGrandPiano, GRAND_PIANO_WORKLET_URL } from '../src/realtime.js';

function renderFrames(engine, frameCount) { const rendered = new Float32Array(frameCount), block = new Float32Array(REALTIME_BLOCK_SIZE); let offset = 0; while (offset < frameCount) { const count = Math.min(REALTIME_BLOCK_SIZE, frameCount - offset); engine.process(block, count); rendered.set(block.subarray(0, count), offset); offset += count; } return rendered; }
function renderPattern(engine, frameCount, pattern) { const rendered = new Float32Array(frameCount), block = new Float32Array(REALTIME_BLOCK_SIZE); let offset = 0, part = 0; while (offset < frameCount) { const count = Math.min(pattern[part++ % pattern.length], frameCount - offset); engine.process(block, count); rendered.set(block.subarray(0, count), offset); offset += count; } return rendered; }
function maximumAbsolute(samples) { let maximum = 0; for (let index = 0; index < samples.length; index += 1) maximum = Math.max(maximum, Math.abs(samples[index])); return maximum; }

test('realtime voice persists for unknown duration and matches the offline held prefix', () => {
 const frames = 22_050, engine = createRealtimeGrandPianoEngine(4); engine.noteOn(1, 440, .731); const realtime = renderFrames(engine, frames); const offline = synthesizeGrandPiano(440, .731, 1); assert.deepEqual(realtime, offline.subarray(0, frames)); assert.equal(engine.activeVoiceCount(), 1); assert.equal(engine.isNoteActive(1), true);
});

test('future note events retain their exact sample offset across render blocks', () => {
 const immediate = createRealtimeGrandPianoEngine(2), delayed = createRealtimeGrandPianoEngine(2); immediate.noteOn(7, 440, .8); const reference = renderFrames(immediate, 91); delayed.noteOn(7, 440, .8, REALTIME_BLOCK_SIZE + 37); const actual = renderFrames(delayed, REALTIME_BLOCK_SIZE * 2); assert.ok(actual.subarray(0, REALTIME_BLOCK_SIZE + 37).every((sample) => sample === 0)); assert.deepEqual(actual.subarray(REALTIME_BLOCK_SIZE + 37), reference);
});

test('audio is invariant to render-block partitioning', () => {
 const regular = createRealtimeGrandPianoEngine(4), irregular = createRealtimeGrandPianoEngine(4); for (const engine of [regular, irregular]) { engine.noteOn(1, 261.625565, .8, 37); engine.noteOn(2, 391.995436, .65, 413); engine.noteOff(1, .2, 1_507); engine.noteOff(2, .2, 1_811); } const a = renderPattern(regular, 2_400, [128]), b = renderPattern(irregular, 2_400, [17, 111, 3, 64, 29, 128]); assert.deepEqual(a, b);
});

test('note-off, sustain, identity, and released-first stealing are stateful', () => {
 const sustained = createRealtimeGrandPianoEngine(2), held = createRealtimeGrandPianoEngine(2); sustained.noteOn(10, 330, .7); held.noteOn(10, 330, .7); renderFrames(sustained, 1_024); renderFrames(held, 1_024); sustained.sustain(true).noteOff(10); const sustainedTail = renderFrames(sustained, 1_024), heldTail = renderFrames(held, 1_024); assert.deepEqual(sustainedTail, heldTail); sustained.sustain(false); renderFrames(sustained, 128); assert.equal(sustained.isNoteActive(10), true); sustained.noteOn(11, 440, .7).noteOn(12, 440, .7); renderFrames(sustained, 128); assert.equal(sustained.activeVoiceCount(), 2); assert.equal(sustained.isNoteActive(10), false); assert.equal(sustained.isNoteActive(11), true); assert.equal(sustained.isNoteActive(12), true); sustained.noteOff(11).noteOff(12); renderFrames(sustained, 12_000); assert.equal(sustained.activeVoiceCount(), 0);
});

test('multiple voices mix deterministically into a finite bounded block', () => {
 const first = createRealtimeGrandPianoEngine(8), second = createRealtimeGrandPianoEngine(8); for (const engine of [first, second]) { engine.noteOn(1, 261.625565, .9); engine.noteOn(2, 329.627557, .8); engine.noteOn(3, 391.995436, .7); } const a = renderFrames(first, 4_096), b = renderFrames(second, 4_096); assert.deepEqual(a, b); assert.ok(maximumAbsolute(a) > .01); assert.ok(maximumAbsolute(a) <= .94); assert.ok(a.every(Number.isFinite));
});

test('each realtime engine owns independent fixed Wasm state and supports 48 kHz', () => {
 const sounding = createRealtimeGrandPianoEngine(4), idle = createRealtimeGrandPianoEngine(4); sounding.reset(48_000).noteOn(1, 440, .8); idle.reset(48_000); const pcm = renderFrames(sounding, 24_000), silence = renderFrames(idle, 24_000); assert.ok(silence.every((sample) => sample === 0)); assert.equal(sounding.sampleRate, 48_000); assert.equal(sounding.voiceLimit, 4); assert.equal(sounding.voiceCapacity, MAX_REALTIME_VOICES); const measured = estimateFundamental(pcm, 48_000, 440, .04); assert.ok(Math.abs(1_200 * Math.log2(measured / 440)) < 5, `48 kHz pitch error: ${measured} Hz`);
});

test('realtime API validates fixed queue, block, rate, and identifier contracts', () => {
 const engine = createRealtimeGrandPianoEngine(99), block = new Float32Array(REALTIME_BLOCK_SIZE); assert.equal(engine.voiceLimit, MAX_REALTIME_VOICES); assert.throws(() => engine.reset(20_000), RangeError); assert.throws(() => engine.noteOn(-1, 440, .8), RangeError); assert.throws(() => engine.noteOn(1, 440, .8, -1), RangeError); assert.throws(() => engine.process(block, REALTIME_BLOCK_SIZE + 1), RangeError); assert.throws(() => engine.process(new Float64Array(REALTIME_BLOCK_SIZE)), TypeError); engine.process(block); assert.ok(block.every((sample) => sample === 0)); for (let index = 0; index < 256; index += 1) engine.sustain(false, 1_000 + index); assert.throws(() => engine.sustain(false, 2_000), RangeError, 'fixed event queue rejects overflow');
});

test('AudioWorklet render callback and C realtime path contain no dynamic allocation', async () => {
 const worklet = await readFile(new URL('../src/grand-piano-worklet.js', import.meta.url), 'utf8'), cSource = await readFile(new URL('../tools/grand-piano-wasm.c', import.meta.url), 'utf8'); const processBody = /process\(_inputs, outputs\) \{([^}]*)\}/.exec(worklet)?.[1]; assert.ok(processBody); assert.doesNotMatch(processBody, /\bnew\b|\.(?:map|slice|subarray|push)\(|\{\s*\w+\s*:/); assert.doesNotMatch(cSource, /\b(?:malloc|calloc|realloc|free)\s*\(/); assert.match(cSource, /#define MAX_VOICES 64/); assert.match(cSource, /#define EVENT_COUNT 256/); assert.match(cSource, /#define BLOCK_SIZE 128/);
});

test('browser controller loads one worklet node and sends absolute-time controls', async () => {
 const OriginalNode = globalThis.AudioWorkletNode, modules = [], instances = []; class FakeAudioWorkletNode { constructor(context, name, options) { this.context = context; this.name = name; this.options = options; this.messages = []; this.port = { postMessage: (message) => this.messages.push(message), close() {} }; instances.push(this); } connect(destination) { this.destination = destination; return destination; } disconnect() { this.destination = undefined; } } globalThis.AudioWorkletNode = FakeAudioWorkletNode;
 try { const context = { currentTime: 3, audioWorklet: { async addModule(url) { modules.push(url); } } }, piano = await createRealtimeGrandPiano(context, { polyphony: 12 }); piano.noteOn(9, 440, .8, 3.1).noteOff(9, .2, 4).sustain(true, 3.5); assert.deepEqual(modules, [GRAND_PIANO_WORKLET_URL]); assert.equal(instances[0].name, 'procedural-grand-piano'); assert.equal(instances[0].options.processorOptions.polyphony, 12); assert.ok(instances[0].options.processorOptions.wasmModule instanceof WebAssembly.Module); assert.equal(instances[0].options.processorOptions.calibrationBytes.length, 1845); assert.deepEqual(instances[0].messages, [{ type: 'noteOn', id: 9, note_hz: 440, velocity: .8, when: 3.1 }, { type: 'noteOff', id: 9, release_velocity: .2, when: 4 }, { type: 'sustain', down: true, when: 3.5 }]); } finally { globalThis.AudioWorkletNode = OriginalNode; }
});

test('worklet processor converts audio time to frames and renders browser-owned output', async () => {
 const originals = { AudioWorkletProcessor: globalThis.AudioWorkletProcessor, registerProcessor: globalThis.registerProcessor, sampleRate: globalThis.sampleRate, currentTime: globalThis.currentTime }; let Processor; globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: undefined }; } }; globalThis.registerProcessor = (name, implementation) => { assert.equal(name, 'procedural-grand-piano'); Processor = implementation; }; globalThis.sampleRate = 48_000; globalThis.currentTime = 2;
 try { await import(`../src/grand-piano-worklet.js?test=${Date.now()}`); const processor = new Processor({ processorOptions: createGrandPianoProcessorOptions(4) }), output = new Float32Array(REALTIME_BLOCK_SIZE); processor.port.onmessage({ data: { type: 'noteOn', id: 1, note_hz: 440, velocity: .8, when: 2 } }); assert.equal(processor.process([], [[output]]), true); assert.ok(maximumAbsolute(output) > 0); } finally { globalThis.AudioWorkletProcessor = originals.AudioWorkletProcessor; globalThis.registerProcessor = originals.registerProcessor; globalThis.sampleRate = originals.sampleRate; globalThis.currentTime = originals.currentTime; }
});
