import { writeFile, mkdir } from 'node:fs/promises';
import { parseStandardMidi, renderMidiPerformance } from './midi-performance.mjs';
import { readWav, writeStereoPcm16Wav } from './audio-analysis.mjs';
import { applyConvolverReverb } from './convolution-reverb.mjs';
import { DEFAULT_REVERB_IR_URL, DEFAULT_REVERB_WET, DEFAULT_REVERB_NAME } from '../src/reverb.js';
const out=new URL('../demos/row-row-row-your-boat/',import.meta.url);await mkdir(out,{recursive:true});
const events=[],ppq=480;let seq=0;
const event=(b,data)=>events.push({tick:Math.round(b*ppq),data,seq:seq++});
const meta=(b,t,d)=>event(b,[255,t,d.length,...d]);
const label=(b,s)=>meta(b,6,[...Buffer.from(s)]);
const tempo=(b,bpm)=>{let n=Math.round(60000000/bpm);meta(b,81,[n>>16,(n>>8)&255,n&255]);};
meta(0,3,[...Buffer.from('Row, Row, Row Your Boat - Riverlight')]);meta(0,88,[6,3,24,8]);meta(0,89,[2,0]);tempo(0,104);event(0,[192,0]);
function note(b,n,d,v=65,ch=0){const t=Math.max(0,b+.004*Math.sin(seq*1.73));event(t,[144+ch,n,v]);event(t+d,[128+ch,n,50]);}
const chord=(b,ns,d,v)=>ns.forEach((n,i)=>note(b+i*.012,n,d,v-i));
const D=[50,57,62,66],G=[43,55,59,62],A=[45,57,61,64],Bm=[47,54,59,62];
const tune=[[[62,1.5],[62,1.5]],[[62,1],[64,.5],[66,1.5]],[[66,1],[64,.5],[66,1],[67,.5]],[[69,3]],[[74,.5],[74,.5],[74,.5],[69,.5],[69,.5],[69,.5]],[[66,.5],[66,.5],[66,.5],[62,.5],[62,.5],[62,.5]],[[69,1],[67,.5],[66,1],[64,.5]],[[62,3]]];
function melody(start,oct=0,vel=78,ch=0){tune.forEach((bar,j)=>{let p=0;for(const [n,d] of bar){note(start+j*3+p,n+oct,d*.9,vel+(p===0?3:0)-j%3,ch);p+=d;}});}
function water(b,h,v=48){note(b,h[0],2.65,v+8);for(let i=0;i<6;i++)note(b+i*.5,h[1+i%3],.64,v+(i===0?3:0));event(b+.1,[176,64,72]);event(b+2.88,[176,64,0]);}
label(0,'First ripples');for(let j=0;j<4;j++){water(j*3,[D,Bm,G,A][j],44);note(j*3+1.5,[78,76,74,73][j],1.1,58);}
label(12,'A boat on still water');melody(12);for(let j=0;j<8;j++)water(12+j*3,[D,D,G,A,D,Bm,A,D][j]);
// A real four-bar round: the second voice follows at the octave below.
label(36,'Two boats - four-bar round');melody(36,12,75,0);melody(48,0,69,1);
for(let j=0;j<12;j++){const b=36+j*3;note(b,j%4===3?45:38,2.7,48);note(b+1.5,57,.9,44);if(j>=8){note(b+.75,[78,76,74,73][j-8],.55,55);note(b+2.25,[76,74,73,69][j-8],.55,51);}}
label(72,'Sun on the river');melody(72,0,82);for(let j=0;j<8;j++){water(72+j*3,[D,Bm,G,A,D,G,A,D][j],51);if(j<4)note(72+j*3+1.5,[78,78,79,76][j],1.2,54);}
label(96,'Drifting home');tempo(96,98);tempo(99,90);tempo(102,80);tempo(105,64);
for(let j=0;j<3;j++){water(96+j*3,[G,A,D][j],43-j*3);note(96+j*3,[69,64,62][j],2.5,69-j*5);}
event(105,[176,64,85]);chord(105,[38,50,57,62,66,74],3.8,57);event(109.2,[176,64,0]);meta(110,47,[]);
events.sort((a,b)=>a.tick-b.tick||a.seq-b.seq);function vlq(n){const a=[n&127];while(n>>=7)a.unshift((n&127)|128);return a;}
let prev=0;const bytes=[];for(const e of events){bytes.push(...vlq(e.tick-prev),...e.data);prev=e.tick;}
const hdr=Buffer.from([77,84,104,100,0,0,0,6,0,0,0,1,1,224]),trk=Buffer.alloc(8);trk.write('MTrk');trk.writeUInt32BE(bytes.length,4);
const midi=Buffer.concat([hdr,trk,Buffer.from(bytes)]);await writeFile(new URL('row-row-row-your-boat.mid',out),midi);
const score=parseStandardMidi(midi);const active=new Set();for(const c of score.controls){if(c.type==='noteOn')active.add(c.id);if(c.type==='noteOff')active.delete(c.id);}if(active.size)throw Error('Unmatched notes');
console.log(`Composed ${score.noteCount} notes; rendering Riverlight.`);
const rendered=renderMidiPerformance(score);if(rendered.clippedFrames||rendered.truncatedVoices)throw Error('Clipped or truncated voices');
// Preserve a full extra reverb tail beyond the synthesizer release.
const ir=await readWav(DEFAULT_REVERB_IR_URL,{preserveChannels:true});const left=new Float32Array(rendered.mono.length+ir.channelSamples[0].length);for(let i=0;i<rendered.mono.length;i++)left[i]=rendered.mono[i]*Math.SQRT1_2;const right=left.slice();applyConvolverReverb(left,right,ir.channelSamples[0],ir.channelSamples[1],{wet:DEFAULT_REVERB_WET,sampleRate:rendered.sampleRate});
await writeStereoPcm16Wav(new URL('row-row-row-your-boat-render.wav',out),left,right,rendered.sampleRate);
const report={title:'Row, Row, Row Your Boat - Riverlight',key:'D major',meter:'6/8',structure:'4-bar introduction, 8-bar theme, 12-bar four-bar round, 8-bar reprise, ritardando coda',notes:score.noteCount,unmatchedNotes:active.size,midiFormat:score.format,ppq:score.ticksPerQuarter,durationSeconds:left.length/rendered.sampleRate,maximumVoices:rendered.maximumVoices,sourceClippedFrames:rendered.clippedFrames,truncatedVoices:rendered.truncatedVoices,reverb:`${Math.round(DEFAULT_REVERB_WET*100)}% ${DEFAULT_REVERB_NAME}, full padded tail`};await writeFile(new URL('render-report.json',out),JSON.stringify(report,null,2));console.log(report);
