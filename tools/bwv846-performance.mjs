import { SAMPLE_RATE, synthesizeGrandPiano } from '../src/grand-piano.js';

export const TRACK_TITLE = 'J. S. Bach — Prelude in C major, BWV 846';

export const SCORE_PROVENANCE = Object.freeze({
  composer: 'Johann Sebastian Bach (1685–1750)',
  work: 'Prelude in C major, BWV 846, from The Well-Tempered Clavier, Book I',
  edition: 'Mutopia 2011/09/12 public-domain LilyPond edition, hosted by Wikisource',
  scoreUrl: 'https://wikisource.org/wiki/Prelude_in_C_major,_BWV_846',
  sourceUrl: 'https://wikisource.org/w/index.php?title=Prelude_in_C_major,_BWV_846&action=raw',
  license: 'Public domain (PD-old; typesetting marked Public Domain)',
});

// Measures 1–32 reduce to a five-note sonority played with the canonical
// 0,1,2,3,4,2,3,4 pattern twice. MIDI pitches were transcribed from the
// public-domain LilyPond source above; this data contains no performance audio.
export const ARPEGGIO_MEASURES = Object.freeze([
  [60, 64, 67, 72, 76],
  [60, 62, 69, 74, 77],
  [59, 62, 67, 74, 77],
  [60, 64, 67, 72, 76],
  [60, 64, 69, 76, 81],
  [60, 62, 66, 69, 74],
  [59, 62, 67, 74, 79],
  [59, 60, 64, 67, 72],
  [57, 60, 64, 67, 72],
  [50, 57, 62, 66, 72],
  [55, 59, 62, 67, 71],
  [55, 58, 64, 67, 73],
  [53, 57, 62, 69, 74],
  [53, 56, 62, 65, 71],
  [52, 55, 60, 67, 72],
  [52, 53, 57, 60, 65],
  [50, 53, 57, 60, 65],
  [43, 50, 55, 59, 65],
  [48, 52, 55, 60, 64],
  [48, 55, 58, 60, 64],
  [41, 53, 57, 60, 64],
  [42, 48, 57, 60, 63],
  [44, 53, 59, 60, 62],
  [43, 53, 55, 59, 62],
  [43, 52, 55, 60, 64],
  [43, 50, 55, 60, 65],
  [43, 50, 55, 59, 65],
  [43, 51, 57, 60, 66],
  [43, 52, 55, 60, 67],
  [43, 50, 55, 60, 65],
  [43, 50, 55, 59, 65],
  [36, 48, 55, 58, 64],
].map(Object.freeze));

export const CADENCE_MEASURES = Object.freeze([
  Object.freeze([36, 48, 53, 57, 60, 65, 60, 57, 60, 57, 53, 57, 53, 50, 53, 50]),
  Object.freeze([36, 47, 67, 71, 74, 77, 74, 71, 74, 71, 67, 71, 62, 65, 64, 62]),
]);

export const FINAL_CHORD = Object.freeze([36, 48, 64, 67, 72]);

const ARPEGGIO_PATTERN = Object.freeze([0, 1, 2, 3, 4, 2, 3, 4]);
const TEMPI_BPM = Object.freeze([
  58, 59, 60, 59, 60, 60, 59, 58,
  58, 57, 58, 57, 57, 56, 57, 56,
  56, 55, 57, 55, 56, 54, 55, 53,
  56, 57, 56, 55, 57, 55, 53, 50,
  48, 44,
]);
const INTENSITIES = Object.freeze([
  0.48, 0.49, 0.50, 0.49, 0.53, 0.54, 0.55, 0.52,
  0.50, 0.52, 0.54, 0.56, 0.58, 0.60, 0.57, 0.52,
  0.50, 0.53, 0.56, 0.59, 0.61, 0.64, 0.67, 0.62,
  0.57, 0.60, 0.63, 0.66, 0.68, 0.65, 0.69, 0.75,
  0.73, 0.80,
]);
const PATTERN_ACCENTS = Object.freeze([0.055, 0.018, -0.016, 0, 0.024, -0.025, -0.008, 0.017]);
const LEAD_IN_SECONDS = 0.55;
const FINAL_HOLD_SECONDS = 7.2;
const ROOM_TAIL_SECONDS = 2.8;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function stepTimeline(measureDuration, measureIndex) {
  const weights = [];
  for (let step = 0; step < 16; step += 1) {
    const breathing = 1 + 0.012 * Math.sin(0.91 * step + 0.63 * measureIndex);
    const beatShape = [1.018, 0.988, 0.994, 1, 1.01, 0.99, 0.996, 1.004][step % 8];
    const cadenceRall = measureIndex >= 32
      ? 0.86 + (0.30 + 0.08 * (measureIndex - 32)) * step / 15
      : 1;
    weights.push(breathing * beatShape * cadenceRall);
  }

  const scale = measureDuration / weights.reduce((sum, value) => sum + value, 0);
  const offsets = [0];
  for (const weight of weights) offsets.push(offsets.at(-1) + weight * scale);
  return offsets;
}

