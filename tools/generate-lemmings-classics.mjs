#!/usr/bin/env node

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav, writeStereoPcm16Wav } from './audio-analysis.mjs';
import { applyConvolverReverb } from './convolution-reverb.mjs';
import { parseStandardMidi, renderMidiPerformance } from './midi-performance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoRoot = path.join(root, 'demos');
const STUDIO_ROOM_IR_URL = new URL(
  '../src/impulse-responses/genesis-6-studio-room.wav',
  import.meta.url,
);
const STUDIO_ROOM_WET = 0.18;

export const LEMMINGS_CLASSICS = Object.freeze([
  Object.freeze({
    title: 'Galop infernal (Can-Can)',
    composer: 'Jacques Offenbach (1819–1880)',
    lemmingsTrack: 'CanCan',
    output: 'lemmings-can-can-procedural.wav',
    scoreUrl: 'https://imslp.org/wiki/Orph%C3%A9e_aux_enfers_(Offenbach%2C_Jacques)',
    midiUrl: 'https://abcnotation.com/getResource/downloads/media/the-galop.mid?a=trillian.mit.edu%2F~jc%2Fmusic%2Fabc%2Fclassical%2FOffenbach_Jacques%2FGalop%2F0000',
    midiCredit: 'John Chambers ABC transcription (2014)',
    sourceBpm: 120,
    tempoBpm: 175,
    license: 'Composition public domain; newly rendered procedural performance',
  }),
  Object.freeze({
    title: 'Rondo alla Turca, K. 331',
    composer: 'Wolfgang Amadeus Mozart (1756–1791)',
    lemmingsTrack: 'Rondo Alla Turca',
    output: 'lemmings-rondo-alla-turca-procedural.wav',
    scoreUrl: 'https://www.mutopiaproject.org/cgibin/make-table.cgi?searchingfor=turca',
    midiUrl: 'https://www.mutopiaproject.org/ftp/MozartWA/KV331/KV331_3_RondoAllaTurca/KV331_3_RondoAllaTurca.mid',
    midiCredit: 'Mutopia public-domain edition, Rune Zedeler and Chris Sawer',
    sourceBpm: 60,
    tempoBpm: 120,
    license: 'Public domain (composition and Mutopia typesetting)',
  }),
  Object.freeze({
    title: 'Dance of the Reed Flutes, Op. 71a',
    composer: 'Pyotr Ilyich Tchaikovsky (1840–1893)',
    lemmingsTrack: 'Dance of the Reed Flutes',
    output: 'lemmings-dance-of-the-reed-flutes-procedural.wav',
    scoreUrl: 'https://commons.wikimedia.org/wiki/File:Dance_of_the_Reed_Flutes_Peter_Ilyich_Tchaikovsky_1918_Piano_Duet.pdf',
    midiUrl: 'https://www.flutetunes.com/tunes/tchaikovsky-the-nutcracker-dance-of-the-mirlitons.mid',
    midiCredit: 'FluteTunes symbolic edition',
    sourceBpm: 72,
    tempoBpm: 120,
    license: 'Composition and cited 1918 piano-duet score public domain; newly rendered procedural performance',
  }),
]);

async function fetchMidi(track) {
  const response = await fetch(track.midiUrl);
  if (!response.ok) throw new Error(`could not fetch ${track.title}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function renderTrack(track, impulse) {
  console.log(`rendering ${track.composer} — ${track.title} at ${track.tempoBpm} BPM`);
  const midi = await fetchMidi(track);
  const performance = parseStandardMidi(midi);
  const tempoScale = track.sourceBpm / track.tempoBpm;
  for (const control of performance.controls) control.seconds *= tempoScale;
  performance.durationSeconds *= tempoScale;
  const rendered = renderMidiPerformance(performance);
  const left = new Float32Array(rendered.mono.length);
  const right = new Float32Array(rendered.mono.length);
  for (let index = 0; index < rendered.mono.length; index += 1) {
    left[index] = right[index] = rendered.mono[index] * Math.SQRT1_2;
  }

  const reverb = applyConvolverReverb(
    left,
    right,
    impulse.channelSamples[0],
    impulse.channelSamples[1],
    { wet: STUDIO_ROOM_WET, normalize: true, sampleRate: rendered.sampleRate },
  );
  const destination = path.join(demoRoot, track.output);
  await writeStereoPcm16Wav(destination, left, right, rendered.sampleRate);
  console.log(
    `wrote ${path.relative(root, destination)} ` +
    `(${(rendered.mono.length / rendered.sampleRate).toFixed(2)} s, ` +
    `${performance.noteCount} notes, reverb gain ${reverb.normalizationScale.toFixed(4)})`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(demoRoot, { recursive: true });
  const impulse = await readWav(fileURLToPath(STUDIO_ROOM_IR_URL), { preserveChannels: true });
  for (const track of LEMMINGS_CLASSICS) await renderTrack(track, impulse);
}
