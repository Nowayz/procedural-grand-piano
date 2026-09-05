export const DEFAULT_REVERB_NAME = 'Bricasti M7 Boston Hall A';
export const DEFAULT_REVERB_IR_URL = new URL('./impulse-responses/bricasti-m7-boston-hall-a.wav', import.meta.url);
export const BOSTON_HALL_B_IR_URL = new URL('./impulse-responses/bricasti-m7-boston-hall-b.wav', import.meta.url);
export const DEFAULT_REVERB_WET = 0.28;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export async function createPianoReverb(context, { impulseUrl = DEFAULT_REVERB_IR_URL, wet = DEFAULT_REVERB_WET, normalize = true, fetch: fetchImpulse = globalThis.fetch } = {}) {
  if (!context || typeof context.createConvolver !== 'function' || typeof context.decodeAudioData !== 'function') throw new TypeError('context must be a Web Audio AudioContext');
  if (typeof fetchImpulse !== 'function') throw new TypeError('fetch is unavailable');
  const response = await fetchImpulse(impulseUrl);
  if (!response.ok) throw new Error(`unable to load reverb impulse response: ${response.status} ${response.statusText}`);
  const impulse = await context.decodeAudioData(await response.arrayBuffer());
  const input = context.createGain();
  const dryGain = context.createGain();
  const convolver = context.createConvolver();
  const wetGain = context.createGain();
  const output = context.createGain();
  convolver.normalize = Boolean(normalize);
  convolver.buffer = impulse;
  dryGain.gain.value = 1;
  wetGain.gain.value = clamp(wet, 0, 1);
  input.connect(dryGain);
  input.connect(convolver);
  dryGain.connect(output);
  convolver.connect(wetGain);
  wetGain.connect(output);
  return { input, output, convolver, impulse, connect(destination) { output.connect(destination); return destination; }, disconnect() { input.disconnect(); dryGain.disconnect(); convolver.disconnect(); wetGain.disconnect(); output.disconnect(); }, setWet(value, when = context.currentTime) { wetGain.gain.setValueAtTime(clamp(value, 0, 1), when); } };
}

// Preserve the original public entry point while following the shared default.
export const createGarageBandStyleReverb = createPianoReverb;
