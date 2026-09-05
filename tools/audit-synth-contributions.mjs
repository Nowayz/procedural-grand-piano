import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildDebug, debugDirectory, root } from './build-synth-debug.mjs';

const hz = midi => 440 * 2 ** ((midi-69)/12);
export async function loadEngine(file) {
  return (await WebAssembly.instantiate(readFileSync(file), {wasi_snapshot_preview1:{proc_exit:code=>{throw new Error(`Wasm exit ${code}`);}}})).instance.exports;
}
export function render(engine, scenario) {
  const rate=scenario.rate??44100;
  engine.rt_reset(rate,32);
  if (!scenario.events) {
    const n=engine.synthesize(hz(scenario.midi),scenario.velocity,scenario.seconds);
    return new Float32Array(engine.memory.buffer,engine.output_ptr(),n).slice();
  }
  const n=Math.round(scenario.seconds*rate), output=new Float32Array(n*3);
  for (const [time,type,...args] of scenario.events) {
    const offset=Math.round(time*rate);
    const result=type==='on'?engine.rt_note_on(...args,offset):type==='off'?engine.rt_note_off(...args,offset):type==='sustain'?engine.rt_sustain(...args,offset):type==='soft'?engine.rt_una_corda(...args,offset):engine.rt_key_position(...args,offset);
    if(result) throw new Error(`Event failed: ${result}`);
  }
  for(let start=0;start<n;start+=128) {
    const count=Math.min(128,n-start);engine.rt_process(count);
    for(const [channel,ptr] of [engine.rt_output_ptr(),engine.rt_output_left_ptr(),engine.rt_output_right_ptr()].entries()) {
      const block=new Float32Array(engine.memory.buffer,ptr,count);
      for(let i=0;i<count;i++) output[3*(start+i)+channel]=block[i];
    }
  }
  return output;
}
export function difference(a,b,channels=1,rate=44100) {
  if(a.length!==b.length) throw new Error('Length mismatch');
  let peak=0, energy=0, reference=0, changed=0, windowEnergy=0, maxWindow=0, windowFrames=Math.round(.02*rate), frames=0;
  for(let i=0;i<a.length;i+=channels) {
    let frameEnergy=0;
    for(let c=0;c<channels;c++) {
      const x=a[i+c], y=b[i+c];
      if(!Number.isFinite(x)||!Number.isFinite(y)) throw new Error('Nonfinite final audio');
      const d=x-y;peak=Math.max(peak,Math.abs(d));energy+=d*d;reference+=x*x;frameEnergy=Math.max(frameEnergy,d*d);if(d!==0)changed++;
    }
    windowEnergy+=frameEnergy;frames++;
    if(frames===windowFrames){maxWindow=Math.max(maxWindow,windowEnergy/frames);windowEnergy=0;frames=0;}
  }
  if(frames)maxWindow=Math.max(maxWindow,windowEnergy/frames);
  return {peak,rms:Math.sqrt(energy/a.length),relativeRms:reference?Math.sqrt(energy/reference):null,max20msRms:Math.sqrt(maxWindow),changedSamples:changed};
}
const db=x=>x>0?20*Math.log10(x):null;
function describe(d){return {...d,peakDbFS:db(d.peak),rmsDbFS:db(d.rms),relativeDb:db(d.relativeRms),max20msDbFS:db(d.max20msRms)};}
function wav(file,pcm,rate,channels=1) {
  const buffer=Buffer.alloc(44+pcm.length*4);
  buffer.write('RIFF');buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(3,20);buffer.writeUInt16LE(channels,22);buffer.writeUInt32LE(rate,24);buffer.writeUInt32LE(rate*channels*4,28);buffer.writeUInt16LE(channels*4,32);buffer.writeUInt16LE(32,34);buffer.write('data',36);buffer.writeUInt32LE(pcm.length*4,40);
  for(let i=0;i<pcm.length;i++)buffer.writeFloatLE(pcm[i],44+i*4);
  writeFileSync(file,buffer);
}
export function scenarios(full=false) {
  const cases=[];
  for(const midi of [60,84,105,21,45,72,93,108,30,31,48,49,90,91])for(const velocity of [.5,1,.125])cases.push({name:`key-${midi}-v${velocity}`,midi,velocity,seconds:1});
  const events=[[0,'sustain',1],[.2,'soft',1],[.4,'on',1,hz(48),.8],[.45,'on',2,hz(67),.6],[.6,'off',1,.2],[.7,'on',3,hz(48),.3],[.8,'soft',0],[1,'sustain',.5],[1.2,'off',2,1],[1.3,'key',3,.4,.3],[1.5,'sustain',1],[1.6,'off',3,.8],[2,'sustain',0]];
  cases.unshift({name:'pedal-restrike-chord',rate:44100,seconds:4,events});
  cases.push({name:'long-free-decay',rate:44100,seconds:12,events:[[0,'on',1,hz(45),.8],[0,'on',2,hz(81),.15]]});
  for(const rate of [32000,48000,96000])cases.push({name:`pedals-rate-${rate}`,rate,seconds:3,events});
  cases.push({name:'dense-chord',seconds:3,events:[...Array.from({length:8},(_,i)=>[0,'on',i,hz(36+i*7),.9]),...Array.from({length:8},(_,i)=>[1,'off',i,.5])]});
  if(full)for(let midi=21;midi<=108;midi++)for(const velocity of [1/127,.125,.5,1])cases.push({name:`sweep-${midi}-v${velocity}`,midi,velocity,seconds:1.5});
  return cases;
}

