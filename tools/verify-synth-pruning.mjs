import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { root, debugDirectory } from './build-synth-debug.mjs';
import { loadEngine, render, difference, scenarios } from './audit-synth-contributions.mjs';

const beforeFile=process.argv[2];
if(!beforeFile)throw new Error('Usage: node tools/verify-synth-pruning.mjs path/to/before-pruning.wasm');
const before=await loadEngine(beforeFile);
const runtime=readFileSync(path.join(root,'src/grand-piano.js'),'utf8');
const encoded=/const WASM_BYTES = Uint8Array\.from\(atob\('([^']+)'/.exec(runtime)?.[1];
if(!encoded)throw new Error('Missing embedded Wasm');
const afterBytes=Buffer.from(encoded,'base64');
writeFileSync(path.join(debugDirectory,'pruned-release.wasm'),afterBytes);
const after=await loadEngine(path.join(debugDirectory,'pruned-release.wasm'));
const all=scenarios(true);
for(let midi=21;midi<=108;midi++)for(const velocity of [.13,.57,1])all.push({name:`oracle-${midi}-${velocity}`,midi,velocity,seconds:.03});
for(const rate of [32000,44100,48000,96000])for(const midi of [21,30,31,48,49,60,84,90,91,105,108])all.push({name:`extended-${rate}-${midi}`,rate,seconds:8,events:[[0,'on',1,440*2**((midi-69)/12),.9],[3,'off',1,.1]]});
all.push({name:'30-second-held-bass',rate:44100,seconds:30,events:[[0,'on',1,27.5,1]]});
let changedSamples=0,samples=0,peak=0,worst=null,max20msRms=0;
const differences=[];
for(const scenario of all) {
  const a=render(before,scenario),b=render(after,scenario),d=difference(a,b,scenario.events?3:1,scenario.rate??44100);
  changedSamples+=d.changedSamples;samples+=a.length;max20msRms=Math.max(max20msRms,d.max20msRms);
  if(d.peak>peak){peak=d.peak;worst=scenario.name;}
  if(d.changedSamples)differences.push({scenario:scenario.name,...d});
}
// Far below the -100 dBFS screen; this tighter gate only permits rounding
// changes caused by eliminating an algebraically cancelling constant.
if(peak>1e-7)throw new Error(`Pruning exceeds rounding-only gate: ${peak} in ${worst}`);
const hash=data=>createHash('sha256').update(data).digest('hex');
const report={beforeWasmSha256:hash(readFileSync(beforeFile)),afterWasmSha256:hash(afterBytes),afterSourceSha256:hash(readFileSync(path.join(root,'tools/grand-piano-wasm.c'))),scenarios:all.length,samples,changedSamples,peak,peakDbFS:peak?20*Math.log10(peak):null,max20msRms,max20msDbFS:max20msRms?20*Math.log10(max20msRms):null,worst,differences};
writeFileSync(path.join(root,'reports/synth-pruning.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,differences:undefined},null,2));
