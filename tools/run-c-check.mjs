import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows can use the same Emscripten toolchain as the instrument. Other
// platforms retain the independent native-C check. CC can select either.
export function runC(source) {
  const directory = mkdtempSync(path.join(tmpdir(), 'piano-c-check-'));
  try {
    const input = path.join(directory, 'check.c');
    const useWasm = !process.env.CC && process.platform === 'win32';
    const binary = path.join(directory, useWasm ? 'check.cjs' : process.platform === 'win32' ? 'check.exe' : 'check');
    writeFileSync(input, source);
    const compiler = process.env.CC ?? (useWasm ? 'emcc' : 'cc');
    const include = fileURLToPath(new URL('.', import.meta.url));
    execFileSync(compiler, ['-O2', '-std=c99', '-I', include, input, '-lm',
      ...(useWasm ? ['-sENVIRONMENT=node', '-sASSERTIONS=1'] : []), '-o', binary], { stdio: 'pipe' });
    return execFileSync(useWasm ? process.execPath : binary, useWasm ? [binary] : [], { encoding: 'utf8' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
