import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'tools', 'grand-piano-wasm.c');
const runtimePath = path.join(root, 'src', 'grand-piano.js');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'grand-piano-wasm-'));
const unoptimizedPath = path.join(temporaryDirectory, 'piano.wasm');
const optimizedPath = path.join(temporaryDirectory, 'piano-opt.wasm');
const check = process.argv.includes('--check');
const wasmOpt = process.env.EMSDK
 ? path.join(process.env.EMSDK, 'upstream', 'bin', process.platform === 'win32' ? 'wasm-opt.exe' : 'wasm-opt')
 : 'wasm-opt';
const compilerOptimization = process.env.PIANO_WASM_OPTIMIZATION ?? '-Oz';
if (!['-Oz', '-Os', '-O1', '-O2', '-O3'].includes(compilerOptimization)) throw new Error(`invalid Wasm compiler optimization ${compilerOptimization}`);
const experimentalDefinitions = JSON.parse(process.env.PIANO_WASM_DEFINES ?? '{}');
const definitionArguments = Object.entries(experimentalDefinitions).map(([name, value]) => {
 if (!/^PIANO_[A-Z0-9_]+$/.test(name) || typeof value !== 'number' || !Number.isFinite(value)) {
  throw new Error(`invalid experimental Wasm definition ${name}`);
 }
 return `-D${name}=${value}`;
});

try {
 execFileSync('emcc', [sourcePath, ...definitionArguments, compilerOptimization, '-msimd128', '-ffp-contract=fast', '-fno-math-errno', '-fno-trapping-math', '-s', 'STANDALONE_WASM=1', '--no-entry', '-s', 'EXPORTED_FUNCTIONS=["_synthesize","_output_ptr"]', '-s', 'INITIAL_MEMORY=33554432', '-s', 'ALLOW_MEMORY_GROWTH=0', '-o', unoptimizedPath], { stdio: 'inherit' });
 execFileSync(wasmOpt, ['-Oz', '--code-folding', '--merge-similar-functions', '--enable-simd', '--enable-bulk-memory', '--enable-nontrapping-float-to-int', unoptimizedPath, '-o', optimizedPath], { stdio: 'inherit' });
 const encoded = readFileSync(optimizedPath).toString('base64');
 const runtime = readFileSync(runtimePath, 'utf8');
 const expression = /(const WASM_BYTES = Uint8Array\.from\(atob\(')[^']*/;
 const match = expression.exec(runtime);
 const embedded = match?.[0].slice(match[1].length);
 if (check) { if (embedded !== encoded) throw new Error('embedded Wasm differs from tools/grand-piano-wasm.c'); console.log(`Full-model Wasm matches (${readFileSync(optimizedPath).length} bytes)`); }
 else { writeFileSync(runtimePath, runtime.replace(expression, `$1${encoded}`)); console.log(`embedded ${readFileSync(optimizedPath).length} bytes in ${runtimePath}`); }
} finally {
 rmSync(temporaryDirectory, { recursive: true, force: true });
}
