import { createGrandPianoProcessorOptions } from './grand-piano.js';

export const GRAND_PIANO_WORKLET_URL = new URL('./grand-piano-worklet.js', import.meta.url);
export const REALTIME_SCHEDULING_LEAD_SECONDS = 0.02;

function requireContext(context) {
 if (!context || !context.audioWorklet || typeof context.audioWorklet.addModule !== 'function') throw new TypeError('context must provide AudioWorklet');
}

function requireFiniteNumber(name, value) {
 if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`);
}

class RealtimeGrandPiano {
 constructor(context, node) { this.context = context; this.node = node; }
 noteOn(id, note_hz, velocity, when = this.context.currentTime) { requireFiniteNumber('id', id); requireFiniteNumber('note_hz', note_hz); requireFiniteNumber('velocity', velocity); requireFiniteNumber('when', when); this.node.port.postMessage({ type: 'noteOn', id, note_hz, velocity, when }); return this; }
 noteOff(id, release_velocity = 64 / 127, when = this.context.currentTime) { requireFiniteNumber('id', id); requireFiniteNumber('release_velocity', release_velocity); requireFiniteNumber('when', when); this.node.port.postMessage({ type: 'noteOff', id, release_velocity, when }); return this; }
 sustain(down, when = this.context.currentTime) { requireFiniteNumber('when', when); this.node.port.postMessage({ type: 'sustain', down: Boolean(down), when }); return this; }
 reset() { this.node.port.postMessage({ type: 'reset' }); return this; }
 connect(destination, output = 0, input = 0) { return this.node.connect(destination, output, input); }
 disconnect(...arguments_) { this.node.disconnect(...arguments_); }
 destroy() { this.reset(); this.node.disconnect(); this.node.port.close(); }
}

export async function createRealtimeGrandPiano(context, { workletUrl = GRAND_PIANO_WORKLET_URL, polyphony = 32 } = {}) {
 requireContext(context); requireFiniteNumber('polyphony', polyphony); await context.audioWorklet.addModule(workletUrl);
 const voiceCount = Math.max(1, Math.min(64, Math.trunc(polyphony)));
 const node = new AudioWorkletNode(context, 'procedural-grand-piano', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', processorOptions: createGrandPianoProcessorOptions(voiceCount) });
 return new RealtimeGrandPiano(context, node);
}

export default createRealtimeGrandPiano;
