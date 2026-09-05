import { mkdir, readFile, writeFile, copyFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStandardMidi, renderMidiPerformance } from './midi-performance.mjs';
import { writeStereoPcm16Wav } from './audio-analysis.mjs';
import { LEMMINGS_CLASSICS } from './generate-lemmings-classics.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const out=path.join(root,'demos/dry');
const self=fileURLToPath(import.meta.url);
const small=['A1-soft','C4-medium','A6-hard','A6v16-procedural','C-major-chord','short-phrase'];
const jobs=[
 ...small.map(name=>({name,kind:'small'})),
 {name:'bach-bwv846-prelude-procedural',kind:'bach'},
 {name:'flight-of-the-bumblebee-procedural',kind:'bumblebee'},
 ...LEMMINGS_CLASSICS.map(track=>({name:track.output.replace(/\.wav$/,''),kind:'remote',track})),
 {name:'liszt-hungarian-rhapsody-no-2-procedural',midi:'scores/liszt-hungarian-rhapsody-no-2.mid'},
 ...[1,2,3].map(n=>({name:`moonlight${n}-procedural`,midi:`scores/moonlight-sonata/moonlight${n}.mid`})),
 ...['twinkle-starlight-variations','twinkle-in-canon'].map(name=>({name,midi:`demos/${name}.mid`})),
 ...['wheels-on-the-bus','row-row-row-your-boat','river-road-duet','codex-lanterns-at-midnight'].map(name=>({name,midi:`demos/${name}/${name}.mid`})),
];
function run(command,args){const p=spawnSync(command,args,{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});if(p.error||p.status!==0)throw Error(p.error?.message||p.stderr||p.stdout);return p;}
function measure(file){
 const p=run('ffmpeg',['-hide_banner','-nostats','-i',file,'-af','loudnorm=I=-18:TP=-2:LRA=20:print_format=json','-f','null',process.platform==='win32'?'NUL':'/dev/null']);
 const result=JSON.parse(p.stderr.slice(p.stderr.lastIndexOf('{'),p.stderr.lastIndexOf('}')+1));
 return {lufs:+result.input_i,truePeakDbTP:+result.input_tp,loudnessRangeLU:+result.input_lra,completeDecode:true};
}
async function master(name,raw,details){
 const source=measure(raw);
 // Uniform gain preserves every performed dynamic; peak headroom takes precedence.
 const gainDb=Math.min(-18-source.lufs,-2-source.truePeakDbTP);
 const wav=path.join(out,name+'.wav'),mp3=path.join(out,name+'.mp3');
 run('ffmpeg',['-v','error','-y','-i',raw,'-af',`volume=${gainDb.toFixed(4)}dB`,'-c:a','pcm_s24le',wav]);
 run('ffmpeg',['-v','error','-y','-i',wav,'-c:a','libmp3lame','-b:a','192k',mp3]);
 const wavCheck=measure(wav),mp3Check=measure(mp3);
 if(wavCheck.truePeakDbTP>-.5||mp3Check.truePeakDbTP>-.5)throw Error(`${name}: insufficient peak headroom`);
 const report={name,impulseResponse:false,addedReverb:false,...details,mastering:{method:'Constant gain; no compression or limiting',gainDb,source,wav:wavCheck,mp3:mp3Check}};
 await writeFile(path.join(out,name+'.json'),JSON.stringify(report,null,2)+'\n');
 await unlink(raw);
 console.log(`${name}: ${details.seconds?.toFixed(2)??''} seconds, ${wavCheck.lufs} LUFS, ${wavCheck.truePeakDbTP} dBTP`);
 return report;
}
async function render(job){
 const raw=path.join(out,job.name+'.render.wav'); let details={};
 if(job.kind==='small'){
   // These API demonstrations have always been dry; regenerate once as a group.
   const source=path.join(out,'single-note-sources',job.name+'.wav');
   await copyFile(source,raw);details={source:'generate-demos.mjs (no effects)'};
 }else if(job.kind==='bach'||job.kind==='bumblebee'){
   const module=await import(job.kind==='bach'?'./bwv846-performance.mjs':'./bumblebee-performance.mjs');
   const rendered=(module.renderBwv846Track??module.renderBumblebeeTrack)({proceduralRoom:false});
   await writeStereoPcm16Wav(raw,rendered.left,rendered.right,rendered.sampleRate);
   details={source:job.kind,seconds:rendered.left.length/rendered.sampleRate,proceduralRoom:false};
 }else{
   let bytes;
   if(job.kind==='remote'){
     const cached=path.join(out,'scores',job.name+'.mid');
     try{bytes=await readFile(cached);}catch(error){
       if(error.code!=='ENOENT')throw error;
       const response=await fetch(job.track.midiUrl);if(!response.ok)throw Error(`MIDI download HTTP ${response.status}`);
       bytes=Buffer.from(await response.arrayBuffer());await mkdir(path.dirname(cached),{recursive:true});await writeFile(cached,bytes);
     }
   }else bytes=await readFile(path.join(root,job.midi));
   const performance=parseStandardMidi(bytes);
   if(job.kind==='remote'){
     const scale=job.track.sourceBpm/job.track.tempoBpm;
     performance.controls.forEach(c=>c.seconds*=scale);performance.durationSeconds*=scale;
   }
   const rendered=renderMidiPerformance(performance,{maximumTailSeconds:60});
   if(rendered.truncatedVoices)throw Error(`${job.name}: ${rendered.truncatedVoices} truncated voices`);
   const left=rendered.mono;for(let i=0;i<left.length;i++)left[i]*=Math.SQRT1_2;
   await writeStereoPcm16Wav(raw,left,left,rendered.sampleRate);
   details={source:job.midi??job.track.midiUrl,notes:performance.noteCount,seconds:left.length/rendered.sampleRate,clippedSourceFrames:rendered.clippedFrames,truncatedVoices:rendered.truncatedVoices};
 }
 return master(job.name,raw,details);
}
await mkdir(out,{recursive:true});
if(process.argv[2]==='--job'){
 const job=jobs.find(j=>j.name===process.argv[3]);if(!job)throw Error('Unknown dry demo');await render(job);
}else{
 run(process.execPath,['tools/generate-demos.mjs',path.join(out,'single-note-sources')]);
 const reports=[];
 for(const job of jobs){
   console.log(`Rendering dry: ${job.name}`);
   const p=spawnSync(process.execPath,[self,'--job',job.name],{cwd:root,stdio:'inherit'});
   if(p.status!==0)throw Error(`Failed dry render: ${job.name}`);
   reports.push(JSON.parse(await readFile(path.join(out,job.name+'.json'),'utf8')));
 }
 const concat=path.join(out,'moonlight-concat.txt');
 await writeFile(concat,[1,2,3].map(n=>`file 'moonlight${n}-procedural.wav'`).join('\n')+'\n');
 const combined=path.join(out,'moonlight-sonata-procedural.render.wav');
 run('ffmpeg',['-v','error','-y','-f','concat','-safe','0','-i',concat,'-c:a','pcm_s24le',combined]);
 reports.push(await master('moonlight-sonata-procedural',combined,{source:'Concatenated dry movements 1, 2 and 3'}));
 await unlink(concat);
 await writeFile(path.join(out,'render-report.json'),JSON.stringify({impulseResponse:false,addedReverb:false,tracks:reports},null,2)+'\n');
 const attribution=await readFile(path.join(root,'demos/liszt-hungarian-rhapsody-no-2-ATTRIBUTION.md'),'utf8');
 await writeFile(path.join(out,'liszt-hungarian-rhapsody-no-2-ATTRIBUTION.md'),attribution+'\nDry edition: newly synthesized from the same MIDI, with no impulse response or added reverb. Constant-gain mastering only. The same CC BY-SA 3.0 DE license applies.\n');
 await writeFile(path.join(out,'README.md'),'# Dry piano demos\n\nAll 22 distinct demo performances, synthesized without impulse-response convolution or added room reverb. Natural modeled piano resonance and sustain remain. WAV and MP3 versions use constant-gain mastering toward -18 LUFS, constrained by -2 dB true-peak headroom. Existing wet files are preserved.\n\nRender/master intermediates and previous volume variants are represented by one dry version of each performance. The six short diagnostic demos also retain their original dry synthesis levels in `single-note-sources/`.\n\nRegenerate with `node tools/render-dry-demos.mjs`. Per-track verification is in `render-report.json`.\n\n'+reports.map(r=>`- [${r.name}](${r.name}.mp3) · [WAV](${r.name}.wav)`).join('\n')+'\n');
 console.log(`Completed ${reports.length} dry demo tracks in ${out}`);
}
