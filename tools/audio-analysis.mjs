import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export function nextPowerOfTwo(value) {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

const SAMPLE_RATE_CONVERTER_RADIUS = 6;
const SAMPLE_RATE_CONVERTER_PHASES = 1_024;

function sinc(value) {
  if (Math.abs(value) < 1e-12) return 1;
  const angle = Math.PI * value;
  return Math.sin(angle) / angle;
}

/**
 * Convert sample rate while preserving the recording's physical pitch and
 * duration. This API deliberately accepts rates, not an arbitrary playback
 * ratio, so it cannot be used by reference tests to transpose a key zone.
 */
export function convertSampleRate(samples, sourceRate, targetRate, outputLength) {
  if (!Number.isFinite(sourceRate) || sourceRate <= 0) {
    throw new RangeError('sourceRate must be a positive finite number');
  }
  if (!Number.isFinite(targetRate) || targetRate <= 0) {
    throw new RangeError('targetRate must be a positive finite number');
  }
  const naturalLength = Math.floor(samples.length * targetRate / sourceRate);
  const length = outputLength ?? naturalLength;
  if (!Number.isInteger(length) || length < 0 || length > naturalLength) {
    throw new RangeError('outputLength must fit the rate-converted recording');
  }
  if (sourceRate === targetRate) return samples.slice(0, length);

  const rate = sourceRate / targetRate;
  const cutoff = Math.min(1, 1 / rate);
  const taps = SAMPLE_RATE_CONVERTER_RADIUS * 2;
  const kernels = new Float64Array(SAMPLE_RATE_CONVERTER_PHASES * taps);
  for (let phase = 0; phase < SAMPLE_RATE_CONVERTER_PHASES; phase += 1) {
    const fraction = phase / SAMPLE_RATE_CONVERTER_PHASES;
    let total = 0;
    for (let tap = 0; tap < taps; tap += 1) {
      const offset = tap - SAMPLE_RATE_CONVERTER_RADIUS + 1;
      const distance = offset - fraction;
      const coefficient = Math.abs(distance) < SAMPLE_RATE_CONVERTER_RADIUS
        ? cutoff * sinc(cutoff * distance) * sinc(distance / SAMPLE_RATE_CONVERTER_RADIUS)
        : 0;
      kernels[phase * taps + tap] = coefficient;
      total += coefficient;
    }
    for (let tap = 0; tap < taps; tap += 1) kernels[phase * taps + tap] /= total;
  }

  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * rate;
    let center = Math.floor(position);
    let phase = Math.round((position - center) * SAMPLE_RATE_CONVERTER_PHASES);
    if (phase === SAMPLE_RATE_CONVERTER_PHASES) {
      center += 1;
      phase = 0;
    }
    const sourceStart = center - SAMPLE_RATE_CONVERTER_RADIUS + 1;
    let value = 0;
    for (let tap = 0; tap < taps; tap += 1) {
      const sourceIndex = sourceStart + tap;
      if (sourceIndex >= 0 && sourceIndex < samples.length) {
        value += samples[sourceIndex] * kernels[phase * taps + tap];
      }
    }
    output[index] = value;
  }
  return output;
}

/** In-place radix-2 Cooley-Tukey FFT. */
function fft(real, imaginary) {
  const size = real.length;
  for (let index = 1, reversed = 0; index < size; index += 1) {
    let bit = size >> 1;
    while (reversed & bit) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }

  for (let width = 2; width <= size; width *= 2) {
    const angle = -2 * Math.PI / width;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let offset = 0; offset < size; offset += width) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let index = 0; index < width / 2; index += 1) {
        const even = offset + index;
        const odd = even + width / 2;
        const oddReal =
          real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary =
          real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextTwiddleReal =
          twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary =
          twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextTwiddleReal;
      }
    }
  }
}

