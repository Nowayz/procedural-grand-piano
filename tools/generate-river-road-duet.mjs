import { writeFile, mkdir } from 'node:fs/promises';
import { parseStandardMidi, renderMidiPerformance } from './midi-performance.mjs';
import { readWav, writeStereoPcm16Wav } from './audio-analysis.mjs';
import { applyConvolverReverb } from './convolution-reverb.mjs';
import { DEFAULT_REVERB_IR_URL, DEFAULT_REVERB_WET, DEFAULT_REVERB_NAME } from '../src/reverb.js';
const out=new URL('../demos/river-road-duet/',import.meta.url);await mkdir(out,{recursive:true});
const events=[],ppq=480;let seq=0;
const event=(b,data)=>events.push({tick:Math.round(b*ppq),data,seq:seq++});
const meta=(b,t,d)=>event(b,[255,t,d.length,...d]);
const label=(b,s)=>meta(b,6,[...Buffer.from(s)]);
const tempo=(b,bpm)=>{let n=Math.round(60000000/bpm);meta(b,81,[n>>16,(n>>8)&255,n&255]);};
meta(0,3,[...Buffer.from('River Road Duet - Row Your Boat meets Wheels on the Bus')]);meta(0,88,[6,3,24,8]);meta(0,89,[2,0]);tempo(0,112);event(0,[192,0]);event(0,[193,0]);
function note(b,n,d,v=65,ch=0){const t=Math.max(0,b+.003*Math.sin(seq*1.73));event(t,[144+ch,n,v]);event(t+d,[128+ch,n,52]);}
const chord=(b,ns,d,v)=>ns.forEach((n,i)=>note(b+i*.009,n,d,v-i));
const D=[38,50,57,61+1,66],G=[43,55,59,62,67],A=[45,52,57,61,64],Em=[40,52,55,59,64],Bm=[47,54,59,62,66];
const row=[[[62,1.5],[62,1.5]],[[62,1],[64,.5],[66,1.5]],[[66,1],[64,.5],[66,1],[67,.5]],[[69,3]],[[74,.5],[74,.5],[74,.5],[69,.5],[69,.5],[69,.5]],[[66,.5],[66,.5],[66,.5],[62,.5],[62,.5],[62,.5]],[[69,1],[67,.5],[66,1],[64,.5]],[[62,3]]];
const bus=[[[62,.375],[62,.375],[62,.375],[62,.375],[66,.75],[69,.75]],[[66,.75],[62,.75],[62,1.5]],[[64,.75],[64,.75],[64,1.5]],[[61,.75],[57,.75],[57,1.5]],[[62,.375],[62,.375],[62,.375],[62,.375],[66,.75],[69,.75]],[[66,.75],[62,.75],[62,.75],[66,.75]],[[64,1.5],[57,1.5]],[[62,3]]];
function phrase(b,tune,oct=0,v=78,ch=0){tune.forEach((bar,j)=>{let p=0;for(const [n,d] of bar){note(b+j*3+p,n+oct,d*.86,v+(p===0?2:0)-j%3,ch);p+=d;}});}
function water(b,h,v=44,sparse=false){note(b,h[0],2.6,v+7);for(let k=0;k<6;k++){if(sparse&&k%2)continue;note(b+k*.5,h[1+k%4],.43,v+(k===3?3:0));}event(b+.08,[176,64,65]);event(b+2.8,[176,64,0]);}
label(0,'The river meets the road');
for(let j=0;j<4;j++)water(j*3,[D,Bm,G,A][j],41);
phrase(0,[row[0]],12,65);phrase(3,[bus[0]],12,64);phrase(6,[row[2]],12,65);phrase(9,[bus[3]],12,64);
label(12,'Boat melody, turning wheels underneath');phrase(12,row,12,79);
for(let j=0;j<8;j++){const b=12+j*3;water(b,[D,D,G,A,D,G,A,D][j],43,true);if([1,3,7].includes(j))phrase(b,[bus[j]],0,57,1);}
label(36,'Bus melody floating in six-eight');phrase(36,bus,12,80);
for(let j=0;j<8;j++){const b=36+j*3;water(b,[D,D,Em,A,D,G,A,D][j],45,true);if([0,1,4,5].includes(j))phrase(b,[row[j]],0,59,1);}
label(60,'Trading seats - alternating phrases');
for(let j=0;j<8;j++){const b=60+j*3;water(b,[D,D,Em,A,D,G,A,D][j],46);phrase(b,[(j%2?bus:row)[j]],12,81);}
label(84,'Both journeys together');phrase(84,row,12,81);phrase(84,bus,0,69,1);
for(let j=0;j<8;j++)water(84+j*3,[D,D,Em,A,D,G,A,D][j],42,true);
label(108,'A shared homecoming');tempo(108,106);tempo(111,96);tempo(114,82);tempo(117,65);
water(108,G,40,true);phrase(108,[row[6]],12,71);water(111,A,37,true);phrase(111,[bus[6]],12,67);
water(114,D,34,true);phrase(114,[row[7]],12,62);note(114,62,2.7,53,1);
event(116.9,[176,64,78]);chord(117,[38,50,57,62,66,74],3.6,53);event(121.1,[176,64,0]);meta(122,47,[]);
events.sort((a,b)=>a.tick-b.tick||a.seq-b.seq);
const activeRaw=new Map();for(const e of events){const s=e.data[0]&240;if(s===144){const k=(e.data[0]&15)+':'+e.data[1];activeRaw.set(k,(activeRaw.get(k)||0)+1);}if(s===128){const k=(e.data[0]&15)+':'+e.data[1];if(!activeRaw.get(k))throw Error('Unmatched release');activeRaw.set(k,activeRaw.get(k)-1);}}if([...activeRaw.values()].some(Boolean))throw Error('Unreleased notes');
function vlq(n){const a=[n&127];while(n>>=7)a.unshift((n&127)|128);return a;}let prev=0;const bytes=[];for(const e of events){bytes.push(...vlq(e.tick-prev),...e.data);prev=e.tick;}
const hdr=Buffer.from([77,84,104,100,0,0,0,6,0,0,0,1,1,224]),trk=Buffer.alloc(8);trk.write('MTrk');trk.writeUInt32BE(bytes.length,4);
const midi=Buffer.concat([hdr,trk,Buffer.from(bytes)]);await writeFile(new URL('river-road-duet.mid',out),midi);const score=parseStandardMidi(midi);
console.log(`Composition ready: ${score.noteCount} notes, ${score.durationSeconds.toFixed(1)} seconds, two themes braided in D major and 6/8.`);
const rendered=renderMidiPerformance(score);if(rendered.clippedFrames||rendered.truncatedVoices)throw Error('Clipped or truncated voices');
const ir=await readWav(DEFAULT_REVERB_IR_URL,{preserveChannels:true});const left=new Float32Array(rendered.mono.length+ir.channelSamples[0].length);for(let i=0;i<rendered.mono.length;i++)left[i]=rendered.mono[i]*Math.SQRT1_2;const right=left.slice();applyConvolverReverb(left,right,ir.channelSamples[0],ir.channelSamples[1],{wet:DEFAULT_REVERB_WET,sampleRate:rendered.sampleRate});
await writeStereoPcm16Wav(new URL('river-road-duet-render.wav',out),left,right,rendered.sampleRate);
const report={title:'River Road Duet',themes:['Row, Row, Row Your Boat','The Wheels on the Bus'],key:'D major',meter:'6/8',structure:'4-bar intertwined introduction, 8-bar Boat with Bus responses, 8-bar Bus with Boat countermelody, 8-bar phrase exchange, 8-bar simultaneous themes, 4-bar slowing coda',notes:score.noteCount,unmatchedNotes:0,midiFormat:score.format,ppq,durationSeconds:left.length/rendered.sampleRate,maximumVoices:rendered.maximumVoices,sourceClippedFrames:rendered.clippedFrames,truncatedVoices:rendered.truncatedVoices,reverb:`${Math.round(DEFAULT_REVERB_WET*100)}% ${DEFAULT_REVERB_NAME}, full padded tail`};await writeFile(new URL('render-report.json',out),JSON.stringify(report,null,2));console.log(report);
