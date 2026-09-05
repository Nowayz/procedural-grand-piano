import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance as clock } from 'node:perf_hooks';
import { parseStandardMidi, renderMidiPerformance } from '../../tools/midi-performance.mjs';
import { readWav, writeMonoPcm16Wav, writeStereoPcm16Wav } from '../../tools/audio-analysis.mjs';
import { applyConvolverReverb } from '../../tools/convolution-reverb.mjs';
import { DEFAULT_REVERB_IR_URL, DEFAULT_REVERB_WET, DEFAULT_REVERB_NAME } from '../../src/reverb.js';

const file = name => new URL(name, import.meta.url);
const irSource = JSON.parse(await readFile(new URL('../../src/impulse-responses/bricasti-m7-boston-hall-a.json', import.meta.url), 'utf8'));
const midi = await readFile(new URL('../../scores/river-flows-in-you/river-flows-in-you.mid', import.meta.url));
const score = parseStandardMidi(midi);
console.log(`Rendering ${score.noteCount} notes, ${score.durationSeconds.toFixed(2)} seconds`);
const started = clock.now();
const rendered = renderMidiPerformance(score);
if (rendered.clippedFrames || rendered.truncatedVoices) throw new Error('Clipped or truncated source render');
await writeMonoPcm16Wav(file('river-flows-in-you-dry.wav'), rendered.mono, rendered.sampleRate);
const impulse = await readWav(DEFAULT_REVERB_IR_URL, { preserveChannels: true });
if (impulse.sampleRate !== rendered.sampleRate || impulse.channels !== 2) throw new Error('Expected a stereo IR at the render sample rate');
const impulseFrames = impulse.samples.length;
const left = new Float32Array(rendered.mono.length + impulse.channelSamples[0].length - 1);
for (let i = 0; i < rendered.mono.length; i++) left[i] = rendered.mono[i] * Math.SQRT1_2;
const right = left.slice();
const reverb = applyConvolverReverb(left, right, impulse.channelSamples[0], impulse.channelSamples[1], {
  wet: DEFAULT_REVERB_WET, normalize: true, master: false, sampleRate: rendered.sampleRate,
});
let peak = 0, dryEnergy = 0, wetEnergy = 0;
for (let i = 0; i < left.length; i++) {
  if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) throw new Error('Non-finite audio');
  peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  const dry = (rendered.mono[i] ?? 0) * Math.SQRT1_2;
  dryEnergy += 2 * dry * dry;
  wetEnergy += (left[i] - dry) ** 2 + (right[i] - dry) ** 2;
}
if (!(peak > 0)) throw new Error('Silent render');
const gain = 10 ** (-1.5 / 20) / peak;
for (let i = 0; i < left.length; i++) { left[i] *= gain; right[i] *= gain; }
await writeStereoPcm16Wav(file('river-flows-in-you.wav'), left, right, rendered.sampleRate);
const report = {
  title: 'River Flows in You', composer: 'Yiruma',
  midiSourcePage: 'https://bitmidi.com/yiruma-rivers-flow-in-you-mid',
  midiSourceUrl: 'https://bitmidi.com/uploads/112145.mid',
  midiSha256: createHash('sha256').update(midi).digest('hex'),
  runtimeSha256: createHash('sha256').update(await readFile(new URL('../../src/grand-piano.js', import.meta.url))).digest('hex'),
  engine: 'Procedural grand piano with continuous radiation, string-mass, and felt curves',
  noteCount: score.noteCount, midiTrackCount: score.trackCount,
  midiDurationSeconds: score.durationSeconds, renderedDurationSeconds: left.length / rendered.sampleRate,
  sampleRate: rendered.sampleRate, maximumVoices: rendered.maximumVoices,
  clippedSourceFrames: rendered.clippedFrames, truncatedVoices: rendered.truncatedVoices,
  sustainEvents: score.controls.filter(event => event.type === 'sustain').length,
  performance: 'Original MIDI timing, velocity, and articulation retained; no pedal events added',
  reverb: {
    ...irSource, name: DEFAULT_REVERB_NAME, wet: DEFAULT_REVERB_WET, fullTail: true, impulseDurationSeconds: impulseFrames / rendered.sampleRate,
    wetToDryRmsDb: 10 * Math.log10(wetEnergy / dryEnergy),
    preparedSha256: createHash('sha256').update(await readFile(DEFAULT_REVERB_IR_URL)).digest('hex'),
    ...reverb,
  },
  mastering: { method: 'Constant gain only', gainDb: 20 * Math.log10(gain), samplePeakDbFS: -1.5 },
  renderingSeconds: (clock.now() - started) / 1000,
};
await writeFile(file('render-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