async function main() {
  const manifest=process.argv.includes('--reuse-build')?JSON.parse(readFileSync(path.join(debugDirectory,'manifest.json'))):buildDebug();
  for(const [file,hash] of Object.entries(manifest.hashes))if(createHash('sha256').update(readFileSync(path.join(root,'tools',file),'utf8')).digest('hex')!==hash)throw new Error(`Stale debug copy: ${file}`);
  const debug=await loadEngine(path.join(debugDirectory,'debug.wasm')), baseline=await loadEngine(path.join(debugDirectory,'baseline.wasm'));
  const reportDirectory=path.join(root,'reports','synth-contributions');mkdirSync(reportDirectory,{recursive:true});
  const quick=process.argv.includes('--quick'), all=scenarios(!quick), cache=new Map();
  let parityPeak=0,parityChanged=0;
  const logs=[];
  // Exact parity is required. A differing debug engine cannot authorize pruning.
  for(const scenario of all) {
    debug.debug_clear();debug.debug_logging(0);
    const original=render(baseline,scenario), observed=render(debug,scenario), d=difference(original,observed,scenario.events?3:1,scenario.rate??44100);
    parityPeak=Math.max(parityPeak,d.peak);parityChanged+=d.changedSamples;
    if(d.peak!==0)throw new Error(`Instrumentation changes PCM in ${scenario.name}: ${d.peak}`);
    cache.set(scenario.name,observed);
  }
  console.log(`Debug parity: ${all.length} scenarios, ${parityChanged} changed samples`);
  for(const scenario of all.slice(0,7)) {
    debug.debug_logging(1);
    const logged=render(debug,scenario);
    if(difference(cache.get(scenario.name),logged,scenario.events?3:1,scenario.rate??44100).peak!==0)throw new Error(`Logging changes PCM in ${scenario.name}`);
    const stats=new Float64Array(debug.memory.buffer,debug.debug_stats_ptr(),manifest.probes.length*7);
    for(const p of manifest.probes) {
      const [count,min,max,sumSquares,last,sum,nonfinite]=stats.slice(p.id*7,p.id*7+7);
      logs.push({scenario:scenario.name,id:p.id,name:p.name,count,min,max,rms:count?Math.sqrt(sumSquares/count):0,last,mean:count?sum/count:0,nonfinite});
      if(nonfinite)throw new Error(`Nonfinite internal value ${p.name}`);
    }
  }
  debug.debug_logging(0);
  writeFileSync(path.join(reportDirectory,'trace.jsonl'),logs.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const results=[];
  for(const p of manifest.probes.filter(p=>p.neutral!==null)) {
    debug.debug_clear();debug.debug_disable(p.id);
    let worst={peak:0},witness=null,tested=0,nonfinite=null;
    for(const scenario of all) {
      let d;
      try{d=difference(cache.get(scenario.name),render(debug,scenario),scenario.events?3:1,scenario.rate??44100);}catch(error){nonfinite=error.message;break;}
      tested++;
      if(d.peak>worst.peak){worst=d;witness=scenario.name;}
      // A clear counterexample is enough to RETAIN a component. Only quiet
      // candidates need the entire chromatic, velocity, rate and event sweep.
      if(d.peak>=1e-5)break;
    }
    const hits=debug.debug_hits(p.id);
    const status=nonfinite?'invalid-ablation':!hits?'not-exercised':worst.peak>=1e-5?'contributes':worst.peak===0?'no-output-difference':'below-conservative-threshold';
    const row={...p,status,tested,hits,witness,difference:describe(worst),nonfinite};results.push(row);
    console.log(`${p.id} ${p.name}: ${status} (${db(worst.peak)?.toFixed(1)??'-inf'} dBFS; ${tested} cases)`);
    if(witness && (status!=='contributes'||['filter_duplex_modes.return','step_voice.thump','piano_unison_share.return'].includes(p.name))) {
      const scenario=all.find(s=>s.name===witness),a=cache.get(witness),b=render(debug,scenario), channels=scenario.events?3:1;
      // Realtime comparison files use the actual left and right outputs.
      const stereo=pcm=>channels===3?Float32Array.from({length:pcm.length/3*2},(_,i)=>pcm[Math.floor(i/2)*3+1+i%2]):pcm;
      wav(path.join(reportDirectory,`${p.id}-baseline.wav`),stereo(a),scenario.rate??44100,channels===3?2:1);
      wav(path.join(reportDirectory,`${p.id}-disabled.wav`),stereo(b),scenario.rate??44100,channels===3?2:1);
      wav(path.join(reportDirectory,`${p.id}-difference.wav`),stereo(a.map((v,i)=>v-b[i])),scenario.rate??44100,channels===3?2:1);
    }
  }
  // Publish once after completion, avoiding partial reports and repeated file
  // opens that can race Windows file watchers. Progress is already on stdout.
  writeFileSync(path.join(reportDirectory,'audit.json'),JSON.stringify({sourceHashes:manifest.hashes,quick,scenarioCount:all.length,probeCount:manifest.probes.length,parity:{peak:parityPeak,changedSamples:parityChanged},policy:'Retain on any peak difference >= -100 dBFS. Smaller differences require source dependency review; this is not a perceptual masking or listening test. Early exit is only used to retain.',scenarios:all,results},null,2)+'\n');
  writeFileSync(path.join(reportDirectory,'summary.md'),`# Synth contribution audit\n\n${manifest.probes.length} logging probes; ${results.length} ablations; ${all.length} scenarios. Instrumentation parity: ${parityChanged} changed PCM samples.\n\nA contribution is a causal difference at the final mono or stereo output, measured without normalization. A witness above -100 dBFS retains the component immediately. Quiet candidates run every case. This conservative numerical screen does not establish human audibility or masking. No component is automatically removed.\n\n| Component | Result | Peak difference dBFS | Cases | Witness |\n|---|---|---:|---:|---|\n`+results.map(r=>`| ${r.name} (#${r.id}) | ${r.status} | ${r.difference.peakDbFS?.toFixed(2)??'-infinity'} | ${r.tested} | ${r.witness??''} |`).join('\n')+'\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