function addEvent(events, measure, step, midi, start, duration, velocity, gain = 1) {
  events.push({
    measure,
    step,
    midi,
    frequency: midiToFrequency(midi),
    start,
    duration,
    velocity: clamp(velocity, 0.32, 0.88),
    gain,
  });
}

/** Build the complete deterministic 35-measure performance without rendering audio. */
export function buildBwv846Performance() {
  const events = [];
  const measureStarts = [];
  let cursor = LEAD_IN_SECONDS;

  for (let measureIndex = 0; measureIndex < ARPEGGIO_MEASURES.length; measureIndex += 1) {
    const measureNumber = measureIndex + 1;
    const pitches = ARPEGGIO_MEASURES[measureIndex];
    const measureDuration = 240 / TEMPI_BPM[measureIndex];
    const offsets = stepTimeline(measureDuration, measureIndex);
    measureStarts.push(cursor);

    for (let step = 0; step < 16; step += 1) {
      const patternStep = step % 8;
      const midi = pitches[ARPEGGIO_PATTERN[patternStep]];
      const start = cursor + offsets[step];
      const pedalBoundary = cursor + offsets[step < 8 ? 8 : 16];
      const pedalOverlap = 0.29 + 0.07 * (1 - midi / 108);
      const duration = pedalBoundary + pedalOverlap - start;
      const secondHalfBreath = step >= 8 ? -0.006 : 0;
      const longArc = 0.008 * Math.sin((measureIndex + step / 16) * Math.PI / 3.7);
      const velocity = INTENSITIES[measureIndex] + PATTERN_ACCENTS[patternStep] +
        secondHalfBreath + longArc;
      addEvent(events, measureNumber, step, midi, start, duration, velocity, 0.32);
    }
    cursor += measureDuration;
  }

  for (let cadenceIndex = 0; cadenceIndex < CADENCE_MEASURES.length; cadenceIndex += 1) {
    const measureIndex = ARPEGGIO_MEASURES.length + cadenceIndex;
    const measureNumber = measureIndex + 1;
    const measureDuration = 240 / TEMPI_BPM[measureIndex];
    const offsets = stepTimeline(measureDuration, measureIndex);
    measureStarts.push(cursor);

    for (let step = 0; step < 16; step += 1) {
      const midi = CADENCE_MEASURES[cadenceIndex][step];
      const start = cursor + offsets[step];
      const duration = cursor + measureDuration + 0.42 - start;
      const contour = cadenceIndex === 0
        ? 0.018 * step / 15
        : 0.035 * Math.sin(Math.PI * step / 15);
      const bassAccent = step < 2 ? 0.045 : 0;
      addEvent(
        events,
        measureNumber,
        step,
        midi,
        start,
        duration,
        INTENSITIES[measureIndex] + contour + bassAccent,
        0.32,
      );
    }
    cursor += measureDuration;
  }

  measureStarts.push(cursor);
  for (let index = 0; index < FINAL_CHORD.length; index += 1) {
    const midi = FINAL_CHORD[index];
    const rollOffset = index * 0.021;
    addEvent(
      events,
      35,
      index,
      midi,
      cursor + rollOffset,
      FINAL_HOLD_SECONDS - rollOffset,
      0.68 + index * 0.018,
      0.35,
    );
  }

  const musicalEndSeconds = cursor + FINAL_HOLD_SECONDS;
  return {
    events,
    measureStarts,
    measureCount: 35,
    musicalEndSeconds,
    durationSeconds: musicalEndSeconds + ROOM_TAIL_SECONDS,
  };
}

function createCombBank(delays) {
  return delays.map((delay, index) => ({
    buffer: new Float64Array(delay),
    position: 0,
    filtered: 0,
    feedback: 0.79 - index * 0.018,
  }));
}

function processCombBank(input, bank) {
  let sum = 0;
  for (const comb of bank) {
    const delayed = comb.buffer[comb.position];
    comb.filtered = delayed * 0.72 + comb.filtered * 0.28;
    comb.buffer[comb.position] = input + comb.filtered * comb.feedback;
    comb.position += 1;
    if (comb.position === comb.buffer.length) comb.position = 0;
    sum += delayed;
  }
  return sum / bank.length;
}

function createAllpass(delay, feedback) {
  return { buffer: new Float64Array(delay), position: 0, feedback };
}

function processAllpass(input, state) {
  const delayed = state.buffer[state.position];
  const output = delayed - input;
  state.buffer[state.position] = input + delayed * state.feedback;
  state.position += 1;
  if (state.position === state.buffer.length) state.position = 0;
  return output;
}

