import assert from 'node:assert/strict';
import test from 'node:test';
import { getBumblebeeNote, MEASURE_COUNT, NOTE_COUNT, SCORE_PROVENANCE, TEMPO_BPM } from '../tools/bumblebee-performance.mjs';

test('Bumblebee score is complete, fast, and piano-ranged', () => {
  const note = {};
  let minimumMidi = 127;
  let maximumMidi = 0;
  let sixteenthNotes = 0;
  for (let index = 0; index < NOTE_COUNT; index += 1) {
    getBumblebeeNote(index, note);
    minimumMidi = Math.min(minimumMidi, note.midi);
    maximumMidi = Math.max(maximumMidi, note.midi);
    if (note.ticks === 1) sixteenthNotes += 1;
  }
  assert.equal(MEASURE_COUNT, 101);
  assert.equal(NOTE_COUNT, 1_143);
  assert.equal(TEMPO_BPM, 176);
  assert.equal(minimumMidi, 33);
  assert.equal(maximumMidi, 93);
  assert.equal(sixteenthNotes, 772);
});

test('Bumblebee packed score begins with the published chromatic descent', () => {
  const note = {};
  const opening = new Array(8);
  for (let index = 0; index < opening.length; index += 1) { getBumblebeeNote(index, note); opening[index] = note.midi; }
  assert.deepEqual(opening, [88, 87, 86, 85, 86, 85, 84, 83]);
});

test('Bumblebee score provenance identifies public-domain sources', () => {
  assert.match(SCORE_PROVENANCE.license, /public domain/i);
  assert.match(SCORE_PROVENANCE.scoreUrl, /^https:\/\//);
  assert.match(SCORE_PROVENANCE.referenceUrl, /^https:\/\//);
});
