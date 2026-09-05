import assert from 'node:assert/strict';
import test from 'node:test';
import { LEMMINGS_CLASSICS } from '../tools/generate-lemmings-classics.mjs';
import { readWav } from '../tools/audio-analysis.mjs';
import { DEFAULT_REVERB_IR_URL } from '../src/reverb.js';

test('Lemmings classical set contains three distinct public-domain works', () => {
  assert.equal(LEMMINGS_CLASSICS.length, 3);
  assert.deepEqual(LEMMINGS_CLASSICS.map(({ tempoBpm }) => tempoBpm), [175, 120, 120]);
  assert.equal(new Set(LEMMINGS_CLASSICS.map(({ output }) => output)).size, 3);
  for (const track of LEMMINGS_CLASSICS) {
    assert.match(track.license, /public domain/i);
    assert.match(track.scoreUrl, /^https:\/\//);
    assert.match(track.midiUrl, /^https:\/\//);
    assert.match(track.output, /^lemmings-.+-procedural\.wav$/);
    assert.ok(track.tempoBpm > track.sourceBpm);
  }
});

test('Lemmings tracks use the shared native-rate stereo hall impulse response', async () => {
  const impulse = await readWav(
    DEFAULT_REVERB_IR_URL,
    { preserveChannels: true },
  );
  assert.equal(impulse.sampleRate, 44_100);
  assert.equal(impulse.channels, 2);
  assert.equal(impulse.channelSamples[0].length, 171796);
});
