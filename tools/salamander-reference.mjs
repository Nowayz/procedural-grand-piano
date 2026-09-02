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

function expandUpstreamRegions(regionText, extension) {
  const lines = regionText.split(/\r?\n/).filter((line) => line.includes('<region>'));
  const expanded = [];
  for (let layer = 1; layer <= VELOCITY_RANGES.length; layer += 1) {
    const [velocityLow, velocityHigh] = VELOCITY_RANGES[layer - 1];
    for (const line of lines) {
      expanded.push(line
        .replaceAll('$VEL', `v${layer}`)
        .replaceAll('$EXT', extension)
        .replace(/\s*tune=\$TUNE\d+/, '')
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
    const regionText = await readFile(regionPath, 'utf8');
    return {
      edition: '48 kHz / 24-bit FLAC', extension: 'flac', referenceRoot, sampleRoot,
      sfzPath: upstreamSfz,
      sfzText: expandUpstreamRegions(regionText, 'flac'),
    };
  }
  const sampleRoot = path.join(referenceRoot, '44.1khz16bit');
  const sfzPath = path.join(referenceRoot, 'SalamanderGrandPianoV3.sfz');
  if (!(await exists(sfzPath))) {
    return {
      edition: 'unavailable', extension: 'wav', referenceRoot, sampleRoot,
      sfzPath, sfzText: null,
    };
  }
  return {
    edition: '44.1 kHz / 16-bit WAV', extension: 'wav', referenceRoot, sampleRoot,
    sfzPath,
    sfzText: await readFile(sfzPath, 'utf8'),
  };
}
