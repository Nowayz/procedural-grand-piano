import { DEFAULT_REVERB_WET } from '../src/reverb.js';

const GAIN_CALIBRATION = 0.00125;
const GAIN_CALIBRATION_SAMPLE_RATE = 44_100;
const MIN_POWER = 0.000125;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function fft(real, imaginary, inverse) {
  const size = real.length;
  for (let index = 1, reversed = 0; index < size; index += 1) {
    let bit = size >> 1;
    while (reversed & bit) { reversed ^= bit; bit >>= 1; }
    reversed ^= bit;
    if (index < reversed) { const realValue = real[index]; const imaginaryValue = imaginary[index]; real[index] = real[reversed]; imaginary[index] = imaginary[reversed]; real[reversed] = realValue; imaginary[reversed] = imaginaryValue; }
  }
  for (let width = 2; width <= size; width <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / width;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    const halfWidth = width >> 1;
    for (let offset = 0; offset < size; offset += width) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let index = 0; index < halfWidth; index += 1) {
        const even = offset + index;
        const odd = even + halfWidth;
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextTwiddleReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextTwiddleReal;
      }
    }
  }
  if (inverse) for (let index = 0; index < size; index += 1) { real[index] /= size; imaginary[index] /= size; }
}

function createWorkspace(impulseLength, blockSize) {
  const partitionCount = Math.ceil(impulseLength / blockSize);
  const fftSize = blockSize << 1;
  const spectrumLength = partitionCount * fftSize;
  return { blockSize, fftSize, partitionCount, impulseReal: new Float64Array(spectrumLength), impulseImaginary: new Float64Array(spectrumLength), inputReal: new Float64Array(spectrumLength), inputImaginary: new Float64Array(spectrumLength), workReal: new Float64Array(fftSize), workImaginary: new Float64Array(fftSize), sumReal: new Float64Array(fftSize), sumImaginary: new Float64Array(fftSize) };
}

function loadImpulse(workspace, impulse, scale) {
  const { blockSize, fftSize, partitionCount, impulseReal, impulseImaginary, workReal, workImaginary } = workspace;
  for (let partition = 0; partition < partitionCount; partition += 1) {
    workReal.fill(0);
    workImaginary.fill(0);
    const sourceStart = partition * blockSize;
    const sourceEnd = Math.min(sourceStart + blockSize, impulse.length);
    for (let source = sourceStart; source < sourceEnd; source += 1) workReal[source - sourceStart] = impulse[source] * scale;
    fft(workReal, workImaginary, false);
    impulseReal.set(workReal, partition * fftSize);
    impulseImaginary.set(workImaginary, partition * fftSize);
  }
}

function convolveChannel(output, input, impulse, scale, workspace) {
  const { blockSize, fftSize, partitionCount, impulseReal, impulseImaginary, inputReal, inputImaginary, workReal, workImaginary, sumReal, sumImaginary } = workspace;
  loadImpulse(workspace, impulse, scale);
  inputReal.fill(0);
  inputImaginary.fill(0);
  output.fill(0);
  const blockCount = Math.ceil(input.length / blockSize);
  for (let block = 0; block < blockCount; block += 1) {
    const inputStart = block * blockSize;
    const inputEnd = Math.min(inputStart + blockSize, input.length);
    const slot = block % partitionCount;
    const slotOffset = slot * fftSize;
    workReal.fill(0);
    workImaginary.fill(0);
    for (let source = inputStart; source < inputEnd; source += 1) workReal[source - inputStart] = input[source];
    fft(workReal, workImaginary, false);
    inputReal.set(workReal, slotOffset);
    inputImaginary.set(workImaginary, slotOffset);
    sumReal.fill(0);
    sumImaginary.fill(0);
    for (let partition = 0; partition < partitionCount; partition += 1) {
      const inputOffset = ((slot - partition + partitionCount) % partitionCount) * fftSize;
      const impulseOffset = partition * fftSize;
      for (let bin = 0; bin < fftSize; bin += 1) { const a = inputReal[inputOffset + bin]; const b = inputImaginary[inputOffset + bin]; const c = impulseReal[impulseOffset + bin]; const d = impulseImaginary[impulseOffset + bin]; sumReal[bin] += a * c - b * d; sumImaginary[bin] += a * d + b * c; }
    }
    fft(sumReal, sumImaginary, true);
    const outputEnd = Math.min(inputStart + fftSize, output.length);
    for (let destination = inputStart; destination < outputEnd; destination += 1) output[destination] += sumReal[destination - inputStart];
  }
}