export function spectrum(samples, sampleRate, { start = 0, length = samples.length - start, fftSize = nextPowerOfTwo(length) } = {}) {
  const safeStart = Math.max(0, Math.floor(start));
  const available = Math.max(0, Math.min(Math.floor(length), samples.length - safeStart));
  if (fftSize < available || (fftSize & (fftSize - 1)) !== 0) {
    throw new RangeError('fftSize must be a power of two at least as large as length');
  }

  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  let mean = 0;
  for (let index = 0; index < available; index += 1) {
    mean += samples[safeStart + index];
  }
  mean /= available || 1;

  for (let index = 0; index < available; index += 1) {
    const window = available > 1
      ? 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (available - 1))
      : 1;
    real[index] = (samples[safeStart + index] - mean) * window;
  }
  fft(real, imaginary);

  const powers = new Float64Array(fftSize / 2 + 1);
  for (let index = 0; index < powers.length; index += 1) {
    powers[index] = real[index] ** 2 + imaginary[index] ** 2;
  }
  return { powers, binHz: sampleRate / fftSize, fftSize, length: available };
}

export function peakNear(spectralData, minimumHz, maximumHz) {
  const { powers, binHz } = spectralData;
  const lower = Math.max(1, Math.ceil(minimumHz / binHz));
  const upper = Math.min(powers.length - 2, Math.floor(maximumHz / binHz));
  if (lower > upper) return { frequencyHz: Number.NaN, power: 0, bin: -1 };

  let peakBin = lower;
  for (let bin = lower + 1; bin <= upper; bin += 1) {
    if (powers[bin] > powers[peakBin]) peakBin = bin;
  }

  const left = Math.log(Math.max(powers[peakBin - 1], Number.MIN_VALUE));
  const center = Math.log(Math.max(powers[peakBin], Number.MIN_VALUE));
  const right = Math.log(Math.max(powers[peakBin + 1], Number.MIN_VALUE));
  const denominator = left - 2 * center + right;
  const correction = denominator === 0
    ? 0
    : Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / denominator));
  return {
    frequencyHz: (peakBin + correction) * binHz,
    power: powers[peakBin],
    bin: peakBin,
  };
}

export function spectralCentroid(spectralData, minimumHz = 20, maximumHz = 16_000) {
  const { powers, binHz } = spectralData;
  const lower = Math.max(1, Math.ceil(minimumHz / binHz));
  const upper = Math.min(powers.length - 1, Math.floor(maximumHz / binHz));
  let weighted = 0;
  let total = 0;
  for (let bin = lower; bin <= upper; bin += 1) {
    weighted += bin * binHz * powers[bin];
    total += powers[bin];
  }
  return total > 0 ? weighted / total : 0;
}

export function bandPower(spectralData, minimumHz, maximumHz) {
  const { powers, binHz } = spectralData;
  const lower = Math.max(0, Math.ceil(minimumHz / binHz));
  const upper = Math.min(powers.length - 1, Math.floor(maximumHz / binHz));
  let total = 0;
  for (let bin = lower; bin <= upper; bin += 1) total += powers[bin];
  return total;
}

export function signalStats(samples) {
  if (samples.length === 0) {
    return {
      sampleCount: 0,
      finite: true,
      peak: 0,
      rms: 0,
      dc: 0,
      maximumDelta: 0,
      first: 0,
      last: 0,
    };
  }

  let peak = 0;
  let sum = 0;
  let sumSquares = 0;
  let maximumDelta = 0;
  let finite = true;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index];
    if (!Number.isFinite(value)) finite = false;
    peak = Math.max(peak, Math.abs(value));
    sum += value;
    sumSquares += value * value;
    if (index > 0) {
      maximumDelta = Math.max(maximumDelta, Math.abs(value - samples[index - 1]));
    }
  }
  return {
    sampleCount: samples.length,
    finite,
    peak,
    rms: Math.sqrt(sumSquares / samples.length),
    dc: sum / samples.length,
    maximumDelta,
    first: samples[0],
    last: samples.at(-1),
  };
}

export function rmsBetween(samples, start, end) {
  const lower = Math.max(0, Math.floor(start));
  const upper = Math.min(samples.length, Math.ceil(end));
  if (upper <= lower) return 0;
  let sum = 0;
  for (let index = lower; index < upper; index += 1) {
    sum += samples[index] * samples[index];
  }
  return Math.sqrt(sum / (upper - lower));
}

/**
 * Causal sliding-RMS envelope. Unlike a centered convolution, this never
 * looks ahead across the beginning of a buffer, so a render that starts at
 * sample zero cannot be assigned a fictitious negative-time onset.
 */
