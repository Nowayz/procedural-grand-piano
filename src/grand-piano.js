/**
 * Sample-free procedural grand-piano synthesizer.
 *
 * The module is dependency-free ESM and runs unchanged in modern browsers and
 * Node. It never reads files or accesses a network. Each call returns a new,
 * deterministic mono Float32Array of normalized PCM samples.
 */

export const SAMPLE_RATE = 44_100;
export const MIN_NOTE_HZ = 27.5; // A0
export const MAX_NOTE_HZ = 4_186.009_044_809_578; // C8
export const MAX_DURATION_SECONDS = 30;

const TWO_PI = Math.PI * 2;
const NYQUIST_MARGIN_HZ = SAMPLE_RATE * 0.475;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function lerp(a, b, amount) {
  return a + (b - a) * amount;
}

function smoothstep(value) {
  return value * value * (3 - 2 * value);
}

function transition(value) {
  return smoothstep(clamp(value, 0, 1));
}

function bell(value, center, width, power = 2) {
  return Math.exp(-(((value - center) / width) ** power));
}

function decay(sample, seconds) {
  return Math.exp(-sample / (seconds * SAMPLE_RATE));
}

function requireFiniteNumber(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

// Seeded noise keeps each note repeatable and duration-independent.
function makeNoise(seed) {
  let state = seed >>> 0 || 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

function seedFromArguments(frequency, velocity) {
  const data = new DataView(new ArrayBuffer(12));
  data.setFloat64(0, frequency, true);
  data.setFloat32(8, velocity, true);

  let hash = 0x811c9dc5;
  for (let index = 0; index < data.byteLength; index += 1) {
    hash ^= data.getUint8(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const STIFFNESS_CURVE = [
  [21, 2.9e-4], [24, 2.3e-4], [27, 2.45e-4], [30, 8.3e-5],
  [33, 8.2e-5], [36, 1.34e-4], [39, 2.5e-4], [42, 1.6e-4],
  [45, 1.4e-4], [48, 1.05e-4], [51, 1.25e-4], [54, 1.82e-4],
  [57, 2.12e-4], [60, 2.95e-4], [63, 3.5e-4], [66, 5.35e-4],
  [69, 6.2e-4], [72, 8.3e-4], [75, 1.04e-3], [78, 1.1e-3],
  [81, 1.73e-3], [84, 2.18e-3], [87, 3.04e-3], [93, 5.4e-3],
  [108, 9e-3],
];

const RADIATION_CURVE_DB = [
  [21, -0.24], [24, 0.69], [27, 0.25], [30, -3.5], [33, -2.2],
  [36, -3.33], [39, 0.43], [42, 0.71], [45, -0.9], [48, -1.98],
  [51, -1.27], [54, -3.88], [57, -5.42], [60, -2.09], [63, -6.99],
  [66, -3.79], [69, -3.22], [72, -1.59], [75, 1.2], [78, 3.24],
  [81, 0.1], [84, 2.35], [87, 6.72], [90, 3.84], [93, 7.01],
  [96, 4.63], [99, 2.42], [102, 6.17], [105, 2.38], [108, 4.39],
];

const BRIDGE_CURVE_DB = [
  [27.5, -2], [55, -4], [70, 0], [100, 1], [200, 0], [250, -1.5],
  [500, -1.5], [800, -2.5], [1_200, -1.5], [1_800, -1.5],
  [2_400, 1], [3_200, 3], [4_500, 3], [6_000, 1.5],
  [8_000, 2], [16_000, 0],
];

const MODAL_RADIATION_DB = [
  [-2, 4.1, -0.6, -3.9, -2.9, -1.4, 1.2, -7.3, -2.8, -1.2, -3.7, -7, -4.1, -4.6, -5.6, -8],
  [2.3, -2.7, -5.2, -4.2, -3.1, -1.8, 6.3, 6.2, 1.4, -0.7, -1.6, -0.6, 0.6, -0.3, 1, 0],
  [0, -10.5, 7, 2.5, -4.4, -3.6, -4.9, -3.6, -3.1, -2.8, -1.7, -1.7, 0, 0, 0, 0],
];

// 1,845 packed scalar dB coefficients; these are model parameters, never audio.
const CALIBRATION_BYTES = Uint8Array.from(atob(
  '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',
), (character) => character.charCodeAt(0));
const MODAL_COLOR_BYTES = CALIBRATION_BYTES.subarray(0, 540);
const IMPACT_COLOR_BYTES = CALIBRATION_BYTES.subarray(540, 720);
const MOBILITY_COLOR_BYTES = CALIBRATION_BYTES.subarray(720, 1_350);
const RADIATION_BYTES = CALIBRATION_BYTES.subarray(1_350, 1_485);
const BRIDGE_LOSS_BYTES = CALIBRATION_BYTES.subarray(1_485, 1_665);
const BOARD_LOSS_BYTES = CALIBRATION_BYTES.subarray(1_665);
const MOBILITY_BAND_EDGES = [40, 63, 100, 160, 250, 400, 630, 1_000, 1_600, 2_500, 4_000, 6_300, 10_000, 16_000];

// Packed surfaces use quarter-dB loss/radiation or half-dB color steps.
// flags: 1 = logarithmic x, 2 = smoothstep, 4 = logarithmic y.
function interpolateCurve(value, anchors, flags = 0) {
  for (let index = 1; index < anchors.length; index += 1) {
    const [upperX, upperY] = anchors[index];
    const [lowerX, lowerY] = anchors[index - 1];
    if (value <= upperX) {
      let position = clamp(
        flags & 1
          ? Math.log(value / lowerX) / Math.log(upperX / lowerX)
          : (value - lowerX) / (upperX - lowerX),
        0,
        1,
      );
      if (flags & 2) position = smoothstep(position);
      return flags & 4
        ? Math.exp(lerp(Math.log(lowerY), Math.log(upperY), position))
        : lerp(lowerY, upperY, position);
    }
  }
  return anchors.at(-1)[1];
}

function radiationEqDb(midi, velocity, band) {
  return calibrationValue(RADIATION_BYTES, 3, midi, velocity, band, 0.25);
}

function bridgeLossDbPerSecond(midi, velocity, frequency) {
  const frequencyAnchors = [200, 800, 2_500, 6_500];
  let frequencyIndex = 0;
  while (
    frequencyIndex < frequencyAnchors.length - 2 &&
    frequency > frequencyAnchors[frequencyIndex + 1]
  ) frequencyIndex += 1;
  const frequencyBlend = clamp(
    Math.log(frequency / frequencyAnchors[frequencyIndex]) /
      Math.log(frequencyAnchors[frequencyIndex + 1] / frequencyAnchors[frequencyIndex]),
    0,
    1,
  );
  const atBand = (band) => calibrationValue(
    BRIDGE_LOSS_BYTES, 4, midi, velocity, band, 0.25, 0.541,
  );
  return lerp(atBand(frequencyIndex), atBand(frequencyIndex + 1), frequencyBlend);
}

function boardLossDbPerSecond(midi, velocity, band) {
  return calibrationValue(
    BOARD_LOSS_BYTES, 4, midi, velocity, band, 0.25, 0.541,
  );
}

function radiationNormalization(
  frequency,
  lowStep,
  centerStep,
  highStep,
  lowGain,
  centerGain,
  highGain,
) {
  const omega = TWO_PI * frequency / SAMPLE_RATE;
  const response = (step) => {
    const pole = 1 - step;
    const real = 1 - pole * Math.cos(omega);
    const imaginary = pole * Math.sin(omega);
    const scale = step / (real * real + imaginary * imaginary);
    return [scale * real, -scale * imaginary];
  };
  const low = response(lowStep);
  const center = response(centerStep);
  const high = response(highStep);
  const real =
    highGain +
    (lowGain - centerGain) * low[0] +
    (centerGain - 1) * center[0] +
    (1 - highGain) * high[0];
  const imaginary =
    (lowGain - centerGain) * low[1] +
    (centerGain - 1) * center[1] +
    (1 - highGain) * high[1];
  return Math.hypot(real, imaginary);
}

function stringDetunes(midi) {
  if (midi < 31) return [0];

  const register = clamp((midi - 31) / 77, 0, 1);
  const widthCents = lerp(0.32, 4.1, register ** 1.5);
  if (midi < 49) return [-0.47 * widthCents, 0.53 * widthCents];
  const upperDetune = lerp(0.95, 0.7, transition((midi - 96) / 12));
  return [-0.83 * widthCents, -0.34 * widthCents, upperDetune * widthCents];
}

function modalRadiationGain(partial, bassToMiddle, middleToTreble, velocity) {
  if (partial > MODAL_RADIATION_DB[0].length) return 1;
  const index = partial - 1;
  const lowerRegisterDb = lerp(
    MODAL_RADIATION_DB[0][index],
    MODAL_RADIATION_DB[1][index],
    bassToMiddle,
  );
  const trebleDb = MODAL_RADIATION_DB[2][index] + (index === 1 ? 6 * velocity : 0);
  const calibrationDb = lerp(lowerRegisterDb, trebleDb, middleToTreble);
  return 10 ** (calibrationDb / 20);
}

function calibrationValue(
  bytes,
  columns,
  midi,
  velocity,
  column,
  scale = 0.5,
  middleVelocity = 0.476,
) {
  const pitchPosition = clamp((midi - 23) / 6, 0, 14);
  const pitchIndex = Math.min(13, Math.floor(pitchPosition));
  const pitchBlend = transition(pitchPosition - pitchIndex);
  const velocityIndex = velocity < middleVelocity ? 0 : 1;
  const velocityBlend = clamp(
    velocityIndex === 0
      ? (velocity - 0.106) / (middleVelocity - 0.106)
      : (velocity - middleVelocity) / (0.976 - middleVelocity),
    0,
    1,
  );
  const value = (pitch, layer) => {
    const byte = bytes[(pitch * 3 + layer) * columns + column];
    return (byte > 127 ? byte - 256 : byte) * scale;
  };
  const atPitch = (pitch) => lerp(
    value(pitch, velocityIndex),
    value(pitch, velocityIndex + 1),
    velocityBlend,
  );
  return lerp(atPitch(pitchIndex), atPitch(pitchIndex + 1), pitchBlend);
}

function createHammerForce(velocity, register, frequency) {
  const softContactSeconds = lerp(0.0034, 0.00085, register);
  const hardContactSeconds = lerp(0.00155, 0.00023, register);
  const unconstrainedContact = lerp(
    softContactSeconds,
    hardContactSeconds,
    velocity ** 0.62,
  );
  const trebleBlend = transition((register - 0.5) / 0.34);
  const hardContactBlend = transition((velocity - 0.08) / 0.52);
  const tenorCycleLimit = lerp(0.24, 0.055, hardContactBlend);
  const cycleLimit = lerp(tenorCycleLimit, 0.68, trebleBlend);
  const contactSeconds = Math.min(unconstrainedContact, cycleLimit / frequency);
  const sampleCount = Math.max(8, Math.round(contactSeconds * SAMPLE_RATE));
  const force = new Float64Array(sampleCount);
  const feltExponent = lerp(1.35, 2.8, velocity ** 0.7);
  const reboundSkew = lerp(0.18, -0.08, velocity);
  let integral = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const position = index / (sampleCount - 1);
    const compression = Math.sin(Math.PI * position) ** feltExponent;
    const asymmetricRelease = Math.max(0, 1 + reboundSkew * (2 * position - 1));
    force[index] = compression * asymmetricRelease;
    integral += force[index];
  }
  for (let index = 0; index < sampleCount; index += 1) force[index] /= integral;
  return force;
}

// Five-number resonator layout: [y1, y2, a1, a2, drive].
function resonate(state, offset, force) {
  const output =
    state[offset + 2] * state[offset] +
    state[offset + 3] * state[offset + 1] +
    state[offset + 4] * force;
  state[offset + 1] = state[offset];
  state[offset] = output;
  return output;
}

function createStringModes(frequency, velocity, midi, register) {
  const stiffness = interpolateCurve(midi, STIFFNESS_CURVE, 4);
  const detunes = stringDetunes(midi);
  const extremeTreble = clamp((register - 0.88) / 0.12, 0, 1);
  const bassBroadening = transition((register - 0.12) / 0.32);
  const trebleVoicing = transition((register - 0.5) / 0.34);
  const upperTrebleCoupling = transition((midi - 84) / 24);
  const middleBroadening = bassBroadening * (1 - trebleVoicing);
  const bassVoicing = transition((48 - midi) / 27);
  const middlePresence = bell(midi, 60, 10);
  const strikePosition = lerp(0.127, 0.112, register);
  const broadHammerCutoff =
    2_500 + 13_000 * velocity ** 1.2 + 3_000 * register ** 2;
  const trebleHammerCutoff =
    1_050 + 8_900 * velocity ** 1.72 + 2_000 * register ** 2;
  const brightnessCutoff = lerp(
    trebleHammerCutoff,
    broadHammerCutoff,
    middleBroadening,
  );
  const spectralLimit = Math.min(NYQUIST_MARGIN_HZ, 5_500 + 15_000 * velocity ** 0.62);
  const baseT60 = clamp(11 * (261.625565 / frequency) ** 0.45, 2.35, 31);
  const stiffnessNormalization = Math.sqrt(1 + stiffness);
  const unisonWeights = detunes.length === 3
    ? [0.09, 0.46, 0.45]
    : detunes.length === 2
      ? [0.47, 0.53]
      : [1];
  const forceDelays = detunes.length === 3 ? [0, 2, 1] : [0, 0];
  const equalWeight = 1 / detunes.length;
  const unisonInequality = register ** 1.5;
  const modes = [];

  for (let partial = 1; partial <= 192; partial += 1) {
    const dispersedFrequency =
      (partial * frequency * Math.sqrt(1 + stiffness * partial * partial)) /
      stiffnessNormalization;
    if (dispersedFrequency > spectralLimit) break;
    let mobilityBand = 0;
    while (
      mobilityBand < MOBILITY_BAND_EDGES.length - 1 &&
      dispersedFrequency >= MOBILITY_BAND_EDGES[mobilityBand]
    ) mobilityBand += 1;

    const strikeCoupling = 0.2 + 0.8 * Math.abs(Math.sin(Math.PI * partial * strikePosition));
    const feltFilter = bell(dispersedFrequency, 0, brightnessCutoff, 1.3);
    const hammerVelocityBase = lerp(
      0.78 + 0.12 * velocity,
      0.9 + 0.04 * velocity,
      middleBroadening,
    );
    const velocityBrightening = hammerVelocityBase ** Math.log2(partial);
    const radiation = 0.08 + 0.92 * dispersedFrequency / (dispersedFrequency + 150);
    const midBridgeCoupling =
      1 +
      2.1 *
        bell(midi, 65, 10) *
        bell(partial, 2, 0.75);
    const trebleModeDamping = Math.exp(
      -4.4 *
        register ** 4.2 *
        (partial - 1) *
        (0.72 -
          0.32 * velocity -
          0.22 * extremeTreble * velocity -
          1.2 * upperTrebleCoupling * (1 - velocity)) *
        lerp(1, 0.45, middleBroadening),
    );
    const registerRadiationGain = 1 + 2.8 * register ** 2.2;
    const bridgePresenceShape = bell(Math.log(dispersedFrequency / 1_800), 0, 0.29);
    const bridgePresenceGain = 1 + 0.7 * middlePresence * bridgePresenceShape;
    const bridgeAntiresonanceShape = bell(Math.log(dispersedFrequency / 790), 0, 0.08);
    const bridgeAntiresonance =
      1 - 0.85 * middlePresence * bridgeAntiresonanceShape;
    const middleBodyShape = bell(partial, 4.5, 1, 4);
    const middleBodyLevel = 1 - 0.5 * middlePresence * middleBodyShape;
    const bassOvertoneRadiation =
      1 + 4 * bassVoicing * (1 - Math.exp(-(partial - 1) / 1.6));
    const weakBassFundamental =
      1 -
      (0.91 - 0.4 * bassVoicing) *
        bassVoicing *
        bell(partial, 1, 0.55, 4);
    const weakBassSecond =
      1 -
      (0.93 - 0.4 * bassVoicing) *
        bassVoicing *
        bell(partial, 2, 0.55, 4);
    const bassHighPartialTransition = transition((partial - 10) / 7);
    const bassHighPartialRadiation =
      1 + 4.5 * bassVoicing * bassHighPartialTransition;
    const bassPresenceShape = bell(
      Math.log(dispersedFrequency / 1_800), 0, 1.05, 4,
    );
    const bassPresenceRadiation =
      1 + 4 * (1 - bassBroadening) * bassPresenceShape;
    const partialRolloff = Math.max(
      0.7,
      lerp(1.12, 0.58, middleBroadening) - 0.18 * bassVoicing,
    );
    const amplitude =
      (strikeCoupling *
        feltFilter *
        velocityBrightening *
        radiation *
        midBridgeCoupling *
        trebleModeDamping *
        registerRadiationGain *
        bridgePresenceGain *
        bridgeAntiresonance *
        middleBodyLevel *
        bassOvertoneRadiation *
        weakBassFundamental *
        weakBassSecond *
        bassHighPartialRadiation *
        bassPresenceRadiation *
        modalRadiationGain(partial, bassBroadening, trebleVoicing, velocity) *
        10 ** (-0.94 *
          (partial <= 12
            ? calibrationValue(
                MODAL_COLOR_BYTES,
                12,
                midi,
                velocity,
                partial - 1,
              )
            : 0) / 20) *
        10 ** (-0.18 *
          calibrationValue(
            MOBILITY_COLOR_BYTES,
            14,
            midi,
            velocity,
            mobilityBand,
          ) / 20) *
        10 ** (interpolateCurve(dispersedFrequency, BRIDGE_CURVE_DB, 3) / 20)) /
      partial ** partialRolloff;

    const bassPresenceDecay = transition(Math.log2(dispersedFrequency / 500) / 2);
    const undampedPartialT60 =
      baseT60 *
      (0.3 + 0.7 / partial ** 0.7) *
      1 /
      (1 +
        (dispersedFrequency / 9_500) ** 2) *
      (1 + 0.7 * (1 - bassBroadening) * bassPresenceDecay);
    const lowOrderTrebleTail = bell(partial, 1.5, 1, 4);
    const trebleHighPartialTail = 1 - Math.exp(-(partial - 1) / 2.5);
    const middleUpperModeTail = bell(partial, 4.5, 0.9, 4);
    const lateTrebleTail = transition((midi - 94) / 14);
    const uncorrectedSlowTailT60 =
      undampedPartialT60 *
      (1 + 0.15 * bassVoicing) *
      (1 + 1.5 * middlePresence * middleUpperModeTail) *
      Math.exp(
        0.5 *
          (0.75 - velocity) *
          trebleHighPartialTail,
      ) *
      (1 -
        0.8 *
          lateTrebleTail *
          trebleHighPartialTail) *
      (1 -
        lowOrderTrebleTail *
          (0.25 * trebleVoicing + 0.2 * extremeTreble));
    const slowTailT60 = 60 / Math.max(
      1,
      60 / uncorrectedSlowTailT60 +
        0.45 * bridgeLossDbPerSecond(midi, velocity, dispersedFrequency),
    );
    const baseFastFraction = 0.14 + 0.43 * (partial / (partial + 5));
    const middleLowModeLoss =
      (0.3 * middlePresence +
        0.4 * bell(midi, 60, 1.5) * transition((velocity - 0.8) / 0.17)) *
      bell(partial, 1.5, 0.8, 4);
    const middleBodySustain =
      0.38 *
      middlePresence *
      middleBodyShape;
    const maximumFastFraction = Math.min(
      0.99,
      (partial === 1
        ? lerp(0.965, 0.82, register ** 1.5)
        : lerp(0.94, 0.68, register ** 1.4)) +
        0.16 * register * (velocity - 0.5) +
        0.6 * lateTrebleTail * trebleHighPartialTail,
    );
    const fastFraction = clamp(
      baseFastFraction +
        1.03 * register ** 2 +
        middleLowModeLoss -
        middleBodySustain,
      0,
      maximumFastFraction,
    );
    let fastRatio =
      lerp(
        0.21,
        0.045,
        register ** 1.35,
      ) *
      lerp(1, 0.72, partial / (partial + 8));
    if (partial === 2) fastRatio *= lerp(1, 0.15, register ** 2);
    const fastT60 = undampedPartialT60 * fastRatio;
    const bridgeRiseSeconds =
      (0.00125 + 0.005 / (1 + partial * 0.42)) *
      lerp(1.35, 0.78, register) *
      (1 + 0.9 * register ** 2 + 3.5 * register ** 6) *
      (1 +
        0.27 * bell(midi, 93, 10) +
        0.24 * extremeTreble);
    const verticalSecondPartialBoost = partial === 2
      ? 1 + 4.5 * register ** 3 * velocity
      : 1;
    const damperT60 =
      midi >= 96
        ? 0.34 * (0.75 + 0.25 / Math.sqrt(partial))
        : lerp(0.16, 0.075, register) / (1 + 0.055 * (partial - 1));
    const fastPole = decay(6.907755, fastT60);
    const slowPole = decay(6.907755, slowTailT60);
    const polarizationT60 = slowTailT60 * lerp(0.68, 0.34, register);
    const polarizationPole = decay(6.907755, polarizationT60);
    const polarizationStrength =
      (0.035 + 0.11 * register) *
      (0.55 + 0.45 * velocity) /
      partial ** 0.2;

    for (let stringIndex = 0; stringIndex < detunes.length; stringIndex += 1) {
      const cents = detunes[stringIndex];
      const stringFrequency = dispersedFrequency * 2 ** (cents / 1_200);
      const angularStep = TWO_PI * stringFrequency / SAMPLE_RATE;
      const stringWeight = lerp(
        equalWeight,
        unisonWeights[stringIndex],
        unisonInequality,
      );
      const polarizationCents =
        (0.35 + 1.1 * register) *
        Math.sin(2.17 * partial + 1.31 * stringIndex + 0.4);
      const polarizationFrequency = stringFrequency * 2 ** (polarizationCents / 1_200);
      const polarizationStep = TWO_PI * polarizationFrequency / SAMPLE_RATE;

      modes.push([
        0,
        0,
        2 * fastPole * Math.cos(angularStep),
        -(fastPole * fastPole),
        amplitude *
          stringWeight *
          fastFraction *
          verticalSecondPartialBoost *
          Math.sin(angularStep),
        0,
        0,
        2 * slowPole * Math.cos(angularStep),
        -(slowPole * slowPole),
        amplitude *
          stringWeight *
          (1 - fastFraction) *
          Math.sin(angularStep),
        0,
        0,
        2 * polarizationPole * Math.cos(polarizationStep),
        -(polarizationPole * polarizationPole),
        amplitude *
          stringWeight *
          polarizationStrength *
          Math.sin(polarizationStep),
        forceDelays[stringIndex],
        stringIndex + 1,
        0,
        1 - decay(1, bridgeRiseSeconds),
        1,
        decay(6.907755, damperT60),
      ]);
    }
  }
  return modes;
}

/** Immutable coefficient templates; each note clones its filter state. */
const SOUNDBOARD_FILTERS = [
  [72, 1.25, 0.16], [116, 1.6, 0.2], [185, 1.8, 0.19],
  [285, 2.1, 0.16], [435, 2.4, 0.13], [690, 2.7, 0.1],
  [1_080, 3.1, 0.075], [1_720, 3.5, 0.052],
  [2_750, 4, 0.034], [4_300, 4.4, 0.018],
].map(([frequency, q, gain]) => {
  const omega = TWO_PI * frequency / SAMPLE_RATE;
  const alpha = Math.sin(omega) / (2 * q);
  const inverseA0 = 1 / (1 + alpha);
  return [
    alpha * inverseA0, 0, -alpha * inverseA0,
    -2 * Math.cos(omega) * inverseA0, (1 - alpha) * inverseA0,
    0, 0, 0, 0, gain,
  ];
});

const NOISE_FILTERS = [
  6_500, 6_500, 6_500, -1_800, -7_500, 15_500,
  1_100, 1_100, -180, 630, 630, -55, -1_600, 8_000,
].map((cutoff) => {
  const omega = TWO_PI * Math.abs(cutoff) / SAMPLE_RATE;
  const cosine = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * Math.SQRT1_2);
  const inverseA0 = 1 / (1 + alpha);
  const sign = cutoff < 0 ? 1 : -1;
  const b0 = (1 + sign * cosine) * 0.5 * inverseA0;
  return [
    b0, -(sign + cosine) * inverseA0, b0,
    -2 * cosine * inverseA0, (1 - alpha) * inverseA0,
    0, 0, 0, 0,
  ];
});

function filterBiquad(input, filter) {
  const output =
    filter[0] * input +
    filter[1] * filter[5] +
    filter[2] * filter[6] -
    filter[3] * filter[7] -
    filter[4] * filter[8];
  filter[6] = filter[5];
  filter[5] = input;
  filter[8] = filter[7];
  filter[7] = output;
  return output;
}

function filterChain(input, filters, start, end) {
  while (start < end) input = filterBiquad(input, filters[start++]);
  return input;
}

function filterSoundboard(input, filters) {
  let result = 0;
  for (let index = 0; index < filters.length; index += 1) {
    result += filters[index][9] * filterBiquad(input, filters[index]);
  }
  return result;
}

const IMPACT_MODES = [
  [58, 0.035, 0.065], [87, 0.031, -0.058], [126, 0.028, 0.052],
  [181, 0.025, -0.046], [255, 0.023, 0.041], [354, 0.021, -0.036],
  [486, 0.019, 0.032], [661, 0.018, -0.028], [891, 0.017, 0.025],
  [1_188, 0.016, -0.022], [1_565, 0.015, 0.019],
  [2_036, 0.0085, -0.25], [2_617, 0.008, 0.35],
  [3_323, 0.012, -0.07], [4_168, 0.011, 0.0115],
  [5_164, 0.01, -0.01], [6_321, 0.0092, 0.0087],
  [7_648, 0.0085, -0.0075], [9_151, 0.0081, 0.0096],
  [10_834, 0.0075, -0.0081], [12_696, 0.0069, 0.00675],
  [14_735, 0.00625, -0.00555],
];

function createImpactSoundboard(velocity, register, midi) {
  const impactStrength = velocity ** 1.15 * (0.82 + 0.18 * register);
  const middleBody = bell(midi, 60, 10);
  const trebleBody = transition((midi - 72) / 36);
  const extremeTrebleBody = transition((midi - 99) / 9);
  const trebleVelocityVoicing = transition((midi - 84) / 18);
  const bassPlateTransition = transition((midi - 30) / 30);
  const extremeTreble = clamp((register - 0.88) / 0.12, 0, 1);
  const bodyVelocity = Math.max(velocity, 0.04);
  const lowBodyVelocityScale = lerp(
    bodyVelocity ** -0.45,
    0.1 * bodyVelocity ** -2.5,
    trebleVelocityVoicing,
  );
  const coupledBodyDrive =
    0.75 * (1 + 2 * middleBody + 6 * extremeTrebleBody) * lowBodyVelocityScale;

  return IMPACT_MODES.map(([frequency, decaySeconds, gain], index) => {
    const angularStep = TWO_PI * frequency / SAMPLE_RATE;
    const bodyModeWeight = frequency < 1_000
      ? 1
      : frequency < 1_700
        ? trebleBody
        : 0;
    const lowBodyMode = bodyModeWeight > 0;
    const fastDecaySeconds = decaySeconds *
      (lowBodyMode
        ? 1 +
          bodyModeWeight *
            (1.75 * register ** 2 + 13 * middleBody + 10 * trebleBody)
        : 1);
    const lowPlateWeight = transition((400 - frequency) / 350);
    const slowBodyFraction = lowBodyMode
      ? bodyModeWeight *
        (0.2 * middleBody + 0.1 * trebleBody * (1 + 2 * lowPlateWeight))
      : 0;
    const slowDecaySeconds = decaySeconds *
      (1 + bodyModeWeight * (90 * middleBody + 100 * trebleBody));
    const fastPole = decay(1, fastDecaySeconds);
    const slowPole = decay(1, slowDecaySeconds);
    const attackDecayMultiplier = frequency >= 250 ? 2.8 : 2.2;
    const attackPole = decay(1, attackDecayMultiplier * decaySeconds);
    const highFrequency = Math.max(1, frequency / 500);
    const feltBrightness = (0.58 + 0.42 * velocity) ** Math.log2(highFrequency);
    const modeShape = 0.72 + 0.28 * Math.sin(0.73 * index + 3.1 * register);
    let impactRadiation = lerp(
      1,
      clamp(Math.sqrt(frequency / 2_000), 0.2, 1),
      register ** 2,
    );
    if (lowBodyMode) impactRadiation = lerp(impactRadiation, 1, extremeTreble);
    const midPlateScale = frequency >= 1_800 && frequency < 3_800
      ? lerp(1, 0.18, extremeTreble)
      : 1;
    const lowBodyDrive = lerp(1, coupledBodyDrive, bodyModeWeight);
    const bassHighPlateScale = frequency >= 1_800
      ? lerp(0.1, 1, bassPlateTransition)
      : 1;
    const colorBand = frequency < 250 ? 0 : frequency < 1_000 ? 1 : frequency < 2_500 ? 2 : 3;
    const drive = gain * lowBodyDrive * bassHighPlateScale * midPlateScale *
      impactStrength * feltBrightness * modeShape * impactRadiation *
      10 ** (-1.08 *
        calibrationValue(IMPACT_COLOR_BYTES, 4, midi, velocity, colorBand) / 20);
    return [
      0,
      0,
      2 * fastPole * Math.cos(angularStep),
      -(fastPole * fastPole),
      drive * (1 - slowBodyFraction) * Math.sin(angularStep),
      0,
      0,
      2 * slowPole * Math.cos(angularStep),
      -(slowPole * slowPole),
      drive * slowBodyFraction * Math.sin(angularStep),
      0,
      0,
      2 * attackPole * Math.cos(angularStep),
      -(attackPole * attackPole),
      drive * (2.5 * bodyModeWeight * trebleBody) *
        Math.sin(angularStep),
      0,
      1 - decay(1, 0.005),
    ];
  });
}

function filterImpactSoundboard(force, modes) {
  let result = 0;
  for (let index = 0; index < modes.length; index += 1) {
    const mode = modes[index];
    const output = resonate(mode, 0, force);
    const slowOutput = resonate(mode, 5, force);
    const attackOutput = resonate(mode, 10, force);
    mode[15] += (1 - mode[15]) * mode[16];
    result +=
      output +
      slowOutput +
      attackOutput * mode[15];
  }
  return result;
}

/**
 * Render deterministic mono piano PCM. Finite numbers are required; frequency,
 * velocity, and duration clamp to A0..C8, 0..1, and 0..30 seconds. Duration
 * includes the release tail; output is click-faded and bounded to ±0.94.
 *
 * @param {number} note_hz fundamental frequency in hertz
 * @param {number} velocity hammer velocity, normally 0..1
 * @param {number} duration_seconds total rendered duration in seconds
 * @returns {Float32Array} round(duration * 44100) samples at {@link SAMPLE_RATE}
 */
export function synthesizeGrandPiano(note_hz, velocity, duration_seconds) {
  requireFiniteNumber('note_hz', note_hz);
  requireFiniteNumber('velocity', velocity);
  requireFiniteNumber('duration_seconds', duration_seconds);

  const frequency = clamp(note_hz, MIN_NOTE_HZ, MAX_NOTE_HZ);
  const strikeVelocity = clamp(velocity, 0, 1);
  const duration = clamp(duration_seconds, 0, MAX_DURATION_SECONDS);
  const sampleCount = Math.round(duration * SAMPLE_RATE);
  const output = new Float32Array(sampleCount);
  if (sampleCount === 0 || strikeVelocity === 0) return output;

  const midi = 69 + 12 * Math.log2(frequency / 440);
  const register = clamp((midi - 21) / 87, 0, 1);
  const hammerForce = createHammerForce(strikeVelocity, register, frequency);
  const modes = createStringModes(frequency, strikeVelocity, midi, register);
  const soundboard = SOUNDBOARD_FILTERS.map((filter) => filter.slice());
  const impactSoundboard = createImpactSoundboard(strikeVelocity, register, midi);
  const noiseSeed = seedFromArguments(frequency, strikeVelocity);
  const noise = makeNoise(noiseSeed);
  const bodyNoise = makeNoise(noiseSeed ^ 0x9e3779b9);

  const releaseSeconds = clamp(
    0.145 * (110 / frequency) ** 0.14,
    0.052,
    0.185,
  );
  const releaseSamples = Math.min(
    sampleCount,
    Math.max(1, Math.round(releaseSeconds * SAMPLE_RATE)),
  );
  const releaseStart = sampleCount - releaseSamples;
  const startFadeSamples = Math.round(
    lerp(160, 32, transition((midi - 21) / 9)),
  );
  const finalFadeSamples = Math.min(sampleCount, 256);
  const topVelocityTransition = transition((midi - 99) / 9);
  const upperActionLeverage = bell(midi, 105, 2.2);
  const velocityExponent =
    0.28 +
    register +
    0.64 * topVelocityTransition +
    0.45 * upperActionLeverage +
    0.82 * transition((36 - midi) / 15);
  const bassVelocityVoicing = transition((48 - midi) / 27);
  const bassVelocityBumpDb =
    7 *
    bassVelocityVoicing *
    bell(strikeVelocity, 0.38, 0.25);
  const bassCompensation = 1 + 0.48 * clamp((45 - midi) / 24, 0, 1);
  const bassTrim = lerp(0.25, 1, transition((midi - 21) / 27));
  const velocityGain =
    0.3 *
    bassCompensation *
    bassTrim *
    10 ** (interpolateCurve(midi, RADIATION_CURVE_DB, 2) / 20) *
    10 ** (bassVelocityBumpDb / 20) *
    strikeVelocity ** velocityExponent *
    (0.84 + 0.16 * strikeVelocity);

  const hammerCutoff = 1_300 + 8_600 * strikeVelocity ** 1.55;
  const hammerLowpassStep = 1 - Math.exp(-TWO_PI * hammerCutoff / SAMPLE_RATE);
  let hammerLowpass = 0;
  const noiseFilters = NOISE_FILTERS.map((filter) => filter.slice());
  let mechanicalLowpass = 0;
  let damperLowpass = 0;
  const mechanicalLowpassStep = 1 - Math.exp(-TWO_PI * 950 / SAMPLE_RATE);
  const damperLowpassStep = 1 - Math.exp(-TWO_PI * 1_150 / SAMPLE_RATE);
  const hammerSamples = hammerForce.length;
  const hammerNoiseSamples = Math.min(sampleCount, Math.round(0.085 * SAMPLE_RATE));
  const bassNoiseTransition = transition((midi - 36) / 24);
  const feltPresenceRadiation = lerp(0.12, 1, bassNoiseTransition);
  const feltAirRadiation = lerp(0.04, 1, bassNoiseTransition);
  const strikeDelaySamples = 8;
  const thumpFrequency = lerp(82, 155, register) * lerp(0.96, 1.08, strikeVelocity);
  const diffuseBodyDecaySeconds = lerp(2.6, 1.15, register);
  const diffusePlateRegister = clamp((midi - 57) / 36, 0, 1);
  const upperBridgePlate = 1 + 2 * bell(midi, 81, 10);
  const topBodyTransition = transition((midi - 93) / 12);
  const diffuseLowBodyScale =
    1 - 0.97 * topBodyTransition * Math.sqrt(strikeVelocity);
  const radiationLowGain =
    10 ** (1.35 * radiationEqDb(midi, strikeVelocity, 0) / 20);
  const radiationCenterGain =
    10 ** (0.75 * radiationEqDb(midi, strikeVelocity, 1) / 20);
  const radiationHighGain =
    10 ** (1.35 * radiationEqDb(midi, strikeVelocity, 2) / 20);
  const radiationLowStep = 1 - Math.exp(-TWO_PI * 250 / SAMPLE_RATE);
  const radiationCenterStep = 1 - Math.exp(-TWO_PI * 900 / SAMPLE_RATE);
  const radiationHighStep = 1 - Math.exp(-TWO_PI * 2_500 / SAMPLE_RATE);
  const radiationGainNormalization = radiationNormalization(
    frequency,
    radiationLowStep,
    radiationCenterStep,
    radiationHighStep,
    radiationLowGain,
    radiationCenterGain,
    radiationHighGain,
  );
  let radiationLow = 0;
  let radiationCenter = 0;
  let radiationMid = 0;
  const boardLossScale = -0.48 * Math.LN10 / (20 * SAMPLE_RATE);
  const boardLossPoles = [0, 1, 2, 3].map((band) =>
    Math.exp(
      boardLossScale *
        boardLossDbPerSecond(midi, strikeVelocity, band),
  ));
  const boardLossGains = [1, 1, 1, 1];
  const stringMix = 0.74 + 0.13 * bell(midi, 93, 10);

  let previousInput = 0;
  let dcBlocker = 0;
  const dcPole = 0.99945;

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const strikeIndex = sampleIndex - strikeDelaySamples;
    const isReleased = sampleIndex >= releaseStart;
    let diffuseBody = 0;
    if (strikeIndex >= 0) {
      const bodyWhite = bodyNoise() * 2 - 1;
      const bodyGrain = filterChain(bodyWhite, noiseFilters, 9, 12);
      const plateGrain = filterChain(bodyWhite, noiseFilters, 12, 14);
      const bodyRise = 1 - decay(strikeIndex, 0.004);
      const bodyTail = decay(strikeIndex, diffuseBodyDecaySeconds);
      const plateRise = 1 - decay(strikeIndex, 0.06);
      const plateTail = decay(strikeIndex, 0.45);
      diffuseBody =
        0.015 *
        (1.7 - 1.4 * strikeVelocity) *
        (0.55 + 0.45 * register) *
        diffuseLowBodyScale *
        bodyGrain *
        bodyRise *
        bodyTail +
        0.002 *
          diffusePlateRegister *
          upperBridgePlate *
          plateGrain *
          plateRise *
          plateTail;
    }
    let strings = 0;

    for (let modeIndex = 0; modeIndex < modes.length; modeIndex += 1) {
      const mode = modes[modeIndex];
      const forceIndex = strikeIndex - mode[15];
      const force = forceIndex >= 0 && forceIndex < hammerSamples
        ? hammerForce[forceIndex]
        : 0;
      const fast = resonate(mode, 0, force);
      const slow = resonate(mode, 5, force);
      const polarizationForceIndex = strikeIndex - mode[16];
      const polarizationForce =
        polarizationForceIndex >= 0 && polarizationForceIndex < hammerSamples
          ? hammerForce[polarizationForceIndex]
          : 0;
      const polarization = resonate(mode, 10, polarizationForce);
      mode[17] += (1 - mode[17]) * mode[18];
      if (isReleased) mode[19] *= mode[20];
      const bridgeTransmission = smoothstep(mode[17]);
      strings +=
        (fast + slow + polarization) *
        bridgeTransmission *
        mode[19];
    }

    let hammer = 0;
    if (strikeIndex >= 0 && strikeIndex < hammerNoiseSamples) {
      const white = noise() * 2 - 1;
      hammerLowpass += hammerLowpassStep * (white - hammerLowpass);
      const feltLowpassed = filterChain(white, noiseFilters, 0, 3);
      const feltPresence = filterBiquad(feltLowpassed, noiseFilters[3]);
      const feltAir = filterChain(white, noiseFilters, 4, 6);
      const bodyGrain = filterChain(white, noiseFilters, 6, 9);
      mechanicalLowpass += mechanicalLowpassStep * (white - mechanicalLowpass);
      const lingeringFelt =
        feltLowpassed *
        (1 - decay(strikeIndex, 0.00055)) *
        decay(strikeIndex, 0.028);
      const lingeringPresence =
        feltPresence *
        (1 - decay(strikeIndex, 0.00035)) *
        decay(strikeIndex, 0.07);
      const earlyPresence =
        feltPresence *
        (1 - decay(strikeIndex, 0.0012)) *
        decay(strikeIndex, 0.008);
      const lingeringAir =
        feltAir *
        (1 - decay(strikeIndex, 0.00035)) *
        decay(strikeIndex, 0.07);
      const bodyGrainEnvelope =
        (1 - decay(strikeIndex, 0.004)) * decay(strikeIndex, 0.032);
      hammer =
        0.024 * strikeVelocity ** 1.55 * lingeringFelt +
        0.05 * strikeVelocity ** 1.75 * feltPresenceRadiation * lingeringPresence +
        0.04 * strikeVelocity ** 1.62 * feltPresenceRadiation * earlyPresence +
        0.0022 * strikeVelocity ** 1.9 * feltAirRadiation * lingeringAir +
        0.2 *
          strikeVelocity ** 0.45 *
          register ** 2 *
          bodyGrain *
          bodyGrainEnvelope;

      if (strikeIndex < hammerSamples) {
        const collisionShape = hammerForce[strikeIndex] * hammerSamples;
        const collision = Math.sqrt(collisionShape);
        const felt = hammerLowpass * collision;
        const feltContact = feltPresence * collision;
        const airContact = feltAir * collision;
        const mechanicalImpact =
          0.03 * strikeVelocity ** 1.2 * mechanicalLowpass * collision;
        const thump =
          Math.sin(TWO_PI * thumpFrequency * strikeIndex / SAMPLE_RATE) *
          decay(strikeIndex, 0.012) *
          (1 - decay(strikeIndex, 0.00045));
        hammer +=
          (0.005 * strikeVelocity ** 1.35 * felt +
            0.012 * strikeVelocity ** 1.55 * feltPresenceRadiation * feltContact +
            0.006 * strikeVelocity ** 1.9 * feltAirRadiation * airContact +
            mechanicalImpact +
            0.006 * thump) *
          (0.72 + 0.28 * register);
      }
    }

    let damper = 0;
    if (isReleased && releaseStart > 0 && midi < 100) {
      const releaseIndex = sampleIndex - releaseStart;
      const releasePosition = releaseIndex / releaseSamples;
      const white = noise() * 2 - 1;
      damperLowpass += damperLowpassStep * (white - damperLowpass);
      const noiseEnvelope =
        (1 - decay(releaseIndex, 0.0015)) *
        decay(releaseIndex, 0.026) *
        Math.sin(Math.PI * releasePosition);
      damper = 0.011 * (0.35 + 0.65 * strikeVelocity) * damperLowpass * noiseEnvelope;
    }

    hammer += diffuseBody;
    const excitation = strings + hammer;
    const body = filterSoundboard(excitation, soundboard);
    const impactForce =
      strikeIndex >= 0 && strikeIndex < hammerSamples ? hammerForce[strikeIndex] : 0;
    const impactBody = filterImpactSoundboard(impactForce, impactSoundboard);
    let sample = velocityGain *
      (stringMix * strings +
        1.18 * body +
        1.35 * impactBody +
        hammer +
        damper);

    radiationLow += radiationLowStep * (sample - radiationLow);
    radiationCenter += radiationCenterStep * (sample - radiationCenter);
    radiationMid += radiationHighStep * (sample - radiationMid);
    for (let band = 0; band < 4; band += 1) {
      boardLossGains[band] = clamp(
        boardLossGains[band] * boardLossPoles[band],
        0.1,
        4,
      );
    }
    sample =
      (boardLossGains[0] * radiationLowGain * radiationLow +
        boardLossGains[1] * radiationCenterGain * (radiationCenter - radiationLow) +
        boardLossGains[2] * (radiationMid - radiationCenter) +
        boardLossGains[3] * radiationHighGain * (sample - radiationMid)) /
      radiationGainNormalization;

    sample = 0.94 * Math.tanh(1.12 * sample);
    const highpassed = sample - previousInput + dcPole * dcBlocker;
    previousInput = sample;
    dcBlocker = highpassed;
    sample = highpassed;

    if (sampleIndex < startFadeSamples) {
      const startFade =
        0.5 - 0.5 * Math.cos(Math.PI * sampleIndex / (startFadeSamples - 1));
      sample *= startFade * startFade;
    }
    if (sampleIndex >= sampleCount - finalFadeSamples) {
      const remaining = sampleCount - 1 - sampleIndex;
      const endFade = 0.5 - 0.5 * Math.cos(Math.PI * remaining / (finalFadeSamples - 1 || 1));
      sample *= endFade;
    }

    output[sampleIndex] = clamp(sample, -0.94, 0.94);
  }

  output[0] = 0;
  output[sampleCount - 1] = 0;
  return output;
}

export default synthesizeGrandPiano;
