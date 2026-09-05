import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instrument, debugHeader, zeroTerms } from './synth-debug-instrumentation.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const debugDirectory = path.join(root, 'build', 'synth-debug');
export function compile(source, output) {
  const args = [source, '-Oz', '-g', '-msimd128', '-ffp-contract=fast', '-fno-math-errno', '-fno-trapping-math', '-sSTANDALONE_WASM=1', '--no-entry', '-sINITIAL_MEMORY=33554432', '-sALLOW_MEMORY_GROWTH=0', '-o', output];
  // Calling emcc.py avoids cmd.exe quoting and .bat invocation on Windows.
  if (process.env.EMSDK) execFileSync(process.env.PYTHON ?? 'python', [path.join(process.env.EMSDK, 'upstream/emscripten/emcc.py'), ...args], {stdio:'inherit'});
  else execFileSync('emcc', args, {stdio:'inherit'});
}

export function buildDebug() {
  mkdirSync(debugDirectory, { recursive: true });
  const probes = [], hashes = {};
  const calibration=readFileSync(path.join(root,'tools/high-resolution-radiation-fit.h'),'utf8');
  const spectralTerms=Number(/#define HIGHRES_SPECTRAL_TERMS (\d+)/.exec(calibration)?.[1]);
  const rank=Number(/#define HIGHRES_RANK (\d+)/.exec(calibration)?.[1]);
  if(!spectralTerms||!rank)throw new Error('Missing radiation fit dimensions');
  for (const name of ['thump','mechanical_impact','lingering_felt','lingering_presence','early_presence','lingering_air','felt','felt_contact','air_contact']) zeroTerms.add(name);
  for (const file of ['grand-piano-wasm.c','piano-mechanics.h','continuous-piano-curves.h','high-resolution-radiation-fit.h']) {
    let source = readFileSync(path.join(root,'tools',file),'utf8');
    hashes[file] = createHash('sha256').update(source).digest('hex');
    function bank(name,count,expression) {
      const base=probes.length;
      for(let i=0;i<count;i++)probes.push({id:base+i,name:`${name}[${i}]`,file,expression,neutral:0,kind:'coefficient'});
      return base;
    }
    if(file.endsWith('.c')) {
      // Test every fitted coefficient independently, preserving postincrement
      // evaluation exactly once when the original expression uses coefficient++.
      source=source.replace(/static double (\w+)\([^{}]*\) \{([\s\S]*?)\n\}/g,(whole,name,body)=>{
        const fit=/static const double fit\[(\d+)\](?:\[(\d+)\])?\s*=\s*\{[\s\S]*?\};/.exec(body);
        if(!fit)return whole;
        const width=Number(fit[2]??fit[1]),count=Number(fit[1])*(fit[2]?width:1),base=bank(`${name}.fit`,count,'Fitted basis coefficient; set to zero before evaluation');
        const start=fit.index+fit[0].length;
        const rest=body.slice(start).replace(/fit\[([^\]]+)\](?:\[([^\]]+)\])?/g,(_,a,b)=>`piano_debug_coefficient(${base}, ${b?`(${a}) * ${width} + (${b})`:a}, (const double *)fit)`);
        return whole.replace(body,body.slice(0,start)+rest);
      });
      const spectral=bank('highres.spectral',spectralTerms,'Reconstructed Chebyshev coefficient; zero before anchor subtraction');
      source=source.replace('target->highres_coefficients[degree] = value;',`target->highres_coefficients[degree] = piano_debug_tap(${spectral} + degree, value);`);
      const latent=bank('highres.latent',rank,'Spatial latent component; zero before spectral reconstruction');
      source=source.replace('latent[component] = value;',`latent[component] = piano_debug_tap(${latent} + component, value);`);
      const stages=[['damper','couple_unison_modes(target);','damper',0],['strings','couple_unison_modes(target);','strings',0],['hammer','couple_unison_modes(target);','hammer',0],['diffuse','couple_unison_modes(target);','diffuse_body',0],['radiation-input','if (PIANO_RADIATION_LOSS_SCALE != 0) { v128_t','sample',null],['equalizer-input','if (PIANO_OUTPUT_EQ_ENABLED) { v128_t','sample',null],['saturation-input','sample = .94 * saturate(1.12 * sample);','sample',null]];
      for(const [name,anchor,variable,neutral] of stages){
        if(!source.includes(anchor))throw new Error(`Missing stage ${name}`);
        const id=probes.length;probes.push({id,name:`stage.${name}`,file,expression:variable,neutral,kind:'stage'});
        source=source.replace(anchor,`${variable} = piano_debug_tap(${id}, ${variable}); ${anchor}`);
      }
      // This term is identically zero in the original bandpass numerator.
      const zero='wasm_f64x2_mul(wasm_v128_load(soundboard_filters[1] + index), x1)';
      if(source.includes(zero)){
        const id=bank('soundboard.zero-b1',1,zero);
        source=source.replace(zero,`piano_debug_pair(${id}, ${zero})`);
      }
    }
    // Expose the existing fit controls independently, including individual
    // radiation polynomial coefficients. Bounds/corners are structural inputs.
    source = source.replace(/^#define (PIANO_\w+) ([^\r\n]+)$/gm, (whole,name,value) => {
      if (!/(?:GAIN|SCALE|_DB|PIANO_RADIATION_\d|PIANO_STRING_MIX)/.test(name) || !Number.isFinite(Number(value))) return whole;
      const id=probes.length;
      probes.push({id,name:`control.${name}`,file,expression:value,neutral:0,kind:'control'});
      return `#define ${name} piano_debug_tap(${id}, (${value}))`;
    });
    source=instrument(source,file,probes);
    if (file.endsWith('.c')) source='#include "piano-debug.h"\n'+source;
    writeFileSync(path.join(debugDirectory,file), source);
  }
  writeFileSync(path.join(debugDirectory,'piano-debug.h'),debugHeader(probes).replace('#endif',`#include <wasm_simd128.h>\nstatic double piano_debug_coefficient(int base, int index, const double *values) { return piano_debug_tap(base + index, values[index]); }\nstatic v128_t piano_debug_pair(int id, v128_t value) { double lanes[2]; wasm_v128_store(lanes, value); return wasm_f64x2_make(piano_debug_tap(id, lanes[0]), piano_debug_tap(id, lanes[1])); }\n#endif`));
  const manifest={version:1,hashes,probes};
  writeFileSync(path.join(debugDirectory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  compile(path.join(root,'tools/grand-piano-wasm.c'),path.join(debugDirectory,'baseline.wasm'));
  compile(path.join(debugDirectory,'grand-piano-wasm.c'),path.join(debugDirectory,'debug.wasm'));
  console.log(`Built ${probes.length} probes, ${probes.filter(p=>p.neutral!==null).length} ablations in ${debugDirectory}`);
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildDebug();