export function causalRmsEnvelope(samples, sampleRate, { windowSeconds = 0.003, limitSeconds = samples.length / sampleRate } = {}) {
  const limit = Math.max(
    0,
    Math.min(samples.length, Math.round(limitSeconds * sampleRate)),
  );
  const windowSize = Math.max(1, Math.round(windowSeconds * sampleRate));
  const envelope = new Float64Array(limit);
  let energy = 0;
  for (let index = 0; index < limit; index += 1) {
    energy += samples[index] ** 2;
    if (index >= windowSize) energy -= samples[index - windowSize] ** 2;
    envelope[index] = Math.sqrt(
      Math.max(0, energy) / Math.min(index + 1, windowSize),
    );
  }
  return envelope;
}

export function attackMetrics(samples, sampleRate) {
  const envelope = causalRmsEnvelope(samples, sampleRate, {
    windowSeconds: 0.003,
    limitSeconds: 0.25,
  });
  if (envelope.length === 0) {
    return { onsetSeconds: 0, peakSeconds: 0, peakEnvelope: 0 };
  }

  let maximum = 0;
  let maximumIndex = 0;
  for (let index = 0; index < envelope.length; index += 1) {
    if (envelope[index] > maximum) {
      maximum = envelope[index];
      maximumIndex = index;
    }
  }

  const threshold = maximum * 0.04;
  let onsetIndex = 0;
  while (onsetIndex < envelope.length && envelope[onsetIndex] < threshold) onsetIndex += 1;
  return {
    onsetSeconds: onsetIndex / sampleRate,
    peakSeconds: Math.max(0, maximumIndex - onsetIndex) / sampleRate,
    peakEnvelope: maximum,
  };
}

export const TRANSIENT_BANDS = Object.freeze({
  lowBody: [30, 1_000],
  fundamental: [1_670, 1_840],
  woodAndString: [1_900, 3_200],
  secondPartial: [3_300, 3_800],
  presence: [4_000, 8_000],
  air: [8_000, 16_000],
});

/** Analyze short onset-aligned frames with one consistent FFT method. */
export function transientFrameMetrics(samples, sampleRate, onsetSeconds, windowsMilliseconds = [[0, 5], [5, 10], [10, 20], [20, 40], [40, 80]], bands = TRANSIENT_BANDS) {
  const results = [];
  for (const [startMs, endMs] of windowsMilliseconds) {
    const start = Math.max(0, Math.round((onsetSeconds + startMs / 1_000) * sampleRate));
    const end = Math.min(
      samples.length,
      Math.round((onsetSeconds + endMs / 1_000) * sampleRate),
    );
    const length = Math.max(0, end - start);
    const rms = rmsBetween(samples, start, end);
    let peak = 0;
    for (let index = start; index < end; index += 1) {
      peak = Math.max(peak, Math.abs(samples[index]));
    }
    const fftSize = nextPowerOfTwo(Math.max(512, length));
    const spectralData = spectrum(samples, sampleRate, { start, length, fftSize });
    const totalPower = Math.max(
      bandPower(spectralData, 30, 16_000),
      Number.MIN_VALUE,
    );
    const bandRelativeDb = {};
    for (const [name, [minimumHz, maximumHz]] of Object.entries(bands)) {
      bandRelativeDb[name] = 10 * Math.log10(
        Math.max(bandPower(spectralData, minimumHz, maximumHz), Number.MIN_VALUE) /
          totalPower,
      );
    }
    results.push({
      startMs,
      endMs,
      sampleCount: length,
      rms,
      peak,
      crestFactor: rms > 0 ? peak / rms : 0,
      centroidHz: spectralCentroid(spectralData, 30, 16_000),
      bandRelativeDb,
    });
  }
  return results;
}

/**
 * Fixed RMS windows relative to a detected onset. Values are useful both as a
 * decay trajectory and for exposing unison-beat rebounds that one T60 fit
 * hides.
 */