function normalizationScale(left, right, sampleRate) {
  let power = 0;
  for (let index = 0; index < left.length; index += 1) power += left[index] * left[index] + right[index] * right[index];
  power = Math.sqrt(power / (2 * left.length));
  if (!Number.isFinite(power) || power < MIN_POWER) power = MIN_POWER;
  return GAIN_CALIBRATION / power * GAIN_CALIBRATION_SAMPLE_RATE / sampleRate;
}

function masterStereo(left, right, sampleRate) {
  let leftMean = 0;
  let rightMean = 0;
  for (let index = 0; index < left.length; index += 1) { leftMean += left[index]; rightMean += right[index]; }
  leftMean /= left.length;
  rightMean /= right.length;
  const fadeSamples = Math.min(left.length, Math.round(0.65 * sampleRate));
  let peak = 0;
  for (let index = 0; index < left.length; index += 1) { const fade = index < left.length - fadeSamples ? 1 : Math.sin(Math.PI * 0.5 * (left.length - 1 - index) / Math.max(1, fadeSamples - 1)) ** 2; left[index] = (left[index] - leftMean) * fade; right[index] = (right[index] - rightMean) * fade; peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index])); }
  const gain = peak > 0 ? 0.92 / peak : 1;
  for (let index = 0; index < left.length; index += 1) { left[index] *= gain; right[index] *= gain; }
  left[0] = 0;
  right[0] = 0;
  left[left.length - 1] = 0;
  right[right.length - 1] = 0;
  return gain;
}

export function applyStereoLoudnessCeiling(left, right, { ceilingDb = -26, detectorAttackSeconds = 0.03, detectorReleaseSeconds = 0.3, gainAttackSeconds = 0.008, gainReleaseSeconds = 0.7, lookaheadSeconds = 0.04, sampleRate = 44_100 } = {}) {
  if (left.length !== right.length) throw new RangeError('stereo channel lengths must match');
  if (!(sampleRate > 0) || !Number.isFinite(ceilingDb)) throw new RangeError('sample rate and loudness ceiling must be finite');
  const desiredGain = new Float32Array(left.length), threshold = 10 ** (ceilingDb / 20), detectorAttack = Math.exp(-1 / (detectorAttackSeconds * sampleRate)), detectorRelease = Math.exp(-1 / (detectorReleaseSeconds * sampleRate));
  let power = 0;
  for (let index = 0; index < left.length; index += 1) { const instantaneousPower = .5 * (left[index] ** 2 + right[index] ** 2), coefficient = instantaneousPower > power ? detectorAttack : detectorRelease; power = coefficient * power + (1 - coefficient) * instantaneousPower; desiredGain[index] = Math.min(1, threshold / Math.sqrt(Math.max(power, Number.EPSILON))); }
  const gainAttack = Math.exp(-1 / (gainAttackSeconds * sampleRate)), gainRelease = Math.exp(-1 / (gainReleaseSeconds * sampleRate)), lookahead = Math.round(lookaheadSeconds * sampleRate); let gain = 1, minimumGain = 1;
  for (let index = 0; index < left.length; index += 1) { const target = desiredGain[Math.min(left.length - 1, index + lookahead)], coefficient = target < gain ? gainAttack : gainRelease; gain = coefficient * gain + (1 - coefficient) * target; minimumGain = Math.min(minimumGain, gain); left[index] *= gain; right[index] *= gain; }
  return { minimumGain, maximumReductionDb: -20 * Math.log10(minimumGain) };
}

export function applyConvolverReverb(left, right, impulseLeft, impulseRight, { wet = DEFAULT_REVERB_WET, normalize = true, master = true, sampleRate = 44_100, blockSize = 16_384 } = {}) {
  if (left.length !== right.length || impulseLeft.length !== impulseRight.length || impulseLeft.length === 0) throw new RangeError('stereo channel lengths must match and the impulse response must not be empty');
  if (blockSize < 2 || blockSize & blockSize - 1) throw new RangeError('blockSize must be a power of two');
  const wetGain = clamp(wet, 0, 1);
  const scale = normalize ? normalizationScale(impulseLeft, impulseRight, sampleRate) : 1;
  const workspace = createWorkspace(impulseLeft.length, blockSize);
  const wetBuffer = new Float32Array(left.length);
  convolveChannel(wetBuffer, left, impulseLeft, scale, workspace);
  for (let index = 0; index < left.length; index += 1) left[index] += wetBuffer[index] * wetGain;
  convolveChannel(wetBuffer, right, impulseRight, scale, workspace);
  for (let index = 0; index < right.length; index += 1) right[index] += wetBuffer[index] * wetGain;
  const masteringGain = master ? masterStereo(left, right, sampleRate) : 1;
  return { normalizationScale: scale, masteringGain };
}
