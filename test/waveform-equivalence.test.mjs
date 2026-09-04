import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  MAX_DURATION_SECONDS,
  SAMPLE_RATE,
  synthesizeGrandPiano,
  synthesizeGrandPianoInto,
} from '../src/grand-piano.js';

// Deterministic waveform oracles, refreshed for the September 2026 pedal and
// unison-mechanics change. Acoustic quality is evaluated by reference comparisons.
function pcmHash(pcm) {
  return createHash('sha256')
    .update(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    .digest('hex');
}

const REFERENCE_RENDERS = [
  {
    name: 'A0 soft',
    arguments: [27.5, 0.3, 0.06],
    sha256: '52eb0850c21a7cda4ffb0a0b9264d8c6cfed9c1c455b360d1947a2eadd0d339d',
  },
  {
    name: 'A4 medium-long render',
    arguments: [440, 0.731, 0.45],
    sha256: '740046cc7c7220266316b031ee750e57c8320c607e1f8bb3ca1a819ee519e7f9',
  },
  {
    name: 'C8 maximum velocity',
    arguments: [4_186.009_044_809_578, 1, 0.06],
    sha256: 'c040bb365ec1946e9ebc46c17092371f28bcc99500dc092ae5900e77acb00a71',
  },
  {
    name: 'one-sample render',
    arguments: [440, 0.731, 1 / SAMPLE_RATE],
    sha256: 'df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119',
  },
  {
    name: 'fade length minus one',
    arguments: [440, 0.731, 255 / SAMPLE_RATE],
    sha256: '75511efe0def1ebc919ad882960bac894acc98f41cd017b80ebabf28d9cbacb4',
  },
  {
    name: 'exact fade length',
    arguments: [440, 0.731, 256 / SAMPLE_RATE],
    sha256: 'edd050df121514880631fbe36dfc435d6a79c215ecde5efba1b61e7af5640a81',
  },
  {
    name: 'fade length plus one',
    arguments: [440, 0.731, 257 / SAMPLE_RATE],
    sha256: '52f871588d2dcb066ec69cfdb2b7a171943b91690c3f9cc86751405eee4f06bc',
  },
  {
    name: 'near-zero nonzero velocity',
    arguments: [440, 0.000_001, 0.03],
    sha256: 'aa8a7224430a5867f85435acbe8d1f984f744b39123922841903be3a8de0ba4c',
  },
  {
    name: 'frequency clamped below A0',
    arguments: [-1, 0.7, 0.025],
    sha256: '47014b16d51bd18490f9e7749201f370b84786f7d2bff2dd94ebf44931f87a2b',
  },
  {
    name: 'frequency clamped above C8',
    arguments: [99_999, 0.7, 0.025],
    sha256: '8d2f70ca731246594ca2b218c3ffe3fb54454c37ecda408a1a30894b98d7095a',
  },
  {
    name: 'velocity clamped above one',
    arguments: [440, 7, 0.025],
    sha256: '0b00df7e0a2e1472f99110fcda6345960ecac5388e6148c3fe5260484b7ba07f',
  },
];

test('representative optimized renders remain deterministic', () => {
  for (const reference of REFERENCE_RENDERS) {
    const actual = pcmHash(synthesizeGrandPiano(...reference.arguments));
    assert.equal(actual, reference.sha256, reference.name);
  }
});

test('all 88 keys remain deterministic at soft, medium, and hard velocities', () => {
  const aggregate = createHash('sha256');
  for (let midi = 21; midi <= 108; midi += 1) {
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    for (const velocity of [0.13, 0.57, 1]) {
      const pcm = synthesizeGrandPiano(frequency, velocity, 0.03);
      aggregate.update(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    }
  }
  assert.equal(
    aggregate.digest('hex'),
    '6ade46679ca78a093074f962f0deac21bc16edc193c93f33ca77a7583c060bf8',
  );
});

test('full-model Wasm memory is module-preallocated and reused', async () => {
  const source = await readFile(new URL('../src/grand-piano.js', import.meta.url), 'utf8');
  const cSource = await readFile(new URL('../tools/grand-piano-wasm.c', import.meta.url), 'utf8');
  const render = source.slice(source.indexOf('export function synthesizeGrandPiano'), source.indexOf('export function synthesizeGrandPianoInto'));
  const wasmBytes = /const WASM_BYTES = Uint8Array\.from\(atob\('([^']+)'/.exec(source)?.[1];
  assert.ok(wasmBytes && WebAssembly.validate(Buffer.from(wasmBytes, 'base64')), 'embedded full-model Wasm is valid');
  const module = new WebAssembly.Module(Buffer.from(wasmBytes, 'base64'));
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const wasm = new WebAssembly.Instance(module).exports;
  assert.equal(wasm.memory.buffer.byteLength, 33_554_432);
  assert.throws(() => wasm.memory.grow(1), RangeError);
  assert.ok(wasm.output_ptr() + MAX_DURATION_SECONDS * SAMPLE_RATE * 4 <= wasm.memory.buffer.byteLength);
  assert.match(source, /const WASM_OUTPUT = new Float32Array\(WASM\.memory\.buffer, WASM\.output_ptr\(\), MAX_SAMPLES\)/);
  assert.match(render, /WASM\.synthesize\(/);
  assert.equal((render.match(/new Float32Array\(/g) ?? []).length, 1, 'only the returned PCM is allocated');
  assert.doesNotMatch(render, /new (?:Float64Array|Uint8Array|WebAssembly)/);
  assert.doesNotMatch(render, /\.(?:map|slice|subarray|push)\(/);
  assert.doesNotMatch(source, /function (?:filterSoundboard|createStringModes)|Math\.(?:sin|tanh)\(/);
  assert.doesNotMatch(cSource, /\b(?:malloc|calloc|realloc|free)\s*\(/);
  assert.match(cSource, /static float output\[MAX_SAMPLES\]/);
  assert.match(cSource, /static Voice offline_voice, strike_template, voices\[MAX_VOICES\]/);
  assert.match(cSource, /static Event events\[EVENT_COUNT\]/);
  assert.match(cSource, /static double realtime_mix\[BLOCK_SIZE\]/);
});

test('caller-provided output enables an allocation-free render path', () => {
  const duration = 0.03;
  const sampleCount = Math.round(duration * SAMPLE_RATE);
  const output = new Float32Array(sampleCount + 64);
  assert.equal(synthesizeGrandPianoInto(output, 440, 0.731, duration), output);
  assert.deepEqual(output.subarray(0, sampleCount), synthesizeGrandPiano(440, 0.731, duration));
  output.fill(1);
  synthesizeGrandPianoInto(output, 440, 0, duration);
  assert.ok(output.subarray(0, sampleCount).every((sample) => sample === 0));
  assert.throws(() => synthesizeGrandPianoInto(new Float32Array(1), 440, 0.731, duration), RangeError);
});