export function onsetRmsTrajectory(samples, sampleRate, onsetSeconds, startsSeconds = [0.02, 0.05, 0.1, 0.15, 0.25, 0.4, 0.7, 1, 1.5, 2, 3], windowSeconds = 0.05) {
  const values = startsSeconds
    .filter((startSeconds) => onsetSeconds + startSeconds < samples.length / sampleRate)
    .map((startSeconds) => ({
      startSeconds,
      rms: rmsBetween(
        samples,
        (onsetSeconds + startSeconds) * sampleRate,
        (onsetSeconds + startSeconds + windowSeconds) * sampleRate,
      ),
    }));
  const reference = values[0]?.rms ?? 0;
  return values.map((item) => ({
    ...item,
    relativeDb: reference > 0
      ? 20 * Math.log10(Math.max(item.rms, Number.MIN_VALUE) / reference)
      : Number.NEGATIVE_INFINITY,
  }));
}

/**
 * Resolve significant local peaks around a nominal unison. Hann sidelobes are
 * below the default threshold, so the returned span represents multiple
 * string/polarization resonances rather than the FFT main lobe.
 */
export function spectralPeakCluster(spectralData, centerHz, { searchCents = 16, relativeThresholdDb = -14, minimumSeparationHz = 0.8 } = {}) {
  const { powers, binHz } = spectralData;
  const ratio = 2 ** (searchCents / 1_200);
  const lower = Math.max(1, Math.ceil(centerHz / ratio / binHz));
  const upper = Math.min(powers.length - 2, Math.floor(centerHz * ratio / binHz));
  let strongest = 0;
  for (let bin = lower; bin <= upper; bin += 1) strongest = Math.max(strongest, powers[bin]);
  const threshold = strongest * 10 ** (relativeThresholdDb / 10);
  const candidates = [];
  for (let bin = lower; bin <= upper; bin += 1) {
    if (
      powers[bin] >= threshold &&
      powers[bin] > powers[bin - 1] &&
      powers[bin] >= powers[bin + 1]
    ) {
      const peak = peakNear(spectralData, (bin - 1) * binHz, (bin + 1) * binHz);
      candidates.push({
        frequencyHz: peak.frequencyHz,
        relativeDb: 10 * Math.log10(peak.power / strongest),
        power: peak.power,
      });
    }
  }
  candidates.sort((a, b) => b.power - a.power);
  const selected = [];
  for (const candidate of candidates) {
    if (
      selected.every(
        (other) => Math.abs(other.frequencyHz - candidate.frequencyHz) >= minimumSeparationHz,
      )
    ) {
      selected.push(candidate);
    }
  }
  selected.sort((a, b) => a.frequencyHz - b.frequencyHz);
  return {
    peakCount: selected.length,
    spanHz: selected.length >= 2
      ? selected.at(-1).frequencyHz - selected[0].frequencyHz
      : 0,
    peaks: selected.map(({ frequencyHz, relativeDb }) => ({ frequencyHz, relativeDb })),
  };
}

export function estimateFundamental(samples, sampleRate, expectedHz, startSeconds = 0.04) {
  const start = Math.round(startSeconds * sampleRate);
  const length = Math.min(samples.length - start, Math.round(0.9 * sampleRate));
  if (length < 64) return Number.NaN;
  const fftSize = nextPowerOfTwo(Math.max(length, 65_536));
  const spectralData = spectrum(samples, sampleRate, { start, length, fftSize });
  return peakNear(spectralData, expectedHz * 0.965, expectedHz * 1.035).frequencyHz;
}

export function centsDifference(measuredHz, expectedHz) {
  return 1_200 * Math.log2(measuredHz / expectedHz);
}

export function partialPeaks(spectralData, fundamentalHz, maximumPartial = 12) {
  const result = [];
  for (let partial = 1; partial <= maximumPartial; partial += 1) {
    const nominal = fundamentalHz * partial;
    if (nominal >= spectralData.powers.length * spectralData.binHz) break;
    const growth = Math.min(0.11, 0.006 + 0.00055 * partial * partial);
    // At bass fundamentals a narrow cents window can fall entirely between
    // FFT bins. Always include neighboring bins so a valid partial cannot be
    // reported as zero merely because of fractional-bin alignment.
    const minimumHz = Math.min(
      nominal * 0.985,
      nominal - 1.5 * spectralData.binHz,
    );
    const maximumHz = Math.max(
      nominal * (1 + growth),
      nominal + 1.5 * spectralData.binHz,
    );
    const peak = peakNear(spectralData, minimumHz, maximumHz);
    result.push({ partial, ...peak });
  }
  return result;
}

