class GrandPianoProcessor extends AudioWorkletProcessor {
 constructor(options) { super(); const processorOptions = options.processorOptions; this.wasm = new WebAssembly.Instance(processorOptions.wasmModule).exports; this.wasm._initialize(); this.output = new Float32Array(this.wasm.memory.buffer, this.wasm.rt_output_ptr(), 128); this.left = new Float32Array(this.wasm.memory.buffer, this.wasm.rt_output_left_ptr(), 128); this.right = new Float32Array(this.wasm.memory.buffer, this.wasm.rt_output_right_ptr(), 128); this.wasm.rt_reset(sampleRate, processorOptions.polyphony); this.port.onmessage = this.receive.bind(this); }
 delayFrames(when) { return Math.max(0, Math.round((when - currentTime) * sampleRate)); }
 receive({ data }) {
  if (!data || typeof data.type !== 'string') return;
  if (data.type === 'noteOn') { this.wasm.rt_note_on(data.id, data.note_hz, data.velocity, this.delayFrames(data.when)); return; }
  if (data.type === 'noteOff') { this.wasm.rt_note_off(data.id, data.release_velocity, this.delayFrames(data.when)); return; }
  if (data.type === 'sustain') { this.wasm.rt_sustain(data.position ?? Number(data.down), this.delayFrames(data.when)); return; }
  if (data.type === 'unaCorda') { this.wasm.rt_una_corda(data.position ?? Number(data.down), this.delayFrames(data.when)); return; }
  if (data.type === 'keyPosition') { this.wasm.rt_key_position(data.id, data.position, data.speed, this.delayFrames(data.when)); return; }
  if (data.type === 'reset') this.wasm.rt_reset(sampleRate, this.wasm.rt_voice_limit());
 }
 process(_inputs, outputs) { const channels = outputs[0], left = channels[0], right = channels[1], frameCount = left.length; this.wasm.rt_process(frameCount); let index = 0; for (; index + 3 < frameCount; index += 4) { left[index] = right ? this.left[index] : this.output[index]; left[index + 1] = right ? this.left[index + 1] : this.output[index + 1]; left[index + 2] = right ? this.left[index + 2] : this.output[index + 2]; left[index + 3] = right ? this.left[index + 3] : this.output[index + 3]; if (right) { right[index] = this.right[index]; right[index + 1] = this.right[index + 1]; right[index + 2] = this.right[index + 2]; right[index + 3] = this.right[index + 3]; } } for (; index < frameCount; index += 1) { left[index] = right ? this.left[index] : this.output[index]; if (right) right[index] = this.right[index]; } return true; }
}

registerProcessor('procedural-grand-piano', GrandPianoProcessor);
