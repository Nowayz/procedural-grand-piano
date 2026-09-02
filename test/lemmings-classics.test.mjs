import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { LEMMINGS_CLASSICS } from '../tools/generate-lemmings-classics.mjs';
import { readWav } from '../tools/audio-analysis.mjs';

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

test('Lemmings tracks use a native-rate stereo studio-room impulse response', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const impulse = await readWav(
    path.join(root, 'src/impulse-responses/genesis-6-studio-room.wav'),
    { preserveChannels: true },
  );
  assert.equal(impulse.sampleRate, 44_100);
  assert.equal(impulse.channels, 2);
  assert.equal(impulse.channelSamples[0].length, 2 * impulse.sampleRate);
});
