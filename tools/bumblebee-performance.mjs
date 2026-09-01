import { Buffer } from 'node:buffer';
import { SAMPLE_RATE, synthesizeGrandPianoInto } from '../src/grand-piano.js';

export const TRACK_TITLE = 'N. Rimsky-Korsakov — Flight of the Bumblebee';

export const SCORE_PROVENANCE = Object.freeze({ composer: 'Nikolay Rimsky-Korsakov (1844–1908)', work: 'Flight of the Bumblebee, from The Tale of Tsar Saltan, Act III', edition: 'MuseTrainer public-domain MusicXML piano edition (MuseScore 2.3.2 export, 2019-02-28)', scoreUrl: 'https://github.com/sevagh/musicxml-library/blob/master/scores/Flight_of_the_Bumblebee.mxl', referenceUrl: 'https://imslp.org/wiki/Flight_of_the_Bumble-Bee', license: 'Public domain' });

export const MEASURE_COUNT = 101;
export const NOTE_COUNT = 1_143;
export const TEMPO_BPM = 176;

const TICKS_PER_QUARTER = 4;
const SCORE_TICKS = 808;
const LEAD_IN_SECONDS = 0.35;
const ROOM_TAIL_SECONDS = 2.3;
const SECONDS_PER_TICK = 60 / (TEMPO_BPM * TICKS_PER_QUARTER);
const DYNAMIC_TICKS = new Uint16Array([0, 48, 224, 240, 288, 304, 336, 464, 592, 688, 756, 784]);
const DYNAMIC_LEVELS = new Float64Array([0.62, 0.38, 0.68, 0.58, 0.69, 0.38, 0.70, 0.40, 0.78, 0.52, 0.40, 0.38]);
const SCORE_BYTES = Buffer.from('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OIkvADjJMAA8CS8APMkvADzJMABAhRIAQUUSAEIFEgBDxREARAUSAEXFEQBGhREAR0URAECJLgBAiS8AQMkwAESJLQBECS8ARMkvAEiFEQBJxREASgUSAEtFEgBMBRIATUUSAE6FEgBPxRIASMktAEiJLgBIiS8ATEktAExJLgBMiS8AUAUWAFHFFQBShRUAU0UVAFSFFQBVRRUAVgUVAFfFFABQCS0AUAkuAFAJMABYBRUAWcUUAFqFFABbRRQAXAUUAF3FEwBehRMAX0UTAGAFEwBhRRMAYgUTAGPFEgBkBRMAZUUTAGYFEwBnxRIAZAkwAGYJLwBoBRMAaUUTAGoFEwBrxRIAbAUTAG1FEwBuBRMAb8USAGhJLgBqSS0AbEkuAG4JLwBwBRMAcUUTAHIFEwBzxRIAdAUTAHVFEwB2BRMAd8USAHARMAB0CTAAdgkvAHgFEwB5RRMAegUTAHvFEgB8BRMAfUUTAH4FEwB/xRIAeEkuAHpJLQB8SS4AfgkvAIAJEwCABTAAgcUvAIKFLwCDRS8AhIUvAIVFLwCGBS8Ah8UuAIgFLwCJxS4AioUuAItFLgCMBS4AjcUtAI6FLQCPRS0AlAkTAJYJEgCQBS0AkUUtAJIFLQCTxSwAlAUtAJVFLQCWBS0Al8UsAJhJEQCaSRAAnEkRAJ4JEgCYBS0AmUUtAJoFLQCbxSwAnAUtAJ1FLQCeBS0An8UsAKAREwCkCRMApgkSAKAFLQChRS0AogUtAKPFLACkBS0ApUUtAKYFLQCnxSwAqEkRAKpJEACsSREArgkSAKgFLQCpRS0AqgUtAKvFLACsBS0ArUUtAK4FLQCvxSwAsBETALAFLQCxRS0AsoUtALPFLQC0BS4AtUUuALaFLgC3xS4AuAUPALlFDwC6hQ8Au8UPALwFEAC9RRAAvoUQAL/FEADABREAwUURAMKFEQDDxREAxAUSAMVFEgDGhRIAx8USAMgFEwDJRRMAygUTAMvFEgDMBRMAzUUTAM4FEwDPxRIA0AUTANHFEgDShRIA00USANQFEgDVRRMA1gUTANfFEgDQSS4A0AkwANAJMgDYBRMA2cUSANqFEgDbRRIA3AUSAN1FEgDehRIA38USANgJMgDcSTEA4AUTAOHFEgDihRIA40USAOQFEgDlRRMA5gUTAOfFEgDgSS4A4AkwAOAJMgDoBRMA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', 'base64');

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function getBumblebeeNote(index, target) {
  if (index < 0 || index >= NOTE_COUNT || !target) throw new RangeError('index and target are required');
  const packed = SCORE_BYTES.readUInt32LE(index << 2);
  target.tick = packed & 1_023;
  target.ticks = packed >> 10 & 15;
  target.midi = packed >> 14 & 127;
  target.staff = packed >> 21 & 1;
  return target;
}

