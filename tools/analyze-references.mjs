#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attackMetrics,
  estimateInharmonicity,
  onsetRmsTrajectory,
  partialDecay,
  partialPeaks,
  peakNear,
  readWav,
  signalStats,
  spectralPeakCluster,
  spectralCentroid,
  spectrum,
  transientFrameMetrics,
} from './audio-analysis.mjs';
import { loadSalamanderReference } from './salamander-reference.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reference = await loadSalamanderReference(root);
const { referenceRoot, sampleRoot, sfzPath, retunedSfzPath } = reference;
const outputPath = path.join(root, 'reports', 'reference-analysis.json');
const shouldWrite = process.argv.includes('--write-report');

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function median(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2
    ? finite[middle]
    : (finite[middle - 1] + finite[middle]) / 2;
}

function noteToMidi(note) {
  const match = /^([A-G])(#?)(-?\d+)$/.exec(note);
  if (!match) throw new Error(`Cannot parse note name: ${note}`);
  const semitones = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return (Number(match[3]) + 1) * 12 + semitones[match[1]] + (match[2] ? 1 : 0);
}

function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function parseNoteRegions(sfzText) {
  const regions = [];
  for (const line of sfzText.split(/\r?\n/)) {
    const fileMatch = /sample=[^\s]*[\\/]?([A-G](?:#)?-?\d+)v(\d+)\.(wav|flac)/i.exec(line);
    if (!fileMatch) continue;
    const attribute = (name, fallback) => {
      const match = new RegExp(`(?:^|\\s)${name}=(-?\\d+)`).exec(line);
      return match ? Number(match[1]) : fallback;
    };
    const note = fileMatch[1].replace(/^./, (letter) => letter.toUpperCase());
    regions.push({
      file: `${note}v${Number(fileMatch[2])}.${fileMatch[3].toLowerCase()}`,
      note,
      layer: Number(fileMatch[2]),
      midi: noteToMidi(note),
      velocityLow: attribute('lovel', 0),
      velocityHigh: attribute('hivel', 127),
      tuneCents: attribute('tune', 0),
    });
  }
  return regions;
}

function averageSpectra(spectra) {
  const first = spectra[0];
  const powers = new Float64Array(first.powers.length);
  for (const current of spectra) {
    for (let index = 0; index < powers.length; index += 1) {
      powers[index] += current.powers[index] / spectra.length;
    }
  }
  return { ...first, powers };
}

async function hashFile(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function analyzeNoteRegion(region, tuneCents) {
  const filePath = path.join(sampleRoot, region.file);
  const wav = await readWav(filePath, { preserveChannels: true });
  const expectedHz = midiToFrequency(region.midi);
  const attack = attackMetrics(wav.samples, wav.sampleRate);
  const start = Math.round((attack.onsetSeconds + 0.025) * wav.sampleRate);
  const length = Math.min(32_768, wav.samples.length - start);
  const channelSpectra = wav.channelSamples.map((channel) =>
    spectrum(channel, wav.sampleRate, { start, length, fftSize: 131_072 }));
  const spectralData = averageSpectra(channelSpectra);
  const fundamental = peakNear(spectralData, expectedHz * 0.955, expectedHz * 1.07);
  const peaks = partialPeaks(spectralData, fundamental.frequencyHz, 12);
  const strongestPartial = Math.max(...peaks.map((peak) => peak.power));
  const decayPartials = [1, 2, 4].filter((partial) => partial * expectedHz < 15_000);
  const decays = Object.fromEntries(
    decayPartials.map((partial) => {
      // One microphone channel avoids phase cancellation from the AB pair.
      const decay = partialDecay(
        wav.channelSamples[0],
        wav.sampleRate,
        fundamental.frequencyHz,
        partial,
        [0.1, 0.3, 0.65, 1.2, 2.0, 3.2].filter(
          (time) => time + 0.2 < wav.samples.length / wav.sampleRate,
        ),
      );
      return [
        partial,
        {
          slopeDbPerSecond: round(decay.slopeDbPerSecond, 3),
          t60Seconds: round(decay.t60Seconds, 3),
        },
      ];
    }),
  );

  return {
    file: region.file,
    note: region.note,
    midi: region.midi,
    expectedHz: round(expectedHz, 5),
    layer: region.layer,
    sfzVelocityRange: [region.velocityLow, region.velocityHigh],
    normalizedVelocityMidpoint: round(
      (region.velocityLow + region.velocityHigh) / (2 * 127),
      4,
    ),
    retunedSfzCents: tuneCents,
    format: {
      sampleRate: wav.sampleRate,
      channels: wav.channels,
      bitsPerSample: wav.bitsPerSample,
      durationSeconds: round(wav.samples.length / wav.sampleRate, 4),
    },
    waveform: {
      peak: round(signalStats(wav.samples).peak, 5),
      rms: round(signalStats(wav.samples).rms, 6),
      dc: round(signalStats(wav.samples).dc, 7),
      onsetSeconds: round(attack.onsetSeconds, 5),
      attackToPeakSeconds: round(attack.peakSeconds, 5),
    },
    spectrum: {
      analysisStartSeconds: round(start / wav.sampleRate, 5),
      windowSamples: length,
      fftSize: 131_072,
      centroidHz: round(spectralCentroid(spectralData, 20, 16_000), 2),
      rawFundamentalPeakHz: round(fundamental.frequencyHz, 4),
      estimatedAfterRetuneHz: round(fundamental.frequencyHz * 2 ** (tuneCents / 1_200), 4),
      inharmonicityB: round(estimateInharmonicity(peaks), 8),
      partials: peaks.map((peak) => ({
        number: peak.partial,
        frequencyHz: round(peak.frequencyHz, 3),
        relativeDb: round(10 * Math.log10(peak.power / strongestPartial), 2),
      })),
    },
    decay: decays,
  };
}

async function analyzeReleaseFile(file) {
  const wav = await readWav(path.join(sampleRoot, file), { preserveChannels: true });
  const attack = attackMetrics(wav.samples, wav.sampleRate);
  const start = Math.round(attack.onsetSeconds * wav.sampleRate);
  const length = Math.min(16_384, wav.samples.length - start);
  const spectralData = averageSpectra(
    wav.channelSamples.map((channel) =>
      spectrum(channel, wav.sampleRate, { start, length, fftSize: 32_768 })),
  );
  const stats = signalStats(wav.samples);
  return {
    file,
    durationSeconds: round(wav.samples.length / wav.sampleRate, 4),
    peak: round(stats.peak, 5),
    rms: round(stats.rms, 6),
    attackToPeakSeconds: round(attack.peakSeconds, 5),
    centroidHz: round(spectralCentroid(spectralData, 20, 16_000), 2),
  };
}

async function analyzeA6Focus(tuneCents) {
  const file = `A6v16.${reference.extension}`;
  const wav = await readWav(path.join(sampleRoot, file), { preserveChannels: true });
  const attack = attackMetrics(wav.samples, wav.sampleRate);
  const frames = transientFrameMetrics(
    wav.samples,
    wav.sampleRate,
    attack.onsetSeconds,
  );
  const maximumFrameRms = Math.max(...frames.map((frame) => frame.rms));
  const clusterStart = Math.round((attack.onsetSeconds + 0.08) * wav.sampleRate);
  const clusterLength = Math.min(
    Math.round(1.5 * wav.sampleRate),
    wav.samples.length - clusterStart,
  );
  const clusterSpectrum = averageSpectra(
    wav.channelSamples.map((channel) => spectrum(channel, wav.sampleRate, {
      start: clusterStart,
      length: clusterLength,
      fftSize: 262_144,
    })),
  );
  const rawCluster = spectralPeakCluster(clusterSpectrum, midiToFrequency(93), {
    relativeThresholdDb: -14,
    minimumSeparationHz: 0.65,
  });
  const retuneRatio = 2 ** (tuneCents / 1_200);

  return {
    file,
    sfzVelocityRange: [121, 127],
    normalizedVelocityMidpoint: round((121 + 127) / (2 * 127), 6),
    sfzTuneCents: tuneCents,
    causalAttack: {
      onsetSeconds: round(attack.onsetSeconds, 6),
      onsetToPeakSeconds: round(attack.peakSeconds, 6),
      peakEnvelope: round(attack.peakEnvelope, 6),
    },
    transientFrames: frames.map((frame) => ({
      windowMilliseconds: [frame.startMs, frame.endMs],
      rms: round(frame.rms, 6),
      rmsRelativeToStrongestFrameDb: round(
        20 * Math.log10(frame.rms / maximumFrameRms),
        3,
      ),
      crestFactor: round(frame.crestFactor, 3),
      centroidHz: round(frame.centroidHz, 2),
      bandRelativeDb: Object.fromEntries(
        Object.entries(frame.bandRelativeDb).map(([name, value]) => [name, round(value, 3)]),
      ),
    })),
    rmsTrajectory: onsetRmsTrajectory(
      wav.samples,
      wav.sampleRate,
      attack.onsetSeconds,
    ).map((point) => ({
      startSeconds: point.startSeconds,
      windowSeconds: 0.05,
      relativeDb: round(point.relativeDb, 3),
    })),
    unisonCluster: {
      analysisStartSeconds: round(clusterStart / wav.sampleRate, 6),
      analysisWindowSeconds: round(clusterLength / wav.sampleRate, 6),
      fftSize: 262_144,
      rawSpanHz: round(rawCluster.spanHz, 4),
      retunedSpanHz: round(rawCluster.spanHz * retuneRatio, 4),
      peaks: rawCluster.peaks.map((peak) => ({
        rawFrequencyHz: round(peak.frequencyHz, 4),
        sfzRetunedFrequencyHz: round(peak.frequencyHz * retuneRatio, 4),
        relativeDb: round(peak.relativeDb, 3),
      })),
    },
  };
}

function buildTargets(noteAnalyses, a6Focus) {
  const byNote = new Map();
  for (const analysis of noteAnalyses) {
    if (!byNote.has(analysis.note)) byNote.set(analysis.note, []);
    byNote.get(analysis.note).push(analysis);
  }

  const registers = {};
  for (const [note, analyses] of byNote) {
    analyses.sort((a, b) => a.layer - b.layer);
    const soft = analyses[0];
    const hard = analyses.at(-1);
    registers[note] = {
      softLayer: soft.layer,
      hardLayer: hard.layer,
      attackToPeakRangeSeconds: [
        round(Math.min(...analyses.map((item) => item.waveform.attackToPeakSeconds)), 4),
        round(Math.max(...analyses.map((item) => item.waveform.attackToPeakSeconds)), 4),
      ],
      softCentroidHz: soft.spectrum.centroidHz,
      hardCentroidHz: hard.spectrum.centroidHz,
      brightnessRatio: round(hard.spectrum.centroidHz / soft.spectrum.centroidHz, 3),
      peakVelocityRatio: round(hard.waveform.peak / soft.waveform.peak, 3),
      medianInharmonicityB: round(
        median(analyses.map((item) => item.spectrum.inharmonicityB)),
        8,
      ),
      medianFundamentalT60Seconds: round(
        median(analyses.map((item) => item.decay[1]?.t60Seconds)),
        3,
      ),
    };
  }
  return {
    globalAttackToPeakMedianSeconds: round(
      median(noteAnalyses.map((item) => item.waveform.attackToPeakSeconds)),
      4,
    ),
    allHarderLayersAreBrighter: Object.values(registers).every(
      (target) => target.brightnessRatio > 1,
    ),
    focusA6v16: a6Focus,
    registers,
  };
}

async function main() {
  try {
    await access(sfzPath);
  } catch {
    console.log(`SKIP reference analysis: ${path.relative(root, sfzPath)} is absent`);
    return;
  }

  const { sfzText, retunedText } = reference;
  const regions = parseNoteRegions(sfzText);
  const retunedRegions = parseNoteRegions(retunedText);
  const retuneByFile = new Map(retunedRegions.map((region) => [region.file, region.tuneCents]));
  const selectedNotes = new Set(['A0', 'A2', 'C4', 'A4', 'A6']);
  const selectedLayers = new Set([4, 8, 12, 16]);
  const selected = regions.filter(
    (region) => selectedNotes.has(region.note) && selectedLayers.has(region.layer),
  );

  const noteAnalyses = [];
  for (const region of selected) {
    process.stdout.write(`reference ${region.file.padEnd(10)} `);
    const analysis = await analyzeNoteRegion(region, retuneByFile.get(region.file) ?? 0);
    noteAnalyses.push(analysis);
    console.log(
      `attack=${(analysis.waveform.attackToPeakSeconds * 1_000).toFixed(1)}ms ` +
      `centroid=${analysis.spectrum.centroidHz.toFixed(0)}Hz ` +
      `T60=${analysis.decay[1]?.t60Seconds ?? 'n/a'}s`,
    );
  }

  const releaseFiles = [
    `rel1.${reference.extension}`,
    `rel40.${reference.extension}`,
    `rel73.${reference.extension}`,
    `harmSA2.${reference.extension}`,
    `harmLA2.${reference.extension}`,
    `harmV3A2.${reference.extension}`,
  ];
  const releaseAnalyses = [];
  for (const file of releaseFiles) {
    releaseAnalyses.push(await analyzeReleaseFile(file));
  }
  const a6FocusFile = `A6v16.${reference.extension}`;
  const a6Focus = await analyzeA6Focus(retuneByFile.get(a6FocusFile) ?? 0);

  const report = {
    schemaVersion: 2,
    source: {
      suppliedDirectory: path.relative(root, referenceRoot),
      title: `Salamander Grand Piano V3 (${reference.edition} edition)`,
      instrument: 'Yamaha C5 grand piano',
      author: 'Alexander Holm',
      license: 'Creative Commons Attribution 3.0 Unported (CC BY 3.0)',
      sourcePage: 'https://sfzinstruments.github.io/pianos/salamander/',
      licensePage: 'https://creativecommons.org/licenses/by/3.0/',
      recordingContext:
        `Two AKG C414 microphones in AB position about 12 cm above the strings; analyzed edition is ${reference.edition}.`,
      localSfzHeader:
        `The analyzed mapping is the ${reference.edition} Salamander Grand Piano V3 distribution from the canonical submodule.`,
      sfzSha256: await hashFile(sfzPath),
      mapping: {
        parsedSustainRegions: regions.length,
        sampledPitchSpacing: 'minor thirds from A0 through C8',
        velocityLayers: 16,
        sustainGroup: '16 mapped velocity layers with per-note offsets and dedicated undamped high-note release settings',
        additionalLayers:
          'chromatic release noises, three string-resonance release strengths, and two pedal-down/two pedal-up recordings',
      },
      redistribution:
        'Reference audio stays in the external submodule; only scalar measurements are retained in reports.',
    },
    preprocessing: {
      waveform:
        'Decode the native reference format without resampling; normalize signed PCM by its bit depth; arithmetic stereo mid is used for waveform peak/RMS/onset.',
      spectral:
        'Analyze L/R separately with a Hann window, average power spectra to avoid AB-microphone phase cancellation, and ignore energy above 16 kHz for centroid.',
      onset:
        'Causal 3 ms sliding RMS (no future samples at the buffer boundary); first crossing at 4% of the first-250-ms maximum; spectral window begins 25 ms after that crossing.',
      pitch:
        'Find a local spectral maximum near equal-tempered pitch. Raw and SFZ-retuned estimates are both reported; PCM is not pitch shifted.',
      decay:
        'Fit dB/second to Hann-windowed partial peaks on microphone channel 1 at fixed post-onset times; T60=-60/slope. This is a proxy and is sensitive to beating/noise floors.',
      focusedTransient:
        'A6v16 uses onset-aligned 0-5/5-10/10-20/20-40/40-80 ms frames on the arithmetic stereo mid, a fixed 50 ms RMS trajectory, and a 1.5 s L/R power-averaged FFT for the unison cluster.',
    },
    selectedSustainRecordings: noteAnalyses,
    selectedReleaseRecordings: releaseAnalyses,
    focusedA6v16: a6Focus,
    derivedTargets: buildTargets(noteAnalyses, a6Focus),
  };

  if (shouldWrite) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${path.relative(root, outputPath)}`);
  } else {
    console.log(JSON.stringify(report.derivedTargets, null, 2));
  }
}

await main();