export function estimateInharmonicity(peaks) {
  if (peaks.length < 3 || !Number.isFinite(peaks[0].frequencyHz)) return Number.NaN;
  const fundamental = peaks[0].frequencyHz;
  const candidates = [];
  const strongest = Math.max(...peaks.map((peak) => peak.power));
  for (const peak of peaks.slice(1)) {
    if (peak.power < strongest * 1e-7) continue;
    const n2 = peak.partial ** 2;
    const ratio = peak.frequencyHz / (peak.partial * fundamental);
    const estimate = (ratio * ratio - 1) / (n2 - 1);
    if (estimate >= -2e-5 && estimate < 0.03) candidates.push(estimate);
  }
  if (candidates.length === 0) return Number.NaN;
  candidates.sort((a, b) => a - b);
  return candidates[Math.floor(candidates.length / 2)];
}

export function linearSlope(points) {
  if (points.length < 2) return Number.NaN;
  const meanX = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const [x, y] of points) {
    numerator += (x - meanX) * (y - meanY);
    denominator += (x - meanX) ** 2;
  }
  return denominator > 0 ? numerator / denominator : Number.NaN;
}

export function partialDecay(samples, sampleRate, fundamentalHz, partial, timesSeconds = [0.1, 0.3, 0.6, 1.0, 1.4]) {
  const nominal = fundamentalHz * partial;
  const points = [];
  for (const time of timesSeconds) {
    const start = Math.round(time * sampleRate);
    const length = Math.min(8_192, samples.length - start);
    if (length < 2_048) continue;
    const spectralData = spectrum(samples, sampleRate, {
      start,
      length,
      fftSize: 16_384,
    });
    const growth = Math.min(0.1, 0.006 + 0.00055 * partial * partial);
    const peak = peakNear(spectralData, nominal * 0.985, nominal * (1 + growth));
    points.push([time, 10 * Math.log10(Math.max(peak.power, Number.MIN_VALUE))]);
  }
  const slopeDbPerSecond = linearSlope(points);
  return {
    slopeDbPerSecond,
    t60Seconds: slopeDbPerSecond < 0 ? -60 / slopeDbPerSecond : Number.POSITIVE_INFINITY,
    points,
  };
}

function readAscii(buffer, offset, length) {
  return buffer.toString('ascii', offset, offset + length);
}

async function readFlac(path, buffer, { preserveChannels, maximumFrames }) {
  if (buffer.length < 42 || readAscii(buffer, 0, 4) !== 'fLaC' || (buffer[4] & 0x7f) !== 0) {
    throw new Error(`${path} lacks a leading FLAC STREAMINFO block`);
  }
  const packed = buffer.readBigUInt64BE(18);
  const sampleRate = Number((packed >> 44n) & 0xfffffn);
  const channels = Number((packed >> 41n) & 0x7n) + 1;
  const bitsPerSample = Number((packed >> 36n) & 0x1fn) + 1;
  const sourceFrameCount = Number(packed & 0xfffffffffn);
  const frameCount = Math.min(sourceFrameCount, Math.max(0, Math.floor(maximumFrames)));
  const args = ['--decode', '--stdout', '--silent', '--force-raw-format', '--endian=little', '--sign=signed'];
  if (frameCount < sourceFrameCount) args.push(`--until=${frameCount}`);
  args.push(path);
  const chunks = [];
  await new Promise((resolve, reject) => {
    const child = spawn('flac', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`${path}: flac decoder exited ${code}: ${error.trim()}`)));
  });
  const raw = Buffer.concat(chunks);
  const bytesPerSample = bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || ![16, 24, 32].includes(bitsPerSample)) {
    throw new Error(`${path}: unsupported FLAC depth ${bitsPerSample}`);
  }
  const decodedFrames = Math.min(frameCount, Math.floor(raw.length / (bytesPerSample * channels)));
  const samples = new Float32Array(decodedFrames);
  const channelSamples = preserveChannels
    ? Array.from({ length: channels }, () => new Float32Array(decodedFrames))
    : undefined;
  const scale = 2 ** (bitsPerSample - 1);
  for (let frame = 0; frame < decodedFrames; frame += 1) {
    let mono = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const position = (frame * channels + channel) * bytesPerSample;
      const value = raw.readIntLE(position, bytesPerSample) / scale;
      mono += value;
      if (channelSamples) channelSamples[channel][frame] = value;
    }
    samples[frame] = mono / channels;
  }
  return { audioFormat: 'FLAC', channels, sampleRate, bitsPerSample, samples, channelSamples, sourceFrameCount };
}