function applyRoomAndMaster(left, right, delayLeft, delayRight, proceduralRoom) {
  let leftPosition = 0;
  let rightPosition = 0;
  if (proceduralRoom) {
    for (let index = 0; index < left.length; index += 1) {
      const dryLeft = left[index];
      const dryRight = right[index];
      const lateLeft = delayLeft[leftPosition];
      const lateRight = delayRight[rightPosition];
      delayLeft[leftPosition] = 0.86 * dryLeft + 0.10 * dryRight + 0.70 * lateLeft;
      delayRight[rightPosition] = 0.86 * dryRight + 0.10 * dryLeft + 0.69 * lateRight;
      leftPosition += 1;
      rightPosition += 1;
      if (leftPosition === delayLeft.length) leftPosition = 0;
      if (rightPosition === delayRight.length) rightPosition = 0;
      left[index] = dryLeft + 0.13 * lateLeft + 0.045 * lateRight;
      right[index] = dryRight + 0.13 * lateRight + 0.045 * lateLeft;
    }
  }
  let leftMean = 0;
  let rightMean = 0;
  for (let index = 0; index < left.length; index += 1) { leftMean += left[index]; rightMean += right[index]; }
  leftMean /= left.length;
  rightMean /= right.length;
  const fadeSamples = Math.round(0.65 * SAMPLE_RATE);
  let peak = 0;
  for (let index = 0; index < left.length; index += 1) {
    const fade = index < left.length - fadeSamples ? 1 : Math.sin(Math.PI * 0.5 * (left.length - 1 - index) / (fadeSamples - 1)) ** 2;
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

export function renderBumblebeeTrack({ onProgress, proceduralRoom = true } = {}) {
  const durationSeconds = LEAD_IN_SECONDS + SCORE_TICKS * SECONDS_PER_TICK + ROOM_TAIL_SECONDS;
  const frameCount = Math.round(durationSeconds * SAMPLE_RATE);
  const maxNoteSeconds = 8 * SECONDS_PER_TICK + 0.36;
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);
  const noteBuffer = new Float32Array(Math.round(maxNoteSeconds * SAMPLE_RATE));
  const delayLeft = proceduralRoom ? new Float32Array(2_401) : null;
  const delayRight = proceduralRoom ? new Float32Array(2_719) : null;
  let dynamicIndex = 0;
  for (let eventIndex = 0; eventIndex < NOTE_COUNT; eventIndex += 1) {
    const packed = SCORE_BYTES.readUInt32LE(eventIndex << 2);
    const tick = packed & 1_023;
    const ticks = packed >> 10 & 15;
    const midi = packed >> 14 & 127;
    const staff = packed >> 21 & 1;
    while (dynamicIndex + 1 < DYNAMIC_TICKS.length && tick >= DYNAMIC_TICKS[dynamicIndex + 1]) dynamicIndex += 1;
    const velocity = clamp(DYNAMIC_LEVELS[dynamicIndex] + (tick & 7 ? 0 : 0.045) + (staff ? -0.025 : 0.015) + 0.012 * Math.sin(tick * 0.071), 0.34, 0.86);
    const noteSeconds = ticks * SECONDS_PER_TICK * (staff ? 0.82 : 0.72) + (staff ? 0.34 : 0.22);
    const renderedSamples = Math.round(noteSeconds * SAMPLE_RATE);
    synthesizeGrandPianoInto(noteBuffer, midiToFrequency(midi), velocity, noteSeconds);
    const start = Math.round((LEAD_IN_SECONDS + tick * SECONDS_PER_TICK) * SAMPLE_RATE);
    const keyboardPan = clamp((midi - 60) / 34, -1, 1) * 0.38;
    const panAngle = (keyboardPan + 1) * Math.PI / 4;
    const eventGain = staff ? 0.25 : 0.225;
    const leftGain = Math.cos(panAngle) * eventGain;
    const rightGain = Math.sin(panAngle) * eventGain;
    const available = Math.min(renderedSamples, frameCount - start);
    for (let sample = 0; sample < available; sample += 1) {
      left[start + sample] += noteBuffer[sample] * leftGain;
      right[start + sample] += noteBuffer[sample] * rightGain;
    }
    if (onProgress && ((eventIndex + 1 & 63) === 0 || eventIndex + 1 === NOTE_COUNT)) onProgress(eventIndex + 1, NOTE_COUNT);
  }
  const masteringGain = applyRoomAndMaster(left, right, delayLeft, delayRight, proceduralRoom);
  return { left, right, masteringGain, noteCount: NOTE_COUNT, measureCount: MEASURE_COUNT, durationSeconds, sampleRate: SAMPLE_RATE, tempoBpm: TEMPO_BPM };
}
