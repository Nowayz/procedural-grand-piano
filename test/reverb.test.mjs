import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPianoReverb, createGarageBandStyleReverb, DEFAULT_REVERB_IR_URL, DEFAULT_REVERB_WET } from '../src/reverb.js';
import { createHash } from 'node:crypto';
import { readWav } from '../tools/audio-analysis.mjs';

class FakeNode {
  constructor() { this.connections = []; this.gain = { value: 0, setValueAtTime: (value, time) => { this.gain.value = value; this.gain.time = time; } }; }
  connect(target) { this.connections.push(target); return target; }
  disconnect() { this.connections.length = 0; }
}

test('default Boston Hall A asset preserves the full native stereo float capture', async () => {
  const wav = await readFile(fileURLToPath(DEFAULT_REVERB_IR_URL));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 3);
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), 44_100);
  assert.equal(wav.readUInt16LE(34), 32);
  const metadata = JSON.parse(await readFile(new URL('../src/impulse-responses/bricasti-m7-boston-hall-a.json', import.meta.url), 'utf8'));
  assert.equal(createHash('sha256').update(wav).digest('hex'), metadata.sha256);
  const impulse = await readWav(DEFAULT_REVERB_IR_URL, { preserveChannels: true });
  assert.equal(impulse.samples.length, 171796);
  assert.ok(impulse.samples.every(Number.isFinite));
  assert.notDeepEqual(impulse.channelSamples[0], impulse.channelSamples[1]);
  assert.equal(DEFAULT_REVERB_WET, .28);
});

test('piano reverb uses the shared IR and send, retaining its compatibility alias', async () => {
  assert.equal(createGarageBandStyleReverb, createPianoReverb);
  const gains = [];
  const convolver = new FakeNode();
  const impulse = { duration: 3.896 };
  const context = { currentTime: 4, createGain() { const node = new FakeNode(); gains.push(node); return node; }, createConvolver() { return convolver; }, async decodeAudioData(bytes) { assert.equal(bytes.byteLength, 4); return impulse; } };
  const fetchImpulse = async (url) => { assert.equal(url, DEFAULT_REVERB_IR_URL); return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }; };
  const reverb = await createPianoReverb(context, { fetch: fetchImpulse });
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
