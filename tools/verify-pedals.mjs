import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createGrandPianoProcessorOptions, createRealtimeGrandPianoEngine } from '../src/grand-piano.js';

const rate = 44100, block = new Float32Array(128);
function advance(engine, frames) { while (frames > 0) { const n = Math.min(frames, 128); engine.process(block, n); frames -= n; } }
function noteMetrics(engine, midi, velocity, position) {
 engine.reset(rate).unaCorda(position); advance(engine, rate / 2);
 engine.noteOn(1, 440 * 2 ** ((midi - 69) / 12), velocity);
 let energy = 0, differenceEnergy = 0, previous = 0, peak = 0, count = 0;
 for (let start = 0; start < 11025; start += 128) {
  const n = Math.min(128, 11025 - start); engine.process(block, n);
  for (let i = 0; i < n; ++i) {
   const x = block[i]; assert.ok(Number.isFinite(x)); peak = Math.max(peak, Math.abs(x));
   if (start + i >= 882) { energy += x * x; differenceEnergy += (x - previous) ** 2; ++count; }
   previous = x;
  }
 }
 assert.ok(peak <= .900001);
 return { rms: Math.sqrt(energy / count), brightness: Math.sqrt(differenceEnergy / energy), peak };
}

const engine = createRealtimeGrandPianoEngine(2), cases = [];
for (let midi = 21; midi <= 108; ++midi) for (const velocity of [.1, .3, .6, .8, 1]) {
 const normal = noteMetrics(engine, midi, velocity, 0), soft = noteMetrics(engine, midi, velocity, 1);
 const levelChangeDb = 20 * Math.log10(soft.rms / normal.rms);
 assert.ok(levelChangeDb < 1, `soft-pedal level spike: MIDI ${midi}, velocity ${velocity}, ${levelChangeDb} dB`);
 cases.push({ midi, velocity, levelChangeDb, brightnessRatio: soft.brightness / normal.brightness });
}

const motion = [];
for (const sampleRate of [32000, 44100, 48000, 96000]) {
 const wasm = new WebAssembly.Instance(createGrandPianoProcessorOptions(2).wasmModule).exports; wasm._initialize(); wasm.rt_reset(sampleRate, 2);
 wasm.rt_sustain(1, 0); wasm.rt_una_corda(1, 0);
 for (const milliseconds of [20, 40, 80, 120, 160, 240]) {
  const previous = motion.at(-1)?.sampleRate === sampleRate ? motion.at(-1).milliseconds : 0;
  let frames = Math.round(milliseconds * sampleRate / 1000) - Math.round(previous * sampleRate / 1000);
  while (frames > 0) { const n = Math.min(128, frames); wasm.rt_process(n); frames -= n; }
  motion.push({ sampleRate, milliseconds, sustain: wasm.rt_pedal_position(0), unaCorda: wasm.rt_pedal_position(1) });
 }
}

const performance = [];
for (const voices of [1, 8, 32]) {
 const e = createRealtimeGrandPianoEngine(voices).reset(48000), onsetTimes = [], sustainedTimes = [];
 for (let trial = 0; trial < 7; ++trial) {
  e.reset(48000);
  for (let i = 0; i < voices; ++i) e.noteOn(i + 1, 440 * 2 ** ((36 + i * 2 - 69) / 12), .8);
  const start = globalThis.performance.now(); e.process(block); onsetTimes.push(globalThis.performance.now() - start);
 }
 for (let i = 0; i < 500; ++i) { const start = globalThis.performance.now(); e.process(block); if (i > 20) sustainedTimes.push(globalThis.performance.now() - start); }
 onsetTimes.sort((a, b) => a - b); sustainedTimes.sort((a, b) => a - b);
 performance.push({ voices, sampleRate: 48000, blockBudgetMs: 128000 / 48000, onsetMedianMs: onsetTimes[3], sustainedMedianMs: sustainedTimes[Math.floor(sustainedTimes.length / 2)], sustainedP95Ms: sustainedTimes[Math.floor(sustainedTimes.length * .95)] });
}

const maximum = cases.reduce((best, item) => item.levelChangeDb > best.levelChangeDb ? item : best);
const report = { generatedAt: new Date().toISOString(), coverage: '88 keys × 5 velocities × two pedal positions; 20–250 ms acoustic window', maximumSoftPedalLevelChange: maximum, motion, performance, cases };
if (process.argv.includes('--write-report')) writeFileSync(new URL('../reports/pedal-validation.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ cases: cases.length, maximumSoftPedalLevelChange: maximum, performance }, null, 2));
