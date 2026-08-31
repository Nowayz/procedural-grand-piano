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

function requireFiniteNumber(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

function midiFromFrequency(frequency) {
  return 69 + 12 * Math.log2(frequency / 440);
}

/**
 * A small deterministic PRNG. Noise represents hammer/felt and damper motion;
 * the seed is derived from sanitized frequency and velocity. Duration is
 * intentionally excluded so longer renders preserve the same attack prefix.
 */
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

/**
 * Piano-wire stiffness is U-shaped through much of the scale and climbs
 * sharply in the short, thick treble strings. The anchors are deliberately
 * smooth so arbitrary frequencies do not reveal sampled key zones.
 */
function stiffnessForMidi(midi) {
  const anchors = [
    // Wound-bass construction changes are not monotonic: different wrap
    // counts and speaking lengths produce real local turns in B. These
    // anchors are smooth-interpolated measurements, not sampled waveforms.
    [21, 2.9e-4],
    [24, 2.3e-4],
    [27, 2.45e-4],
    [30, 8.3e-5],
    [33, 8.2e-5],
    [36, 1.34e-4],
    [39, 2.5e-4],
    [42, 1.6e-4],
    [45, 1.4e-4],
    [48, 1.05e-4],
    [51, 1.25e-4],
    [54, 1.82e-4],
    [57, 2.12e-4],
    [60, 2.95e-4],
    [63, 3.5e-4],
    [66, 5.35e-4],
    [69, 6.2e-4],
    [72, 8.3e-4],
    [75, 1.04e-3],
    [78, 1.1e-3],
    [81, 1.73e-3],
    [84, 2.18e-3],
    [87, 3.04e-3],
    [93, 5.4e-3],
    [108, 9.0e-3],
  ];

  for (let index = 1; index < anchors.length; index += 1) {
    const [upperMidi, upperValue] = anchors[index];
    const [lowerMidi, lowerValue] = anchors[index - 1];
    if (midi <= upperMidi) {
      const position = clamp((midi - lowerMidi) / (upperMidi - lowerMidi), 0, 1);
      // Log interpolation avoids an audible corner in the bass-to-tenor dip.
      return Math.exp(lerp(Math.log(lowerValue), Math.log(upperValue), position));
    }
  }
  return anchors.at(-1)[1];
}

function stringDetunes(midi) {
  if (midi < 31) return [0];

  const register = clamp((midi - 31) / 77, 0, 1);
  // Real treble unisons in the reference resolve into a several-hertz cluster,
  // not one FFT line. The widening also models slight bridge-termination and
  // speaking-length differences between nominally equal strings.
  const widthCents = lerp(0.32, 4.1, register ** 1.5);
  if (midi < 49) return [-0.47 * widthCents, 0.53 * widthCents];
  return [-0.83 * widthCents, -0.34 * widthCents, 0.95 * widthCents];
}

function fundamentalT60(frequency) {
  return clamp(11 * (261.625565 / frequency) ** 0.45, 2.35, 31);
}

/**
 * Smooth scalar radiation calibration measured from the development grand.
 * These are early-energy offsets only—not waveform, spectrum, or envelope
 * data. Interpolation keeps arbitrary frequencies continuous between the
 * instrument's minor-third measurement anchors.
 */
function radiationLevelGain(midi) {
  const anchorsDb = [
    [21, -0.24], [24, 0.69], [27, 0.25], [30, -3.5], [33, -2.2],
    [36, -3.33], [39, 0.43], [42, 0.71], [45, -0.9], [48, -1.98],
    [51, -1.27], [54, -3.88], [57, -5.42], [60, -2.09], [63, -6.99],
    [66, -3.79], [69, -3.22], [72, -1.59], [75, 1.2], [78, 3.24],
    [81, 0.1], [84, 2.35], [87, 6.72], [90, 3.84], [93, 7.01],
    [96, 4.63], [99, 2.42], [102, 6.17], [105, 2.38], [108, 4.39],
  ];
  for (let index = 1; index < anchorsDb.length; index += 1) {
    const [upperMidi, upperDb] = anchorsDb[index];
    const [lowerMidi, lowerDb] = anchorsDb[index - 1];
    if (midi <= upperMidi) {
      const linearPosition = clamp(
        (midi - lowerMidi) / (upperMidi - lowerMidi),
        0,
        1,
      );
      const position = linearPosition * linearPosition * (3 - 2 * linearPosition);
      return 10 ** (lerp(lowerDb, upperDb, position) / 20);
    }
  }
  return 10 ** (anchorsDb.at(-1)[1] / 20);
}

function modalRadiationGain(partial, bassToMiddle, middleToTreble, velocity) {
  // Residual bridge-admittance calibration in dB. Each row is a smooth
  // register target for the first sixteen stiff-string modes; it corrects
  // persistent modal nodes without encoding any audio or time envelope.
  const bassDb = [
    -2, 4.5, 0, -3, -2.5, -1, 1, -7, -3, -1, -3.5, -5, -2, -3, -5, -8,
  ];
  const middleDb = [
    2.3, -2.2, -3.3, -3.7, -1.1, -1.5, 6, 4, 1, 0, 0, 0, 1, 0, 1, 0,
  ];
  const trebleDb = [
    0, -6 + 6 * velocity, 8.5, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ];
  if (partial > bassDb.length) return 1;
  const index = partial - 1;
  const lowerRegisterDb = lerp(bassDb[index], middleDb[index], bassToMiddle);
  const calibrationDb = lerp(lowerRegisterDb, trebleDb[index], middleToTreble);
  return 10 ** (calibrationDb / 20);
}

function bridgeAdmittanceGain(frequency) {
  const anchorsDb = [
    [27.5, -2], [55, -4], [70, 0], [100, 1], [200, 0], [250, -1.5],
    [500, -1.5], [800, -2.5], [1_200, -1.5], [1_800, -1.5],
    [2_400, 1], [3_200, 3], [4_500, 3], [6_000, 1.5],
    [8_000, 2], [16_000, 0],
  ];
  for (let index = 1; index < anchorsDb.length; index += 1) {
    const [upperHz, upperDb] = anchorsDb[index];
    const [lowerHz, lowerDb] = anchorsDb[index - 1];
    if (frequency <= upperHz) {
      const linearPosition = clamp(
        Math.log(frequency / lowerHz) / Math.log(upperHz / lowerHz),
        0,
        1,
      );
      const position = linearPosition * linearPosition * (3 - 2 * linearPosition);
      return 10 ** (lerp(lowerDb, upperDb, position) / 20);
    }
  }
  return 1;
}

/**
 * Approximate the force history of a felt-covered piano hammer collision.
 * Harder blows compress the nonlinear felt more deeply, shorten contact, and
 * produce a narrower force pulse. Unit-area normalization separates collision
 * shape from the public velocity/loudness curve.
 */
function createHammerForce(velocity, register, frequency) {
  const softContactSeconds = lerp(0.0034, 0.00085, register);
  const hardContactSeconds = lerp(0.00155, 0.00023, register);
  const unconstrainedContact = lerp(
    softContactSeconds,
    hardContactSeconds,
    velocity ** 0.62,
  );
  // A lumped half-sine collision otherwise double-filters the modes already
  // shaped by the felt cutoff below. Keep it below one string cycle from the
  // tenor upward, with the longer A6-calibrated limit restored in the treble.
  const treblePosition = clamp((register - 0.5) / 0.34, 0, 1);
  const trebleBlend = treblePosition * treblePosition * (3 - 2 * treblePosition);
  const hardContactPosition = clamp((velocity - 0.08) / 0.52, 0, 1);
  const hardContactBlend = hardContactPosition * hardContactPosition *
    (3 - 2 * hardContactPosition);
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

function createStringModes(frequency, velocity, midi) {
  const stiffness = stiffnessForMidi(midi);
  const detunes = stringDetunes(midi);
  const register = clamp((midi - 21) / 87, 0, 1);
  const extremeTreble = clamp((register - 0.88) / 0.12, 0, 1);
  const bassTransition = clamp((register - 0.12) / 0.32, 0, 1);
  const bassBroadening = bassTransition * bassTransition *
    (3 - 2 * bassTransition);
  const trebleTransition = clamp((register - 0.5) / 0.34, 0, 1);
  const trebleVoicing = trebleTransition * trebleTransition *
    (3 - 2 * trebleTransition);
  const middleBroadening = bassBroadening * (1 - trebleVoicing);
  const bassPosition = clamp((48 - midi) / 27, 0, 1);
  const bassVoicing = bassPosition * bassPosition * (3 - 2 * bassPosition);
  const middlePresence = Math.exp(-(((midi - 60) / 10) ** 2));
  // Long-string spectra in the references place the broad hammer node near
  // the eighth partial. The previous 1/7 placement suppressed partial seven
  // and left partial eight conspicuously strong—the opposite pattern.
  const strikePosition = lerp(0.127, 0.112, register);
  // Small treble hammers remain capable of exciting the fundamental even on a
  // soft strike, so the cutoff gets a register-dependent floor.
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
  const baseT60 = fundamentalT60(frequency);
  const stiffnessNormalization = Math.sqrt(1 + stiffness);
  const unisonWeights = detunes.length === 3
    ? [0.09, 0.46, 0.45]
    : detunes.length === 2
      ? [0.47, 0.53]
      : [1];
  const forceDelays = detunes.length === 3 ? [0, 2, 1] : [0, 0];
  const modes = [];

  // Sixty-four modes truncate A0 below 1.8 kHz, even though the measured
  // wound-string spectrum remains structured past 4 kHz. The frequency gate
  // still keeps higher registers compact; only long bass strings approach the
  // 192-mode ceiling.
  for (let partial = 1; partial <= 192; partial += 1) {
    const dispersedFrequency =
      (partial * frequency * Math.sqrt(1 + stiffness * partial * partial)) /
      stiffnessNormalization;
    if (dispersedFrequency > spectralLimit) break;

    const strikeCoupling = 0.2 + 0.8 * Math.abs(Math.sin(Math.PI * partial * strikePosition));
    const feltFilter = Math.exp(-((dispersedFrequency / brightnessCutoff) ** 1.3));
    const hammerVelocityBase = lerp(
      0.56 + 0.44 * velocity,
      0.82 + 0.18 * velocity,
      middleBroadening,
    );
    const velocityBrightening = hammerVelocityBase ** Math.log2(partial);
    // A soundboard radiates the very lowest fundamentals inefficiently. The
    // broad mid-register bridge response also makes the second partial a
    // signature component around middle C, while short treble strings shed
    // upper modes very quickly.
    const radiation = 0.08 + 0.92 * dispersedFrequency / (dispersedFrequency + 150);
    const midBridgeCoupling =
      1 +
      2.1 *
        Math.exp(-(((midi - 65) / 10) ** 2)) *
        Math.exp(-(((partial - 2) / 0.75) ** 2));
    const trebleModeDamping = Math.exp(
      -4.4 *
        register ** 4.2 *
        (partial - 1) *
        (0.72 - 0.32 * velocity - 0.22 * extremeTreble * velocity) *
        lerp(1, 0.45, middleBroadening),
    );
    const registerRadiationGain = 1 + 2.8 * register ** 2.2;
    // The reference soundboard/bridge admittance has a broad presence region
    // around 1.8 kHz. It keeps partials 5–8 alive around middle C instead of
    // letting the felt contact turn the register into a two-partial tone.
    const bridgePresenceShape = Math.exp(
      -((Math.log(dispersedFrequency / 1_800) / 0.29) ** 2),
    );
    const bridgePresenceGain = 1 + 0.7 * middlePresence * bridgePresenceShape;
    const bridgeAntiresonanceShape = Math.exp(
      -((Math.log(dispersedFrequency / 790) / 0.08) ** 2),
    );
    const bridgeAntiresonance =
      1 - 0.85 * middlePresence * bridgeAntiresonanceShape;
    const middleBodyShape = Math.exp(-(((partial - 4.5) / 1.0) ** 4));
    const middleBodyLevel = 1 - 0.5 * middlePresence * middleBodyShape;
    // Long bass strings couple their fundamental inefficiently to the bridge,
    // while a broad group of low-order overtones radiates readily. This is a
    // smooth register model, not a per-key EQ curve.
    const bassOvertoneRadiation =
      1 + 4 * bassVoicing * (1 - Math.exp(-(partial - 1) / 1.6));
    const woundStringPosition = clamp((48 - midi) / 27, 0, 1);
    const woundStringVoicing =
      woundStringPosition * woundStringPosition * (3 - 2 * woundStringPosition);
    const weakBassFundamental =
      1 -
      (0.91 - 0.4 * bassVoicing) *
        woundStringVoicing *
        Math.exp(-(((partial - 1) / 0.55) ** 4));
    const weakBassSecond =
      1 -
      (0.93 - 0.4 * bassVoicing) *
        woundStringVoicing *
        Math.exp(-(((partial - 2) / 0.55) ** 4));
    const bassHighPartialPosition = clamp((partial - 10) / 7, 0, 1);
    const bassHighPartialTransition =
      bassHighPartialPosition * bassHighPartialPosition *
      (3 - 2 * bassHighPartialPosition);
    const bassHighPartialRadiation =
      1 + 4.5 * bassVoicing * bassHighPartialTransition;
    const bassPresenceShape = Math.exp(
      -((Math.log(dispersedFrequency / 1_800) / 1.05) ** 4),
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
        bridgeAdmittanceGain(dispersedFrequency)) /
      partial ** partialRolloff;

    const bassPresenceDecayPosition = clamp(
      Math.log2(dispersedFrequency / 500) / 2,
      0,
      1,
    );
    const bassPresenceDecay =
      bassPresenceDecayPosition * bassPresenceDecayPosition *
      (3 - 2 * bassPresenceDecayPosition);
    const undampedPartialT60 =
      baseT60 *
      (0.35 + 0.65 / partial ** 0.7) *
      Math.exp(-dispersedFrequency / 24_000) *
      (1 + 0.7 * (1 - bassBroadening) * bassPresenceDecay);
    const lowOrderTrebleTail = Math.exp(-(((partial - 1.5) / 1) ** 4));
    const trebleHighPartialTail = 1 - Math.exp(-(partial - 1) / 2.5);
    const middleUpperModeTail = Math.exp(-(((partial - 4.5) / 0.9) ** 4));
    const lateTrebleTailPosition = clamp((midi - 94) / 14, 0, 1);
    const lateTrebleTail =
      lateTrebleTailPosition * lateTrebleTailPosition *
      (3 - 2 * lateTrebleTailPosition);
    const slowTailT60 =
      undampedPartialT60 *
      (1 + 0.15 * bassVoicing) *
      (1 + 1.5 * middlePresence * middleUpperModeTail) *
      (1 + 2.4 * lateTrebleTail * trebleHighPartialTail) *
      (1 -
        lowOrderTrebleTail *
          (0.25 * trebleVoicing + 0.2 * extremeTreble));
    const baseFastFraction = 0.14 + 0.43 * (partial / (partial + 5));
    const middleLowModeLoss =
      0.3 *
      middlePresence *
      Math.exp(-(((partial - 1.5) / 0.8) ** 4));
    const middleBodySustain =
      0.38 *
      middlePresence *
      middleBodyShape;
    // Vertical motion couples strongly into the bridge and dies quickly. A
    // much quieter horizontal component retains the long T60. This two-stage
    // energy transfer dominates hard treble-note decay in the reference.
    const maximumFastFraction = partial === 1
      ? lerp(0.965, 0.82, register ** 1.5)
      : lerp(0.94, 0.68, register ** 1.4);
    const fastFraction = clamp(
      baseFastFraction +
        1.12 * register ** 2 * (0.88 + 0.12 * velocity) +
        middleLowModeLoss -
        middleBodySustain,
      0,
      maximumFastFraction,
    );
    let fastRatio =
      lerp(0.19, 0.045, register ** 1.35) *
      lerp(1, 0.72, partial / (partial + 8));
    if (partial === 2) fastRatio *= lerp(1, 0.15, register ** 2);
    const fastT60 = undampedPartialT60 * fastRatio;
    const bridgeRiseSeconds =
      (0.00125 + 0.005 / (1 + partial * 0.42)) *
      lerp(1.35, 0.78, register) *
      (1 + 0.9 * register ** 2 + 3.5 * register ** 6) *
      (1 +
        0.27 * Math.exp(-(((midi - 93) / 10) ** 2)) +
        0.24 * extremeTreble);
    const verticalSecondPartialBoost = partial === 2
      ? 1 + 4.5 * register ** 3 * velocity
      : 1;
    const damperT60 =
      midi >= 96
        ? 0.34 * (0.75 + 0.25 / Math.sqrt(partial))
        : lerp(0.16, 0.075, register) / (1 + 0.055 * (partial - 1));

    for (let stringIndex = 0; stringIndex < detunes.length; stringIndex += 1) {
      const cents = detunes[stringIndex];
      const stringFrequency = dispersedFrequency * 2 ** (cents / 1_200);
      const angularStep = TWO_PI * stringFrequency / SAMPLE_RATE;
      // Slight unequal weights keep the summed unison from sounding synthetic.
      const equalWeight = 1 / detunes.length;
      const unisonInequality = register ** 1.5;
      const stringWeight = lerp(
        equalWeight,
        unisonWeights[stringIndex],
        unisonInequality,
      );
      const fastPole = Math.exp(-6.907755 / (fastT60 * SAMPLE_RATE));
      const slowPole = Math.exp(-6.907755 / (slowTailT60 * SAMPLE_RATE));
      // Each string also has a weak orthogonal polarization. Its slightly
      // shifted resonance and medium decay create the irregular energy return
      // and side peaks that a single planar oscillator cannot produce.
      const polarizationCents =
        (0.35 + 1.1 * register) *
        Math.sin(2.17 * partial + 1.31 * stringIndex + 0.4);
      const polarizationFrequency = stringFrequency * 2 ** (polarizationCents / 1_200);
      const polarizationStep = TWO_PI * polarizationFrequency / SAMPLE_RATE;
      const polarizationT60 = slowTailT60 * lerp(0.68, 0.34, register);
      const polarizationPole = Math.exp(-6.907755 / (polarizationT60 * SAMPLE_RATE));
      const polarizationStrength =
        (0.035 + 0.11 * register) *
        (0.55 + 0.45 * velocity) /
        partial ** 0.2;

      modes.push({
        fast1: 0,
        fast2: 0,
        slow1: 0,
        slow2: 0,
        fastA1: 2 * fastPole * Math.cos(angularStep),
        fastA2: -(fastPole * fastPole),
        slowA1: 2 * slowPole * Math.cos(angularStep),
        slowA2: -(slowPole * slowPole),
        fastDrive:
          amplitude *
          stringWeight *
          fastFraction *
          verticalSecondPartialBoost *
          Math.sin(angularStep),
        slowDrive:
          amplitude *
          stringWeight *
          (1 - fastFraction) *
          Math.sin(angularStep),
        polarization1: 0,
        polarization2: 0,
        polarizationA1: 2 * polarizationPole * Math.cos(polarizationStep),
        polarizationA2: -(polarizationPole * polarizationPole),
        polarizationDrive:
          amplitude * stringWeight * polarizationStrength * Math.sin(polarizationStep),
        forceDelay: forceDelays[stringIndex],
        polarizationDelay: stringIndex + 1,
        bridgeRise: 0,
        bridgeRiseStep: 1 - Math.exp(-1 / (bridgeRiseSeconds * SAMPLE_RATE)),
        release: 1,
        releaseMultiplier: Math.exp(-6.907755 / (damperT60 * SAMPLE_RATE)),
      });
    }
  }
  return modes;
}

/** RBJ band-pass sections stand in for broad soundboard/case radiation modes. */
function createSoundboard() {
  const specifications = [
    [72, 1.25, 0.16],
    [116, 1.6, 0.2],
    [185, 1.8, 0.19],
    [285, 2.1, 0.16],
    [435, 2.4, 0.13],
    [690, 2.7, 0.1],
    [1_080, 3.1, 0.075],
    [1_720, 3.5, 0.052],
    [2_750, 4.0, 0.034],
    [4_300, 4.4, 0.018],
  ];

  return specifications.map(([frequency, q, gain]) => {
    const omega = TWO_PI * frequency / SAMPLE_RATE;
    const alpha = Math.sin(omega) / (2 * q);
    const inverseA0 = 1 / (1 + alpha);
    return {
      b0: alpha * inverseA0,
      b2: -alpha * inverseA0,
      a1: -2 * Math.cos(omega) * inverseA0,
      a2: (1 - alpha) * inverseA0,
      x1: 0,
      x2: 0,
      y1: 0,
      y2: 0,
      gain,
    };
  });
}

function filterSoundboard(input, filters) {
  let result = 0;
  for (let index = 0; index < filters.length; index += 1) {
    const filter = filters[index];
    const output =
      filter.b0 * input +
      filter.b2 * filter.x2 -
      filter.a1 * filter.y1 -
      filter.a2 * filter.y2;
    filter.x2 = filter.x1;
    filter.x1 = input;
    filter.y2 = filter.y1;
    filter.y1 = output;
    result += filter.gain * output;
  }
  return result;
}

function createLowOrHighpass(frequency, highpass = false) {
  const omega = TWO_PI * frequency / SAMPLE_RATE;
  const cosine = Math.cos(omega);
  const alpha = Math.sin(omega) / (2 * Math.SQRT1_2);
  const inverseA0 = 1 / (1 + alpha);
  const sign = highpass ? 1 : -1;
  return {
    b0: (1 + sign * cosine) * 0.5 * inverseA0,
    b1: -(sign + cosine) * inverseA0,
    b2: (1 + sign * cosine) * 0.5 * inverseA0,
    a1: -2 * cosine * inverseA0,
    a2: (1 - alpha) * inverseA0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
  };
}

function filterBiquad(input, filter) {
  const output =
    filter.b0 * input +
    filter.b1 * filter.x1 +
    filter.b2 * filter.x2 -
    filter.a1 * filter.y1 -
    filter.a2 * filter.y2;
  filter.x2 = filter.x1;
  filter.x1 = input;
  filter.y2 = filter.y1;
  filter.y1 = output;
  return output;
}

/**
 * A struck wooden plate has many short-lived modes beyond the broad radiation
 * curve above. These fixed, sample-free modes are driven only by the hammer
 * force; they supply the wooden bridge/case impulse without becoming a second
 * sustained pitch source.
 */
function createImpactSoundboard(velocity, register) {
  const specifications = [
    [58, 0.035, 0.065],
    [87, 0.031, -0.058],
    [126, 0.028, 0.052],
    [181, 0.025, -0.046],
    [255, 0.023, 0.041],
    [354, 0.021, -0.036],
    [486, 0.019, 0.032],
    [661, 0.018, -0.028],
    [891, 0.017, 0.025],
    [1_188, 0.016, -0.022],
    [1_565, 0.015, 0.019],
    [2_036, 0.0085, -0.25],
    [2_617, 0.008, 0.35],
    [3_323, 0.012, -0.07],
    [4_168, 0.011, 0.0115],
    [5_164, 0.01, -0.01],
    [6_321, 0.0092, 0.0087],
    [7_648, 0.0085, -0.0075],
    [9_151, 0.0081, 0.0096],
    [10_834, 0.0075, -0.0081],
    [12_696, 0.0069, 0.00675],
    [14_735, 0.00625, -0.00555],
  ];
  const impactStrength = velocity ** 1.6 * (0.82 + 0.18 * register);
  const midi = 21 + 87 * register;
  const middleBody = Math.exp(-(((midi - 60) / 10) ** 2));
  const trebleBodyPosition = clamp((midi - 72) / 36, 0, 1);
  const trebleBody = trebleBodyPosition * trebleBodyPosition *
    (3 - 2 * trebleBodyPosition);
  // Only the final octave needs the unusually strong action/case residue.
  // Starting this rise around A6 let a hard body thud mask the string and
  // inverted the measured velocity/brightness relationship there.
  const extremeTrebleBodyPosition = clamp((midi - 99) / 9, 0, 1);
  const extremeTrebleBody = extremeTrebleBodyPosition * extremeTrebleBodyPosition *
    (3 - 2 * extremeTrebleBodyPosition);
  const trebleVelocityPosition = clamp((midi - 84) / 18, 0, 1);
  const trebleVelocityVoicing = trebleVelocityPosition * trebleVelocityPosition *
    (3 - 2 * trebleVelocityPosition);
  const bassPlatePosition = clamp((midi - 30) / 30, 0, 1);
  const bassPlateTransition = bassPlatePosition * bassPlatePosition *
    (3 - 2 * bassPlatePosition);

  return specifications.map(([frequency, decaySeconds, gain], index) => {
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
    // A lightly coupled plate polarization is far quieter at the onset but
    // survives after the lossy bridge-local motion has fallen away. Keeping
    // separate poles reproduces the measured fast-drop/slow-tail body decay.
    const lowPlatePosition = clamp((400 - frequency) / 350, 0, 1);
    const lowPlateWeight =
      lowPlatePosition * lowPlatePosition * (3 - 2 * lowPlatePosition);
    const slowBodyFraction = lowBodyMode
      ? bodyModeWeight *
        (0.32 * middleBody + 0.16 * trebleBody * (1 + 2 * lowPlateWeight))
      : 0;
    const slowDecaySeconds = decaySeconds *
      (1 + bodyModeWeight * (90 * middleBody + 100 * trebleBody));
    const fastPole = Math.exp(-1 / (fastDecaySeconds * SAMPLE_RATE));
    const slowPole = Math.exp(-1 / (slowDecaySeconds * SAMPLE_RATE));
    const attackDecayMultiplier = frequency >= 250 ? 2.8 : 2.2;
    const attackPole = Math.exp(
      -1 / (attackDecayMultiplier * decaySeconds * SAMPLE_RATE),
    );
    const highFrequency = Math.max(1, frequency / 500);
    const feltBrightness = (0.58 + 0.42 * velocity) ** Math.log2(highFrequency);
    const modeShape = 0.72 + 0.28 * Math.sin(0.73 * index + 3.1 * register);
    // A short treble string cannot inject a large quasi-static displacement
    // into the case. Its collision preferentially reaches the smaller,
    // higher plate modes; bass hammers retain the full low-mode coupling.
    let impactRadiation = lerp(
      1,
      clamp(Math.sqrt(frequency / 2_000), 0.2, 1),
      register ** 2,
    );
    const extremeTreble = clamp((register - 0.88) / 0.12, 0, 1);
    // The last octave couples less strongly to the 2–3 kHz plate modes but
    // exposes a proportionally large action/case thud before its tiny string
    // reaches full bridge velocity.
    if (lowBodyMode) impactRadiation = lerp(impactRadiation, 1, extremeTreble);
    const midPlateScale = frequency >= 1_800 && frequency < 3_800
      ? lerp(1, 0.18, extremeTreble)
      : 1;
    // At the top of the scale the action/case impulse is proportionally
    // conspicuous on pianissimo notes, while a hard strike lets the short
    // string dominate. This crossfade prevents body energy from scaling with
    // velocity faster than the bright string component (which produces an
    // unphysical inverse brightness curve).
    const bodyVelocity = Math.max(velocity, 0.04);
    const lowBodyVelocityScale = lerp(
      bodyVelocity ** -0.45,
      0.1 * bodyVelocity ** -2.5,
      trebleVelocityVoicing,
    );
    const coupledBodyDrive =
      0.75 * (1 + 2 * middleBody + 6 * extremeTrebleBody) * lowBodyVelocityScale;
    const lowBodyDrive = lerp(1, coupledBodyDrive, bodyModeWeight);
    const bassHighPlateScale = frequency >= 1_800
      ? lerp(0.1, 1, bassPlateTransition)
      : 1;
    return {
      y1: 0,
      y2: 0,
      a1: 2 * fastPole * Math.cos(angularStep),
      a2: -(fastPole * fastPole),
      slowY1: 0,
      slowY2: 0,
      attackY1: 0,
      attackY2: 0,
      attackRise: 0,
      attackRiseStep: 1 - Math.exp(-1 / (0.005 * SAMPLE_RATE)),
      slowA1: 2 * slowPole * Math.cos(angularStep),
      slowA2: -(slowPole * slowPole),
      attackA1: 2 * attackPole * Math.cos(angularStep),
      attackA2: -(attackPole * attackPole),
      drive:
        gain * lowBodyDrive * bassHighPlateScale * midPlateScale * impactStrength *
        feltBrightness * modeShape * impactRadiation * (1 - slowBodyFraction) *
        Math.sin(angularStep),
      slowDrive:
        gain * lowBodyDrive * bassHighPlateScale * midPlateScale * impactStrength *
        feltBrightness * modeShape * impactRadiation * slowBodyFraction *
        Math.sin(angularStep),
      attackDrive:
        gain * lowBodyDrive * bassHighPlateScale * midPlateScale * impactStrength *
        feltBrightness * modeShape * impactRadiation *
        (2.5 * bodyModeWeight * trebleBody) *
        Math.sin(angularStep),
    };
  });
}

function filterImpactSoundboard(force, modes) {
  let result = 0;
  for (let index = 0; index < modes.length; index += 1) {
    const mode = modes[index];
    const output = mode.a1 * mode.y1 + mode.a2 * mode.y2 + mode.drive * force;
    const slowOutput =
      mode.slowA1 * mode.slowY1 +
      mode.slowA2 * mode.slowY2 +
      mode.slowDrive * force;
    const attackOutput =
      mode.attackA1 * mode.attackY1 +
      mode.attackA2 * mode.attackY2 +
      mode.attackDrive * force;
    mode.y2 = mode.y1;
    mode.y1 = output;
    mode.slowY2 = mode.slowY1;
    mode.slowY1 = slowOutput;
    mode.attackY2 = mode.attackY1;
    mode.attackY1 = attackOutput;
    mode.attackRise += (1 - mode.attackRise) * mode.attackRiseStep;
    result +=
      output +
      slowOutput +
      attackOutput * mode.attackRise;
  }
  return result;
}

/**
 * Render a grand-piano note.
 *
 * Input policy:
 * - all arguments must be finite JavaScript numbers (otherwise TypeError);
 * - frequency is clamped to the acoustic-piano range A0..C8;
 * - velocity is clamped to 0..1; exactly zero returns digital silence;
 * - duration is clamped to 0..30 seconds;
 * - sample count is round(clampedDuration * 44100).
 *
 * `duration_seconds` is the total returned duration. The final part of the
 * buffer models key release/damper contact, so callers do not need to append a
 * tail. Output is deterministic, mono, finite, click-faded, and bounded within
 * [-0.94, +0.94].
 *
 * @param {number} note_hz fundamental frequency in hertz
 * @param {number} velocity hammer velocity, normally 0..1
 * @param {number} duration_seconds total rendered duration in seconds
 * @returns {Float32Array} normalized mono PCM at {@link SAMPLE_RATE}
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

  const midi = midiFromFrequency(frequency);
  const register = clamp((midi - 21) / 87, 0, 1);
  const hammerForce = createHammerForce(strikeVelocity, register, frequency);
  const modes = createStringModes(frequency, strikeVelocity, midi);
  const soundboard = createSoundboard();
  const impactSoundboard = createImpactSoundboard(strikeVelocity, register);
  const noise = makeNoise(seedFromArguments(frequency, strikeVelocity));
  const bodyNoise = makeNoise(seedFromArguments(frequency, strikeVelocity) ^ 0x9e3779b9);

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
  const finalFadeSamples = Math.min(sampleCount, 256);
  // The supplied grand's bass layers have a compressed displacement curve:
  // soft hammers still move a long string substantially, while the treble
  // remains close to a linear velocity response.
  const topVelocityPosition = clamp((midi - 99) / 9, 0, 1);
  const topVelocityTransition =
    topVelocityPosition * topVelocityPosition * (3 - 2 * topVelocityPosition);
  const upperActionLeverage = Math.exp(-(((midi - 105) / 2.2) ** 2));
  const velocityExponent =
    0.08 +
    register +
    0.7 * topVelocityTransition +
    0.45 * upperActionLeverage;
  const bassVelocityPosition = clamp((48 - midi) / 27, 0, 1);
  const bassVelocityVoicing =
    bassVelocityPosition * bassVelocityPosition * (3 - 2 * bassVelocityPosition);
  const bassVelocityBumpDb =
    7 *
    bassVelocityVoicing *
    Math.exp(-(((strikeVelocity - 0.38) / 0.25) ** 2));
  const bassCompensation = 1 + 0.48 * clamp((45 - midi) / 24, 0, 1);
  const bassTrimPosition = clamp((midi - 21) / 27, 0, 1);
  const bassTrim = lerp(
    0.25,
    1,
    bassTrimPosition * bassTrimPosition * (3 - 2 * bassTrimPosition),
  );
  const velocityGain =
    0.3 *
    bassCompensation *
    bassTrim *
    radiationLevelGain(midi) *
    10 ** (bassVelocityBumpDb / 20) *
    strikeVelocity ** velocityExponent *
    (0.84 + 0.16 * strikeVelocity);

  const hammerCutoff = 1_300 + 8_600 * strikeVelocity ** 1.55;
  const hammerLowpassStep = 1 - Math.exp(-TWO_PI * hammerCutoff / SAMPLE_RATE);
  let hammerLowpass = 0;
  const feltPresenceLowpass1 = createLowOrHighpass(6_500);
  const feltPresenceLowpass2 = createLowOrHighpass(6_500);
  const feltPresenceLowpass3 = createLowOrHighpass(6_500);
  const feltPresenceHighpass = createLowOrHighpass(1_800, true);
  const feltAirHighpass = createLowOrHighpass(7_500, true);
  const feltAirLowpass = createLowOrHighpass(15_500);
  const bodyGrainLowpass1 = createLowOrHighpass(1_100);
  const bodyGrainLowpass2 = createLowOrHighpass(1_100);
  const bodyGrainHighpass = createLowOrHighpass(180, true);
  const diffuseBodyLowpass1 = createLowOrHighpass(630);
  const diffuseBodyLowpass2 = createLowOrHighpass(630);
  const diffuseBodyHighpass = createLowOrHighpass(55, true);
  const diffusePlateHighpass = createLowOrHighpass(1_600, true);
  const diffusePlateLowpass = createLowOrHighpass(8_000);
  let mechanicalLowpass = 0;
  let damperLowpass = 0;
  const mechanicalLowpassStep = 1 - Math.exp(-TWO_PI * 950 / SAMPLE_RATE);
  const damperLowpassStep = 1 - Math.exp(-TWO_PI * 1_150 / SAMPLE_RATE);
  const hammerSamples = hammerForce.length;
  const hammerNoiseSamples = Math.min(sampleCount, Math.round(0.085 * SAMPLE_RATE));
  const bassNoisePosition = clamp((midi - 36) / 24, 0, 1);
  const bassNoiseTransition =
    bassNoisePosition * bassNoisePosition * (3 - 2 * bassNoisePosition);
  const feltPresenceRadiation = lerp(0.12, 1, bassNoiseTransition);
  const feltAirRadiation = lerp(0.04, 1, bassNoiseTransition);
  const strikeDelaySamples = 8;
  const thumpFrequency = lerp(82, 155, register) * lerp(0.96, 1.08, strikeVelocity);
  const diffuseBodyDecaySeconds = lerp(2.6, 1.15, register);
  const diffusePlateRegister = clamp((midi - 57) / 36, 0, 1);
  const upperBridgePlate = 1 + 2 * Math.exp(-(((midi - 81) / 10) ** 2));
  const topBodyPosition = clamp((midi - 93) / 12, 0, 1);
  const topBodyTransition =
    topBodyPosition * topBodyPosition * (3 - 2 * topBodyPosition);
  const diffuseLowBodyScale = 1 - 0.97 * topBodyTransition;

  let previousInput = 0;
  let dcBlocker = 0;
  const dcPole = 0.99945;

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const strikeIndex = sampleIndex - strikeDelaySamples;
    const isReleased = sampleIndex >= releaseStart;
    let diffuseBody = 0;
    if (strikeIndex >= 0) {
      // A real board distributes a little energy between resolved string and
      // plate modes. Two seeded, filtered bands approximate that decaying
      // microstructure without a sampled impulse response: low wooden body
      // plus a quieter delayed plate sheen.
      const bodyWhite = bodyNoise() * 2 - 1;
      const bodyGrain = filterBiquad(
        filterBiquad(
          filterBiquad(bodyWhite, diffuseBodyLowpass1),
          diffuseBodyLowpass2,
        ),
        diffuseBodyHighpass,
      );
      const plateGrain = filterBiquad(
        filterBiquad(bodyWhite, diffusePlateHighpass),
        diffusePlateLowpass,
      );
      const bodyRise = 1 - Math.exp(-strikeIndex / (0.004 * SAMPLE_RATE));
      const bodyTail = Math.exp(
        -strikeIndex / (diffuseBodyDecaySeconds * SAMPLE_RATE),
      );
      const plateRise = 1 - Math.exp(-strikeIndex / (0.06 * SAMPLE_RATE));
      const plateTail = Math.exp(-strikeIndex / (0.45 * SAMPLE_RATE));
      diffuseBody =
        0.015 *
        strikeVelocity ** 0.65 *
        (0.55 + 0.45 * register) *
        diffuseLowBodyScale *
        bodyGrain *
        bodyRise *
        bodyTail +
        0.002 *
          strikeVelocity ** 0.85 *
          diffusePlateRegister *
          upperBridgePlate *
          plateGrain *
          plateRise *
          plateTail;
    }
    let strings = 0;

    for (let modeIndex = 0; modeIndex < modes.length; modeIndex += 1) {
      const mode = modes[modeIndex];
      const forceIndex = strikeIndex - mode.forceDelay;
      const force = forceIndex >= 0 && forceIndex < hammerForce.length
        ? hammerForce[forceIndex]
        : 0;
      const fast =
        mode.fastA1 * mode.fast1 + mode.fastA2 * mode.fast2 + mode.fastDrive * force;
      const slow =
        mode.slowA1 * mode.slow1 + mode.slowA2 * mode.slow2 + mode.slowDrive * force;
      const polarizationForceIndex = strikeIndex - mode.polarizationDelay;
      const polarizationForce =
        polarizationForceIndex >= 0 && polarizationForceIndex < hammerForce.length
          ? hammerForce[polarizationForceIndex]
          : 0;
      const polarization =
        mode.polarizationA1 * mode.polarization1 +
        mode.polarizationA2 * mode.polarization2 +
        mode.polarizationDrive * polarizationForce;
      mode.fast2 = mode.fast1;
      mode.fast1 = fast;
      mode.slow2 = mode.slow1;
      mode.slow1 = slow;
      mode.polarization2 = mode.polarization1;
      mode.polarization1 = polarization;
      mode.bridgeRise += (1 - mode.bridgeRise) * mode.bridgeRiseStep;
      if (isReleased) mode.release *= mode.releaseMultiplier;
      const bridgeTransmission =
        mode.bridgeRise * mode.bridgeRise * (3 - 2 * mode.bridgeRise);
      strings +=
        (fast + slow + polarization) *
        bridgeTransmission *
        mode.release;
    }

    let hammer = 0;
    if (strikeIndex >= 0 && strikeIndex < hammerNoiseSamples) {
      const white = noise() * 2 - 1;
      hammerLowpass += hammerLowpassStep * (white - hammerLowpass);
      const feltLowpassed = filterBiquad(
        filterBiquad(
          filterBiquad(white, feltPresenceLowpass1),
          feltPresenceLowpass2,
        ),
        feltPresenceLowpass3,
      );
      const feltPresence = filterBiquad(feltLowpassed, feltPresenceHighpass);
      const feltAir = filterBiquad(
        filterBiquad(white, feltAirHighpass),
        feltAirLowpass,
      );
      const bodyGrain = filterBiquad(
        filterBiquad(
          filterBiquad(white, bodyGrainLowpass1),
          bodyGrainLowpass2,
        ),
        bodyGrainHighpass,
      );
      mechanicalLowpass += mechanicalLowpassStep * (white - mechanicalLowpass);
      const lingeringFelt =
        feltLowpassed *
        (1 - Math.exp(-strikeIndex / (0.00055 * SAMPLE_RATE))) *
        Math.exp(-strikeIndex / (0.028 * SAMPLE_RATE));
      const lingeringPresence =
        feltPresence *
        (1 - Math.exp(-strikeIndex / (0.00035 * SAMPLE_RATE))) *
        Math.exp(-strikeIndex / (0.07 * SAMPLE_RATE));
      const earlyPresence =
        feltPresence *
        (1 - Math.exp(-strikeIndex / (0.0012 * SAMPLE_RATE))) *
        Math.exp(-strikeIndex / (0.008 * SAMPLE_RATE));
      const lingeringAir =
        feltAir *
        (1 - Math.exp(-strikeIndex / (0.00035 * SAMPLE_RATE))) *
        Math.exp(-strikeIndex / (0.07 * SAMPLE_RATE));
      const bodyGrainEnvelope =
        (1 - Math.exp(-strikeIndex / (0.004 * SAMPLE_RATE))) *
        Math.exp(-strikeIndex / (0.032 * SAMPLE_RATE));
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
        const felt = hammerLowpass * Math.sqrt(collisionShape);
        const feltContact = feltPresence * Math.sqrt(collisionShape);
        const airContact = feltAir * Math.sqrt(collisionShape);
        const mechanicalImpact =
          0.03 * strikeVelocity ** 1.2 * mechanicalLowpass * Math.sqrt(collisionShape);
        const thump =
          Math.sin(TWO_PI * thumpFrequency * strikeIndex / SAMPLE_RATE) *
          Math.exp(-strikeIndex / (0.012 * SAMPLE_RATE)) *
          (1 - Math.exp(-strikeIndex / (0.00045 * SAMPLE_RATE)));
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
        (1 - Math.exp(-releaseIndex / (0.0015 * SAMPLE_RATE))) *
        Math.exp(-releaseIndex / (0.026 * SAMPLE_RATE)) *
        Math.sin(Math.PI * releasePosition);
      damper = 0.011 * (0.35 + 0.65 * strikeVelocity) * damperLowpass * noiseEnvelope;
    }

    hammer += diffuseBody;
    const excitation = strings + hammer;
    const body = filterSoundboard(excitation, soundboard);
    const impactForce =
      strikeIndex >= 0 && strikeIndex < hammerForce.length ? hammerForce[strikeIndex] : 0;
    const impactBody = filterImpactSoundboard(impactForce, impactSoundboard);
    let sample = velocityGain *
      (0.78 * strings + 1.18 * body + 1.35 * impactBody + hammer + damper);

    // Apply the fixed soft limiter before the DC blocker. A nonlinear transfer
    // can create a small mean offset from an asymmetric modal mixture even
    // when its input has already been high-passed.
    sample = 0.94 * Math.tanh(1.12 * sample);
    const highpassed = sample - previousInput + dcPole * dcBlocker;
    previousInput = sample;
    dcBlocker = highpassed;
    sample = highpassed;

    if (sampleIndex < 32) {
      const startFade = 0.5 - 0.5 * Math.cos(Math.PI * sampleIndex / 31);
      sample *= startFade * startFade;
    }
    if (sampleIndex >= sampleCount - finalFadeSamples) {
      const remaining = sampleCount - 1 - sampleIndex;
      const endFade = 0.5 - 0.5 * Math.cos(Math.PI * remaining / (finalFadeSamples - 1 || 1));
      sample *= endFade;
    }

    // Fixed transfer (not per-note peak normalization) preserves velocity dynamics.
    output[sampleIndex] = clamp(sample, -0.94, 0.94);
  }

  // Make the boundary contract exact even after Float32 rounding.
  output[0] = 0;
  output[sampleCount - 1] = 0;
  return output;
}

export default synthesizeGrandPiano;
