import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGarageBandStyleReverb, DEFAULT_REVERB_IR_URL, DEFAULT_REVERB_WET } from '../src/reverb.js';

class FakeNode {
  constructor() { this.connections = []; this.gain = { value: 0, setValueAtTime: (value, time) => { this.gain.value = value; this.gain.time = time; } }; }
  connect(target) { this.connections.push(target); return target; }
  disconnect() { this.connections.length = 0; }
}

test('bundled small-hall response is stereo PCM16 at the synth sample rate', async () => {
  const wav = await readFile(fileURLToPath(DEFAULT_REVERB_IR_URL));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), 44_100);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.ok(wav.length > 200_000 && wav.length < 300_000);
});

test('GarageBand-style reverb builds one dry path and one ConvolverNode path', async () => {
  const gains = [];
  const convolver = new FakeNode();
  const impulse = { duration: 1.359 };
  const context = { currentTime: 4, createGain() { const node = new FakeNode(); gains.push(node); return node; }, createConvolver() { return convolver; }, async decodeAudioData(bytes) { assert.equal(bytes.byteLength, 4); return impulse; } };
  const fetchImpulse = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer });
  const reverb = await createGarageBandStyleReverb(context, { impulseUrl: 'memory:small-hall', fetch: fetchImpulse });
  assert.equal(reverb.convolver, convolver);
  assert.equal(reverb.impulse, impulse);
  assert.equal(convolver.buffer, impulse);
  assert.equal(convolver.normalize, true);
  assert.equal(gains[1].gain.value, 1);
  assert.equal(gains[2].gain.value, DEFAULT_REVERB_WET);
  assert.deepEqual(reverb.input.connections, [gains[1], convolver]);
  assert.deepEqual(convolver.connections, [gains[2]]);
  reverb.setWet(2, 9);
  assert.equal(gains[2].gain.value, 1);
  assert.equal(gains[2].gain.time, 9);
});