export async function readWav(path, { preserveChannels = false, maximumFrames = Number.POSITIVE_INFINITY } = {}) {
  const buffer = await readFile(path);
  if (readAscii(buffer, 0, 4) === 'fLaC') {
    return readFlac(path, buffer, { preserveChannels, maximumFrames });
  }
  if (readAscii(buffer, 0, 4) !== 'RIFF' || readAscii(buffer, 8, 4) !== 'WAVE') {
    throw new Error(`${path} is not a RIFF/WAVE file`);
  }

  let format;
  let dataOffset;
  let dataLength;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = readAscii(buffer, offset, 4);
    const length = buffer.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (id === 'fmt ') {
      format = {
        audioFormat: buffer.readUInt16LE(payload),
        channels: buffer.readUInt16LE(payload + 2),
        sampleRate: buffer.readUInt32LE(payload + 4),
        bitsPerSample: buffer.readUInt16LE(payload + 14),
      };
    } else if (id === 'data') {
      dataOffset = payload;
      dataLength = length;
    }
    offset = payload + length + (length & 1);
  }

  if (!format || dataOffset === undefined) throw new Error(`${path} lacks fmt or data chunks`);
  const bytesPerSample = format.bitsPerSample / 8;
  const sourceFrameCount = Math.floor(dataLength / (bytesPerSample * format.channels));
  const frameCount = Math.min(
    sourceFrameCount,
    Math.max(0, Math.floor(maximumFrames)),
  );
  const samples = new Float32Array(frameCount);
  const channelSamples = preserveChannels
    ? Array.from({ length: format.channels }, () => new Float32Array(frameCount))
    : undefined;

  for (let frame = 0; frame < frameCount; frame += 1) {
    let mono = 0;
    for (let channel = 0; channel < format.channels; channel += 1) {
      const position = dataOffset + (frame * format.channels + channel) * bytesPerSample;
      let value;
      if (format.audioFormat === 1 && format.bitsPerSample === 16) {
        value = buffer.readInt16LE(position) / 32_768;
      } else if (format.audioFormat === 3 && format.bitsPerSample === 32) {
        value = buffer.readFloatLE(position);
      } else {
        throw new Error(
          `${path}: only PCM16 and Float32 WAV are supported (format=${format.audioFormat}, bits=${format.bitsPerSample})`,
        );
      }
      mono += value;
      if (channelSamples) channelSamples[channel][frame] = value;
    }
    samples[frame] = mono / format.channels;
  }
  return { ...format, samples, channelSamples, sourceFrameCount };
}

export async function writeMonoPcm16Wav(path, samples, sampleRate) {
  const frameCount = samples.length;
  const buffer = Buffer.alloc(44 + frameCount * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + frameCount * 2, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(frameCount * 2, 40);
  for (let index = 0; index < frameCount; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    buffer.writeInt16LE(Math.round(value < 0 ? value * 32_768 : value * 32_767), 44 + index * 2);
  }
  await writeFile(path, buffer);
}

export async function writeStereoPcm16Wav(path, left, right, sampleRate) {
  if (left.length !== right.length) {
    throw new RangeError('left and right channels must have the same length');
  }

  const frameCount = left.length;
  const channelCount = 2;
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataLength = frameCount * blockAlign;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataLength, 40);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const leftValue = Math.max(-1, Math.min(1, left[frame]));
    const rightValue = Math.max(-1, Math.min(1, right[frame]));
    const offset = 44 + frame * blockAlign;
    buffer.writeInt16LE(
      Math.round(leftValue < 0 ? leftValue * 32_768 : leftValue * 32_767),
      offset,
    );
    buffer.writeInt16LE(
      Math.round(rightValue < 0 ? rightValue * 32_768 : rightValue * 32_767),
      offset + bytesPerSample,
    );
  }
  await writeFile(path, buffer);
}
