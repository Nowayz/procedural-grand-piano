import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARPEGGIO_MEASURES,
  buildBwv846Performance,
  CADENCE_MEASURES,
  FINAL_CHORD,
  SCORE_PROVENANCE,
} from '../tools/bwv846-performance.mjs';

test('public-domain score plan contains the complete 35-measure prelude', () => {
  const performance = buildBwv846Performance();
  assert.equal(ARPEGGIO_MEASURES.length, 32);
  assert.equal(CADENCE_MEASURES.length, 2);
  assert.equal(FINAL_CHORD.length, 5);
  assert.equal(performance.measureCount, 35);
  assert.equal(performance.measureStarts.length, 35);
  assert.equal(performance.events.length, 549);
  assert.deepEqual(performance.events.slice(0, 8).map(({ midi }) => midi),
    [60, 64, 67, 72, 76, 67, 72, 76]);
  assert.deepEqual(performance.events.slice(-5).map(({ midi }) => midi), FINAL_CHORD);
});

test('full-piece performance is deterministic, expressive, and piano-ranged', () => {
  const first = buildBwv846Performance();
  const second = buildBwv846Performance();
  assert.deepEqual(first, second);

  const pitches = first.events.map(({ midi }) => midi);
  const velocities = first.events.map(({ velocity }) => velocity);
  assert.equal(Math.min(...pitches), 36);
  assert.equal(Math.max(...pitches), 81);
  assert.ok(Math.min(...velocities) >= 0.32);
  assert.ok(Math.max(...velocities) <= 0.88);
  assert.ok(new Set(velocities.map((velocity) => velocity.toFixed(3))).size > 100);
  assert.ok(first.durationSeconds >= 150 && first.durationSeconds <= 170);
});

test('score provenance identifies a public-domain edition and source', () => {
  assert.match(SCORE_PROVENANCE.license, /public domain/i);
  assert.match(SCORE_PROVENANCE.scoreUrl, /^https:\/\//);
  assert.match(SCORE_PROVENANCE.sourceUrl, /^https:\/\//);
});
