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

// Deterministic waveform oracles, refreshed for the September 2026 continuous
// radiation, string-mass, and felt fits. Acoustic quality is evaluated by
// reference comparisons.
function pcmHash(pcm) {
  return createHash('sha256')
    .update(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    .digest('hex');
}

const REFERENCE_RENDERS = [
  {
    name: 'A0 soft',
    arguments: [27.5, 0.3, 0.06],
    sha256: 'afebba37a86a0bc9a7c522938c883271839bef37f95e333fa50c3009eacef58a',
  },
  {
    name: 'A4 medium-long render',
    arguments: [440, 0.731, 0.45],
    sha256: '69aea608734943118e564815be2e63a5d06c20c0455e60140908530af76589f5',
  },
  {
    name: 'C8 maximum velocity',
    arguments: [4_186.009_044_809_578, 1, 0.06],
    sha256: '8ae00e334f0d3513299d47c09058e67ec3fb39c642851c68c3dfbb69c6f788f7',
  },
  {
    name: 'one-sample render',
    arguments: [440, 0.731, 1 / SAMPLE_RATE],
    sha256: 'df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119',
  },
  {
    name: 'fade length minus one',
    arguments: [440, 0.731, 255 / SAMPLE_RATE],
    sha256: 'a46c39d0636d7692c4ceb36421694a4e85cfc956c048c33500509cc4ecd52d1b',
  },
  {
    name: 'exact fade length',
    arguments: [440, 0.731, 256 / SAMPLE_RATE],
    sha256: '185ba01c9b62d66e9be856a171c87d384701a7be19cb6ca464371c5925716a38',
  },
  {
    name: 'fade length plus one',
    arguments: [440, 0.731, 257 / SAMPLE_RATE],
    sha256: '2fb3f22ae67f9e90e692fcafbd08810c967e78817b37068774bbef49f83439c4',
  },
  {
    name: 'near-zero nonzero velocity',
    arguments: [440, 0.000_001, 0.03],
    sha256: '7330ddc306f4cc4caf3435b4f1fced7574397de78cea762920e5d62980d0a1c5',
  },
  {
    name: 'frequency clamped below A0',
    arguments: [-1, 0.7, 0.025],
    sha256: '27686bb832a423241305bec7cb6b0cabd33c83ae27c2a30874e04a8445c9097f',
  },
  {
    name: 'frequency clamped above C8',
    arguments: [99_999, 0.7, 0.025],
    sha256: 'fa8a90325af7ab47a0141a43c6c84f6f468f8c61549808af551d749edeb8baec',
  },
  {
    name: 'velocity clamped above one',
    arguments: [440, 7, 0.025],
    sha256: 'c2285f1dcbe449a997d937d1af10de9ac3fbabff865e670f296370d4f33c3d9e',
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
    // Removing the cancelling radiation constant changes a few rounding bits.
    // The independent 709-scenario old/new check is in reports/synth-pruning.json.
    '9d96ea192f31ad9b1db0f09ef7d87778ad96b9c79e27a6db96dced4c794f8199',
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
