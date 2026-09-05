import { writeFile, mkdir } from 'node:fs/promises';
import { parseStandardMidi, renderMidiPerformance } from './midi-performance.mjs';
import { readWav, writeStereoPcm16Wav } from './audio-analysis.mjs';
import { applyConvolverReverb } from './convolution-reverb.mjs';
import { DEFAULT_REVERB_IR_URL, DEFAULT_REVERB_WET, DEFAULT_REVERB_NAME } from '../src/reverb.js';

const out = new URL('../demos/wheels-on-the-bus/', import.meta.url);
await mkdir(out, {recursive:true});
const ppq=480, events=[];
let sequence=0;
const event=(beat,data)=>events.push({tick:Math.round(beat*ppq),data,sequence:sequence++});
const meta=(beat,type,data)=>event(beat,[255,type,data.length,...data]);
const text=s=>[...Buffer.from(s)];
meta(0,3,text('The Wheels on the Bus - A Little Town Ride'));
meta(0,0x58,[4,2,24,8]); meta(0,0x59,[255,0]);
const tempo=(beat,bpm)=>{const v=Math.round(60000000/bpm);meta(beat,0x51,[(v>>16)&255,(v>>8)&255,v&255]);};
tempo(0,116); event(0,[0xc0,0]);
function note(beat,pitch,duration,velocity=70){
  const drift=beat===0?0:0.006*Math.sin(sequence*1.71);
  event(beat+drift,[0x90,pitch,velocity]);event(beat+drift+duration,[0x80,pitch,58]);
}
const chord=(b,p,d,v)=>p.forEach((n,i)=>note(b+i*.012,n,d,v-i));
const F=[53,57,60], Bb=[53,58,62], C=[52,55,60], Dm=[53,57,62];
const harmony=[F,F,C,C,F,Bb,C,F];
const bass=[41,41,48,48,41,46,48,41];
const melody=[
 [[65,.5],[65,.5],[65,.5],[65,.5],[69,1],[72,1]],
 [[69,1],[65,1],[65,2]], [[67,1],[67,1],[67,2]],
 [[64,1],[60,1],[60,2]],
 [[65,.5],[65,.5],[65,.5],[65,.5],[69,1],[72,1]],
 [[69,1],[65,1],[65,1],[69,1]], [[67,2],[60,2]], [[65,3],[null,1]]
];
// Four-bar invitation, with a turning upper figure and a dominant pickup.
for(let bar=0;bar<4;bar++){
 const b=bar*4, h=[F,Dm,Bb,C][bar];note(b,[41,38,46,48][bar],1.7,60);
 for(let k=0;k<4;k++) note(b+k,h[k%3]+12,.65,57+k*2);
 if(bar<3) chord(b+2,h,.65,49);
}
note(15.5,60,.43,72);
for(let verse=0;verse<3;verse++){
 const start=16+verse*32;meta(start,6,text(['Round and round','Little bells and windows','Homeward parade'][verse]));
 for(let bar=0;bar<8;bar++){
  const b=start+bar*4,h=harmony[bar];
  note(b,bass[bar],.76,61+verse*2);note(b+2,bass[bar]+7,.72,56+verse*2);
  if(verse===1){for(let k=1;k<8;k+=2) note(b+k*.5,h[(k>>1)%3]+12,.37,53);}
  else {chord(b+1,h,.58,48+verse*3);chord(b+3,h,.53,46+verse*3);}
  let offset=0;
  for(const [pitch,duration] of melody[bar]){
   if(pitch!==null){const n=pitch+(verse===1?12:0);note(b+offset,n,duration*.84,75+verse*2+(offset===0?3:0));
    if(verse===2&&duration>=1&&pitch>=65) note(b+offset,pitch-12,duration*.75,53);
   }offset+=duration;
  }
  if(verse===1 && [1,3,7].includes(bar)) {note(b+3.1,81,.2,52);note(b+3.4,79,.2,48);note(b+3.7,77,.2,46);}
 }
}
// Four-bar coda: the wheels coast into a rolled final F-sixth chord.
meta(112,6,text('The last stop'));tempo(112,110);tempo(116,104);tempo(120,94);tempo(124,78);
for(let j=0;j<3;j++){
 const b=112+j*4,h=[Bb,C,F][j];note(b,[46,48,41][j],1.5,60-j*3);
 chord(b+1,h,.7,48-j*2);note(b+2,[69,67,65][j],1.6,72-j*5);
}
event(123.8,[0xb0,64,80]);chord(124,[41,53,57,60,65,69],3.8,61);
event(128.1,[0xb0,64,0]);meta(129,0x2f,[]);
events.sort((a,b)=>a.tick-b.tick||a.sequence-b.sequence);
function vlq(n){const a=[n&127];while(n>>=7)a.unshift((n&127)|128);return a;}
let tick=0;const bytes=[];for(const e of events){bytes.push(...vlq(e.tick-tick),...e.data);tick=e.tick;}
const header=Buffer.from([77,84,104,100,0,0,0,6,0,0,0,1,1,224]);
const track=Buffer.alloc(8);track.write('MTrk');track.writeUInt32BE(bytes.length,4);
const midi=Buffer.concat([header,track,Buffer.from(bytes)]);await writeFile(new URL('wheels-on-the-bus.mid',out),midi);
const score=parseStandardMidi(midi),render=renderMidiPerformance(score);
if(render.clippedFrames||render.truncatedVoices)throw Error('Source clipping or truncated voices');
const left=Float32Array.from(render.mono,x=>x*Math.SQRT1_2),right=left.slice();
const ir=await readWav(DEFAULT_REVERB_IR_URL,{preserveChannels:true});
applyConvolverReverb(left,right,ir.channelSamples[0],ir.channelSamples[1],{wet:DEFAULT_REVERB_WET,sampleRate:render.sampleRate});
await writeStereoPcm16Wav(new URL('wheels-on-the-bus-render.wav',out),left,right,render.sampleRate);
const report={title:'The Wheels on the Bus - A Little Town Ride',notes:score.noteCount,durationSeconds:render.mono.length/render.sampleRate,sourceClippedFrames:render.clippedFrames,truncatedVoices:render.truncatedVoices,maximumVoices:render.maximumVoices,midiFormat:0,ppq,key:'F major',structure:'4-bar introduction, three 8-bar variations, 4-bar ritardando coda',instrument:`Repository procedural grand piano persistent MIDI engine; ${Math.round(DEFAULT_REVERB_WET*100)}% ${DEFAULT_REVERB_NAME} reverb`};
await writeFile(new URL('render-report.json',out),JSON.stringify(report,null,2));console.log(report);
