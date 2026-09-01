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
    sha256: '5078b63236849e1878ac6bfe1982f2d559f0672d4ec6bcf7721b71a1cddc8a76',
  },
  {
    name: 'A4 medium-long render',
    arguments: [440, 0.731, 0.45],
    sha256: 'f7e566b810482dc42b510038805796ec7645b56f8260c3b0f2ad0f62741b5a74',
  },
  {
    name: 'C8 maximum velocity',
    arguments: [4_186.009_044_809_578, 1, 0.06],
    sha256: '8aee7f1af2803070e291637d7ffc5717218631ddc4add5d65c81a765f43f6ccc',
  },
  {
    name: 'one-sample render',
    arguments: [440, 0.731, 1 / SAMPLE_RATE],
    sha256: 'df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119',
  },
  {
    name: 'fade length minus one',
    arguments: [440, 0.731, 255 / SAMPLE_RATE],
    sha256: 'c48d477161c4210858dc08f254a70d72076253a2a753e765a98d09fd615f8de0',
  },
  {
    name: 'exact fade length',
    arguments: [440, 0.731, 256 / SAMPLE_RATE],
    sha256: 'a3c6c40a6ede3943591604d8af750935031d438f2be6a07e6c5d932552688334',
  },
  {
    name: 'fade length plus one',
    arguments: [440, 0.731, 257 / SAMPLE_RATE],
    sha256: '54af861fe24d574456d14b43498270f1b83c5f775bf4a9a2a5c3723d620b7dfc',
  },
  {
    name: 'near-zero nonzero velocity',
    arguments: [440, 0.000_001, 0.03],
    sha256: '420bc48ec044841116e70c87e29a3a098e2274e5a5170bacd88f1115c01a4af6',
  },
  {
    name: 'frequency clamped below A0',
    arguments: [-1, 0.7, 0.025],
    sha256: '9876d51dd14cbbab782e5609e4d6aef4a22da137162d39a17ae0e9ed2c1bcf41',
  },
  {
    name: 'frequency clamped above C8',
    arguments: [99_999, 0.7, 0.025],
    sha256: '9769387ca9a9b95c68c0f560df2500f5375a5f3b0c873f3890ee250397e01d72',
  },
  {
    name: 'velocity clamped above one',
    arguments: [440, 7, 0.025],
    sha256: '147922181db3e054e422fce477f6a7637d860edc18be8c96261ff7e5eb495746',
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
    'fef2e2f822759afd7cbb1f76c96bea43c8015c58d62bdb28cf8095493d6d2b68',
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
  assert.equal(wasm.memory.buffer.byteLength, 12_582_912);
  assert.throws(() => wasm.memory.grow(1), RangeError);
  assert.ok(wasm.calibration_ptr() + 1_845 <= wasm.output_ptr());
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
