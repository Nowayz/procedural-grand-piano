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

try {
 execFileSync('emcc', [sourcePath, '-O3', '-msimd128', '-ffp-contract=fast', '-fno-math-errno', '-fno-trapping-math', '-s', 'STANDALONE_WASM=1', '--no-entry', '-s', 'EXPORTED_FUNCTIONS=["_synthesize","_output_ptr"]', '-s', 'INITIAL_MEMORY=33554432', '-s', 'ALLOW_MEMORY_GROWTH=0', '-o', unoptimizedPath], { stdio: 'inherit' });
 execFileSync('wasm-opt', ['-O4', '--enable-simd', '--enable-bulk-memory', '--enable-nontrapping-float-to-int', unoptimizedPath, '-o', optimizedPath], { stdio: 'inherit' });
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