/** Add a small algorithmic room: delay lines only, never an impulse response. */
function applyProceduralRoom(left, right) {
  const leftCombs = createCombBank([1_117, 1_423, 1_613, 1_871]);
  const rightCombs = createCombBank([1_153, 1_481, 1_699, 1_999]);
  const leftAllpasses = [createAllpass(347, 0.62), createAllpass(113, 0.56)];
  const rightAllpasses = [createAllpass(379, 0.62), createAllpass(127, 0.56)];
  const earlyLeft = new Float64Array(3_401);
  const earlyRight = new Float64Array(3_401);
  let earlyPosition = 0;

  const tap = (buffer, delay) => {
    const index = (earlyPosition - delay + buffer.length) % buffer.length;
    return buffer[index];
  };

  for (let index = 0; index < left.length; index += 1) {
    const dryLeft = left[index];
    const dryRight = right[index];
    const earlyReflectionLeft =
      0.11 * tap(earlyLeft, 521) +
      0.075 * tap(earlyRight, 947) +
      0.052 * tap(earlyLeft, 1_591) +
      0.035 * tap(earlyRight, 3_379);
    const earlyReflectionRight =
      0.11 * tap(earlyRight, 557) +
      0.075 * tap(earlyLeft, 1_019) +
      0.052 * tap(earlyRight, 1_699) +
      0.035 * tap(earlyLeft, 3_293);
    earlyLeft[earlyPosition] = dryLeft;
    earlyRight[earlyPosition] = dryRight;
    earlyPosition += 1;
    if (earlyPosition === earlyLeft.length) earlyPosition = 0;

    let lateLeft = processCombBank(0.88 * dryLeft + 0.12 * dryRight, leftCombs);
    let lateRight = processCombBank(0.88 * dryRight + 0.12 * dryLeft, rightCombs);
    for (const allpass of leftAllpasses) lateLeft = processAllpass(lateLeft, allpass);
    for (const allpass of rightAllpasses) lateRight = processAllpass(lateRight, allpass);

    left[index] = dryLeft + earlyReflectionLeft + 0.14 * lateLeft;
    right[index] = dryRight + earlyReflectionRight + 0.14 * lateRight;
  }
}

function masterTrack(left, right) {
  let leftMean = 0;
  let rightMean = 0;
  for (let index = 0; index < left.length; index += 1) {
    leftMean += left[index];
    rightMean += right[index];
  }
  leftMean /= left.length;
  rightMean /= right.length;

  const fadeSamples = Math.round(0.8 * SAMPLE_RATE);
  let peak = 0;
  for (let index = 0; index < left.length; index += 1) {
    let fade = 1;
    if (index >= left.length - fadeSamples) {
      const position = (left.length - 1 - index) / Math.max(1, fadeSamples - 1);
      fade = Math.sin(Math.PI * 0.5 * clamp(position, 0, 1)) ** 2;
    }
    left[index] = (left[index] - leftMean) * fade;
    right[index] = (right[index] - rightMean) * fade;
    peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]));
  }

  const gain = peak > 0 ? 0.92 / peak : 1;
  for (let index = 0; index < left.length; index += 1) {
    left[index] *= gain;
    right[index] *= gain;
  }
  left[0] = 0;
  right[0] = 0;
  left[left.length - 1] = 0;
  right[right.length - 1] = 0;
  return gain;
}

/** Render the complete score to stereo normalized PCM at 44.1 kHz. */
export function renderBwv846Track({ onProgress } = {}) {
  const performance = buildBwv846Performance();
  const frameCount = Math.round(performance.durationSeconds * SAMPLE_RATE);
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);

  for (let eventIndex = 0; eventIndex < performance.events.length; eventIndex += 1) {
    const event = performance.events[eventIndex];
    const rendered = synthesizeGrandPiano(event.frequency, event.velocity, event.duration);
    const start = Math.round(event.start * SAMPLE_RATE);
    const keyboardPan = clamp((event.midi - 60) / 30, -1, 1) * 0.34;
    const panAngle = (keyboardPan + 1) * Math.PI / 4;
    const leftGain = Math.cos(panAngle) * event.gain;
    const rightGain = Math.sin(panAngle) * event.gain;
    const available = Math.min(rendered.length, frameCount - start);
    for (let sample = 0; sample < available; sample += 1) {
      left[start + sample] += rendered[sample] * leftGain;
      right[start + sample] += rendered[sample] * rightGain;
    }
    if (onProgress && ((eventIndex + 1) % 64 === 0 || eventIndex + 1 === performance.events.length)) {
      onProgress(eventIndex + 1, performance.events.length);
    }
  }

  applyProceduralRoom(left, right);
  const masteringGain = masterTrack(left, right);
  return { left, right, performance, masteringGain, sampleRate: SAMPLE_RATE };
}
