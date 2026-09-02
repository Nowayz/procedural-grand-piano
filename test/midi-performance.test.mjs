import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStandardMidi, renderMidiPerformance } from '../tools/midi-performance.mjs';

function midiFile(track, division = 480) { const header = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, division >> 8, division & 255]), chunk = Buffer.alloc(8); chunk.write('MTrk'); chunk.writeUInt32BE(track.length, 4); return Buffer.concat([header, chunk, Buffer.from(track)]); }

test('Standard MIDI tempo, running status, notes, and sustain become timed controls', () => {
 const bytes = midiFile([0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, 0x00, 0x90, 60, 100, 0x00, 64, 80, 0x81, 0x70, 0xb0, 64, 127, 0x81, 0x70, 0x80, 60, 32, 0x00, 64, 0, 0x83, 0x60, 0xb0, 64, 0, 0x00, 0xff, 0x2f, 0]); const parsed = parseStandardMidi(bytes); assert.equal(parsed.noteCount, 2); assert.equal(parsed.trackCount, 1); assert.deepEqual(parsed.controls.map(({ type, seconds }) => [type, seconds]), [['noteOn', 0], ['noteOn', 0], ['sustain', .25], ['noteOff', .5], ['noteOff', .5], ['sustain', 1]]); assert.equal(parsed.controls[0].midi, 60); assert.equal(parsed.controls[1].midi, 64); assert.equal(parsed.controls[3].velocity, 32 / 127); assert.equal(parsed.controls[4].velocity, 64 / 127);
});

test('equal-tick note controls retain source order and pair overlapping strikes', () => {
 const bytes = midiFile([0x00, 0x90, 60, 100, 0x83, 0x60, 0x90, 60, 90, 0x00, 0x80, 60, 20, 0x00, 0x80, 60, 30, 0x00, 0xff, 0x2f, 0]), parsed = parseStandardMidi(bytes); assert.deepEqual(parsed.controls.map(({ type, id, seconds }) => [type, id, seconds]), [['noteOn', 1, 0], ['noteOn', 2, .5], ['noteOff', 1, .5], ['noteOff', 2, .5]]); assert.deepEqual(parsed.controls.slice(2).map(({ velocity }) => velocity), [20 / 127, 30 / 127]);
});

test('parsed MIDI renders through the persistent realtime voice engine', () => {
 const bytes = midiFile([0x00, 0x90, 69, 100, 0x83, 0x60, 0x80, 69, 0, 0x00, 0xff, 0x2f, 0]); const parsed = parseStandardMidi(bytes), rendered = renderMidiPerformance(parsed, { tailSeconds: .2, polyphony: 4 }); assert.equal(rendered.sampleRate, 44_100); assert.ok(rendered.mono.some((sample) => sample !== 0)); assert.ok(rendered.mono.every(Number.isFinite)); assert.equal(rendered.clippedFrames, 0); assert.equal(rendered.maximumVoices, 1); assert.equal(rendered.truncatedVoices, 0); assert.ok(rendered.mono.length > Math.round((parsed.durationSeconds + .2) * rendered.sampleRate));
});

test('MIDI rendering releases incomplete input and reports a forced tail cap', () => {
 const performance = { controls: [{ type: 'noteOn', seconds: 0, id: 1, frequency: 261.625565, velocity: .8 }], durationSeconds: .01 }, rendered = renderMidiPerformance(performance, { tailSeconds: 0, maximumTailSeconds: .1, polyphony: 2 }); assert.equal(rendered.truncatedVoices, 1); assert.equal(rendered.mono.length, Math.round(.11 * rendered.sampleRate)); assert.ok(Math.abs(rendered.mono.at(-1)) < 1e-7);
});

test('adaptive MIDI tails retain the natural decay of a damperless treble key', () => {
 const frequency = 440 * 2 ** ((91 - 69) / 12), performance = { controls: [{ type: 'noteOn', seconds: 0, id: 1, frequency, velocity: .8 }, { type: 'noteOff', seconds: .01, id: 1, velocity: 1 }], durationSeconds: .01 }, rendered = renderMidiPerformance(performance, { tailSeconds: 0, maximumTailSeconds: 12, polyphony: 2 }); assert.equal(rendered.truncatedVoices, 0); assert.ok(rendered.mono.length > 5 * rendered.sampleRate, `natural tail is ${rendered.mono.length / rendered.sampleRate} seconds`); assert.ok(rendered.mono.length < 12.01 * rendered.sampleRate);
});

test('malformed and unsupported MIDI inputs are rejected', () => {
 assert.throws(() => parseStandardMidi(new Uint8Array()), /header/); const smpte = midiFile([0, 0xff, 0x2f, 0], 0xe728); assert.throws(() => parseStandardMidi(smpte), /SMPTE/);
});
