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
    sha256: 'e4b0ef8297799540732e77c0b180e3a870a954aa271910091580509dfa2f7bc8',
  },
  {
    name: 'A4 medium-long render',
    arguments: [440, 0.731, 0.45],
    sha256: '9bea30159da4e1b1083750d327dc05bd26662e76b69e169111e69567b38947dc',
  },
  {
    name: 'C8 maximum velocity',
    arguments: [4_186.009_044_809_578, 1, 0.06],
    sha256: 'bc9238ed451c5279dbd4c5233aea423ad17371b24f19e453a9d843ffe62b69ff',
  },
  {
    name: 'one-sample render',
    arguments: [440, 0.731, 1 / SAMPLE_RATE],
    sha256: 'df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119',
  },
  {
    name: 'fade length minus one',
    arguments: [440, 0.731, 255 / SAMPLE_RATE],
    sha256: '2739b4f24f5c290c8a657e634aa946087a37dcbee054fece1b951976376c9ee8',
  },
  {
    name: 'exact fade length',
    arguments: [440, 0.731, 256 / SAMPLE_RATE],
    sha256: '3591f8a5574b1654f9223ec8e68c4cf6c0a706bef0779d82ddd5fffdc7d2762d',
  },
  {
    name: 'fade length plus one',
    arguments: [440, 0.731, 257 / SAMPLE_RATE],
    sha256: '2152bd8d88f2e9fba7ae2e716bcc35aa5732cea0f61dad7b35e47fa32ba83841',
  },
  {
    name: 'near-zero nonzero velocity',
    arguments: [440, 0.000_001, 0.03],
    sha256: 'd5e3053b08949f5479cdf2e0b502bc8fa9f77d96f6aef3604920908411c0939e',
  },
  {
    name: 'frequency clamped below A0',
    arguments: [-1, 0.7, 0.025],
    sha256: 'cc40b010b8453acc4f370ba0d515acaf744017a169026bc2a7599841290684a8',
  },
  {
    name: 'frequency clamped above C8',
    arguments: [99_999, 0.7, 0.025],
    sha256: '49898ab10a3915d7fbae18ae53d49207e22cd11b99bfeec2cfecb49f76218f04',
  },
  {
    name: 'velocity clamped above one',
    arguments: [440, 7, 0.025],
    sha256: 'fe49af03b5b439206eebbb52c09fe80eb4a28c979bb8711c59f0eebc1e8c9c97',
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
    'a82d8fcd45cd69f37ca0ba644540456cfb08f22e3d7253f65e439f3f3662edb8',
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
