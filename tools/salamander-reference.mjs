import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const VELOCITY_RANGES = [
  [1, 26], [27, 34], [35, 36], [37, 43], [44, 46], [47, 50],
  [51, 56], [57, 64], [65, 72], [73, 80], [81, 88], [89, 96],
  [97, 104], [105, 112], [113, 120], [121, 127],
];

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

function definitions(text, prefix) {
  const values = new Map();
  for (const match of text.matchAll(new RegExp(`^#define \\$${prefix}(\\d+)\\s+(-?\\d+)`, 'gm'))) {
    values.set(Number(match[1]), Number(match[2]));
  }
  return values;
}

function expandUpstreamRegions(regionText, tuneText, extension) {
  const tunes = definitions(tuneText, 'TUNE');
  const lines = regionText.split(/\r?\n/).filter((line) => line.includes('<region>'));
  const expanded = [];
  for (let layer = 1; layer <= VELOCITY_RANGES.length; layer += 1) {
    const [velocityLow, velocityHigh] = VELOCITY_RANGES[layer - 1];
    for (const line of lines) {
      const label = Number(/region_label=(\d+)/.exec(line)?.[1]);
      expanded.push(line
        .replaceAll('$VEL', `v${layer}`)
        .replaceAll('$EXT', extension)
        .replace(/tune=\$TUNE\d+/, `tune=${tunes.get(label) ?? 0}`)
        .replace('<region>', `<region> lovel=${velocityLow} hivel=${velocityHigh}`));
    }
  }
  return expanded.join('\n');
}

export async function loadSalamanderReference(root) {
  const referenceRoot = path.join(root, 'SalamanderGrandPianoV3_44.1khz16bit');
  const upstreamSfz = path.join(referenceRoot, 'Salamander Grand Piano V3.sfz');
  if (await exists(upstreamSfz)) {
    const sampleRoot = path.join(referenceRoot, 'Samples');
    const regionPath = path.join(referenceRoot, 'Data', 'region.txt');
    const naturalTunePath = path.join(referenceRoot, 'Data', 'tune_nat.txt');
    const retunedTunePath = path.join(referenceRoot, 'Data', 'tune_ret.txt');
    const [regionText, naturalTuneText, retunedTuneText] = await Promise.all([
      readFile(regionPath, 'utf8'), readFile(naturalTunePath, 'utf8'), readFile(retunedTunePath, 'utf8'),
    ]);
    return {
      edition: '48 kHz / 24-bit FLAC', extension: 'flac', referenceRoot, sampleRoot,
      sfzPath: upstreamSfz, retunedSfzPath: retunedTunePath,
      sfzText: expandUpstreamRegions(regionText, naturalTuneText, 'flac'),
      retunedText: expandUpstreamRegions(regionText, retunedTuneText, 'flac'),
    };
  }
  const sampleRoot = path.join(referenceRoot, '44.1khz16bit');
  const sfzPath = path.join(referenceRoot, 'SalamanderGrandPianoV3.sfz');
  const retunedSfzPath = path.join(referenceRoot, 'SalamanderGrandPianoV3Retuned.sfz');
  if (!(await exists(sfzPath)) || !(await exists(retunedSfzPath))) {
    return {
      edition: 'unavailable', extension: 'wav', referenceRoot, sampleRoot,
      sfzPath, retunedSfzPath, sfzText: null, retunedText: null,
    };
  }
  return {
    edition: '44.1 kHz / 16-bit WAV', extension: 'wav', referenceRoot, sampleRoot,
    sfzPath, retunedSfzPath,
    sfzText: await readFile(sfzPath, 'utf8'),
    retunedText: await readFile(retunedSfzPath, 'utf8'),
  };
}
