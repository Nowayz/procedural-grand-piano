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

// Deterministic optimized-waveform oracles. Perceptual equivalence to the recorded
// piano is enforced separately by the full strict reference comparisons.
function pcmHash(pcm) {
  return createHash('sha256')
    .update(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    .digest('hex');
}

const REFERENCE_RENDERS = [
  {
    name: 'A0 soft',
    arguments: [27.5, 0.3, 0.06],
    sha256: 'eec70cb347cd1a517328a1cd5eaa20dc0b5251e852d0670cd85b175622fbb6f7',
  },
  {
    name: 'A4 medium-long render',
    arguments: [440, 0.731, 0.45],
    sha256: '9e0a019ca75afa2213b4c76468157dfc7a1b9a98dd041fbe115ac88f7d2990a7',
  },
  {
    name: 'C8 maximum velocity',
    arguments: [4_186.009_044_809_578, 1, 0.06],
    sha256: '1ffc657d50e0afdfab5a30f8d9a2d1fe2d1e66cc74a3be465fd6da520579e05c',
  },
  {
    name: 'one-sample render',
    arguments: [440, 0.731, 1 / SAMPLE_RATE],
    sha256: 'df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119',
  },
  {
    name: 'fade length minus one',
    arguments: [440, 0.731, 255 / SAMPLE_RATE],
    sha256: '2f6bf507ed012c6e35732214984675363ec988d2b6cc839f51ab3fd84bfdb8e4',
  },
  {
    name: 'exact fade length',
    arguments: [440, 0.731, 256 / SAMPLE_RATE],
    sha256: '0d73a5fcb2a90aa80a34a47462be2dda76810a838b956ce4a8f141547c2c95c7',
  },
  {
    name: 'fade length plus one',
    arguments: [440, 0.731, 257 / SAMPLE_RATE],
    sha256: '589bddbbee3a6beb9a97142a0dc86cf39515ef4288a286dae686bce7dd58c5c7',
  },
  {
    name: 'near-zero nonzero velocity',
    arguments: [440, 0.000_001, 0.03],
    sha256: '88f1dcde353a5e7ac4c117749ab1c988533c6adea94c936888230a5f13f5f02c',
  },
  {
    name: 'frequency clamped below A0',
    arguments: [-1, 0.7, 0.025],
    sha256: '4285e6217951425f4a653eb72a30e01a10ebfbcbd0ab785cecfcd58aa50aed29',
  },
  {
    name: 'frequency clamped above C8',
    arguments: [99_999, 0.7, 0.025],
    sha256: '4087beecc0da993c4724b9ab4be238a62bdc24605f086158cafadb74e0225a00',
  },
  {
    name: 'velocity clamped above one',
    arguments: [440, 7, 0.025],
    sha256: '9939d16a8b994a3bdc6588f03bc6c2eca2dee83a40f6e0c49aa9becd97452339',
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
    '4743d46d6fcd164dc5c3c1ea33ce72d61fb7e5e4769fb812a1ec7c85edf17ae8',
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
  assert.match(cSource, /static Voice offline_voice, voices\[MAX_VOICES\]/);
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
