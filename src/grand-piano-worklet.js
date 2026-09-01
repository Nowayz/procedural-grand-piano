class GrandPianoProcessor extends AudioWorkletProcessor {
 constructor(options) { super(); const processorOptions = options.processorOptions; this.wasm = new WebAssembly.Instance(processorOptions.wasmModule).exports; this.wasm._initialize(); new Uint8Array(this.wasm.memory.buffer, this.wasm.calibration_ptr(), processorOptions.calibrationBytes.length).set(processorOptions.calibrationBytes); this.output = new Float32Array(this.wasm.memory.buffer, this.wasm.rt_output_ptr(), 128); this.wasm.rt_reset(sampleRate, processorOptions.polyphony); this.port.onmessage = this.receive.bind(this); }
 delayFrames(when) { return Math.max(0, Math.round((when - currentTime) * sampleRate)); }
 receive({ data }) {
  if (!data || typeof data.type !== 'string') return;
  if (data.type === 'noteOn') { this.wasm.rt_note_on(data.id, data.note_hz, data.velocity, this.delayFrames(data.when)); return; }
  if (data.type === 'noteOff') { this.wasm.rt_note_off(data.id, data.release_velocity, this.delayFrames(data.when)); return; }
  if (data.type === 'sustain') { this.wasm.rt_sustain(data.down, this.delayFrames(data.when)); return; }
  if (data.type === 'reset') this.wasm.rt_reset(sampleRate, this.wasm.rt_voice_limit());
 }
 process(_inputs, outputs) { const output = outputs[0][0], frameCount = output.length; this.wasm.rt_process(frameCount); let index = 0; for (; index + 3 < frameCount; index += 4) { output[index] = this.output[index]; output[index + 1] = this.output[index + 1]; output[index + 2] = this.output[index + 2]; output[index + 3] = this.output[index + 3]; } for (; index < frameCount; index += 1) output[index] = this.output[index]; return true; }
}

registerProcessor('procedural-grand-piano', GrandPianoProcessor);
