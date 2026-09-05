import { mkdir, writeFile } from 'node:fs/promises';
import { parseStandardMidi, renderMidiPerformance } from './midi-performance.mjs';
import { readWav, writeStereoPcm16Wav } from './audio-analysis.mjs';
import { applyConvolverReverb } from './convolution-reverb.mjs';
import { DEFAULT_REVERB_IR_URL, DEFAULT_REVERB_WET, DEFAULT_REVERB_NAME } from '../src/reverb.js';

// Original composition: every melodic phrase is authored here; no borrowed tunes.
const out=new URL('../demos/codex-lanterns-at-midnight/',import.meta.url);
await mkdir(out,{recursive:true});
const ev=[],sections=[];let seq=0,b=0;
const event=(beat,data)=>ev.push({tick:Math.max(0,Math.round(beat*480)),data,seq:seq++});
const meta=(beat,type,data)=>event(beat,[255,type,data.length,...data]);
const tempo=(beat,bpm)=>{const t=Math.round(6e7/bpm);meta(beat,81,[t>>16,(t>>8)&255,t&255]);};
function section(name,meter,bpm){sections.push({name,beat:b,meter,bpm});meta(b,6,[...Buffer.from(name)]);meta(b,88,[meter[0],Math.log2(meter[1]),24,8]);tempo(b,bpm);}
function n(t,p,d,v=70,ch=0){if(p===null)return;const time=t+.004*Math.sin(seq*2.31);event(time,[144+ch,p,Math.max(1,Math.min(115,Math.round(v)))]);event(time+Math.max(.06,d),[128+ch,p,48]);}
function chord(t,ps,d,v){ps.forEach((p,i)=>n(t+i*.013,p,d,v-i,1));}
function pedal(t,len,depth=75){event(t+.05,[176,64,depth]);event(t+len-.11,[176,64,0]);}
function melody(t,phrase,{shift=0,v=78,gate=.88,oct=false}={}){let at=t;for(const [p,d]of phrase){n(at,p===null?null:p+shift,d*gate,v+3*Math.sin((at-t)*1.4));if(oct&&p!==null)n(at+.012,p+shift-12,d*.76,v-13,2);at+=d;}}
const H={d:[38,50,57,62,65],a:[33,52,57,61,64],g:[43,50,55,58,62],bb:[34,50,53,58,62],f:[41,48,53,57,60],c:[36,48,55,60,64],e:[40,52,55,58,64],D:[38,50,57,62,66],G:[43,50,55,59,62],A:[33,52,57,61,64],B:[35,47,54,59,62],fs:[30,49,54,58,61]};
function accompaniment(t,key,len,kind,v=46){const h=H[key];if(kind==='waltz'){n(t,h[0],.8,v+9,1);for(let k=1;k<len;k++)chord(t+k,h.slice(2),.62,v);}else if(kind==='dance'){n(t,h[0],.33,v+10,1);chord(t+.5,h.slice(2),.23,v);n(t+1,h[1],.3,v+5,1);chord(t+1.5,h.slice(2),.24,v);}else{n(t,h[0],Math.min(len-.15,1.5),v+8,1);const step=kind==='storm'?.25:.5;const pattern=[1,2,3,4,3,2,1,2];for(let j=0;j<len/step;j++)n(t+j*step,h[pattern[j%8]],step*.84,v+4*Math.sin(j*.9),1);pedal(t,len,kind==='storm'?64:73);}}
meta(0,3,[...Buffer.from('Codex - Lanterns at Midnight, an Original Rhapsody')]);event(0,[192,0]);event(0,[193,0]);event(0,[194,0]);meta(0,89,[255,1]);

section('I. The empty square - declamando',[4,4],58);
const intro=[[[74,1],[81,.5],[80,.5],[77,2]],[[76,.75],[73,.25],[74,2],[null,1]],[[77,1.5],[84,.5],[82,.5],[81,.5],[77,1]],[[76,1],[73,1],[69,1],[null,1]],[[74,.5],[77,.5],[81,.5],[86,1.5],[85,1]],[[82,1],[81,.5],[77,.5],[76,1],[73,1]],[[74,1],[69,.5],[65,.5],[64,1],[61,1]],[[62,2.5],[null,1.5]]];
intro.forEach((p,j)=>{tempo(b,[58,54,62,55,66,59,52,43][j]);const key=['d','a','bb','a','g','bb','a','d'][j];chord(b,H[key].slice(0,4),j===7?2.4:1.1,66+j%3*4);melody(b+.1,p,{v:85-j%2*12,gate:.83});if(j===2||j===4)for(let k=0;k<8;k++)n(b+2+k/8,H[key][1+k%4]+12,.12,57+k);pedal(b,3.75);b+=4;});

// A: the falling semitone after an upward fifth becomes a tender three-beat song.
const song=[[[74,1],[81,.5],[80,.5],[77,1]],[[76,.5],[73,.5],[74,2]],[[77,1],[79,.5],[81,.5],[84,1]],[[82,1.5],[81,.5],[77,1]],[[79,.5],[77,.5],[74,1],[70,1]],[[72,1],[77,.5],[76,.5],[72,1]],[[73,.5],[76,.5],[81,1],[79,.5],[76,.5]],[[74,2],[null,1]]];
section('II. A lantern song - cantabile',[3,4],78);
for(let j=0;j<16;j++){const k=j%8;tempo(b,k===7?68:78+(j>=8?3:0));accompaniment(b,['d','a','f','bb','g','c','a','d'][k],3,j<8?'waltz':'flow',j<8?42:47);melody(b,song[k],{v:j<8?76:84,shift:j>=12?0:0});if(j>=8&&k<7)n(b+2,H[['d','a','f','bb','g','c','a','d'][k]][3],.8,54,2);b+=3;}

const dance=[[[74,.25],[81,.25],[80,.5],[77,.25],[74,.25],[null,.5]],[[73,.25],[76,.25],[79,.5],[76,.5],[73,.5]],[[74,.5],[77,.25],[81,.25],[86,.5],[84,.5]],[[82,.25],[81,.25],[77,.5],[74,.5],[null,.5]],[[79,.25],[82,.25],[81,.25],[79,.25],[77,.5],[74,.5]],[[76,.5],[79,.5],[84,.25],[83,.25],[84,.5]],[[85,.25],[81,.25],[79,.25],[76,.25],[73,.5],[69,.5]],[[74,.5],[null,.5],[74,.25],[77,.25],[81,.5]]];
section('III. Mischief in the square - scherzando',[2,4],128);
for(let j=0;j<24;j++){const k=j%8;const key=['d','a','d','bb','g','c','a','d'][k];accompaniment(b,key,2,'dance',j<8?43:49);melody(b,dance[k],{v:75+(j>=16?10:0),shift:j>=8&&j<16?12:0,gate:.61});if(j===7||j===15)tempo(b,116);else tempo(b,128+j/3);b+=2;}

section('IV. Behind the windows - sotto voce',[6,8],84);
const shadow=[[[78,1.5],[77,.5],[74,.5],[73,.5]],[[71,1],[74,.5],[78,1],[77,.5]],[[79,.5],[78,.5],[74,.5],[71,1.5]],[[70,1],[73,.5],[78,1.5]],[[74,.5],[78,.5],[81,.5],[86,1.5]],[[83,1.5],[81,.5],[78,.5],[74,.5]],[[77,.5],[73,.5],[70,.5],[66,.75],[73,.75]],[[71,2.5],[null,.5]]];
event(b,[176,67,90]);
for(let j=0;j<16;j++){const k=j%8,key=['B','fs','G','fs','B','g','fs','B'][k];tempo(b,k===7?70:84);accompaniment(b,key,3,'flow',35+(j>=8?5:0));melody(b,shadow[k],{v:64+(j>=8?7:0),shift:j<8?0:12,gate:.95});b+=3;}
event(b,[176,67,0]);

section('V. Wind and sparks - agitato',[4,4],116);
// Sequential transformations alternate continuous figuration with shouted answers.
const progression=['g','d','e','a','bb','f','g','a','d','c','bb','a','g','e','a','a','d','bb','g','a','d','g','a','a'];
for(let j=0;j<24;j++){let key=progression[j],h=H[key];tempo(b,116+j*1.0);if(j%4===3){chord(b,h.slice(0,4),.65,79);melody(b,[[h[3]+12,.5],[h[3]+19,.5],[h[3]+18,.5],[h[3]+15,.5],[h[3]+14,1],[null,1]],{v:98,oct:true});pedal(b,2.8);}else{accompaniment(b,key,4,'storm',49+j*.25);const upper=h.slice(2).map(x=>x+12);for(let k=0;k<16;k++){const shape=[0,1,2,1,0,2,1,2,0,1,2,1,2,1,0,1];n(b+k*.25,upper[shape[k]]+(k>=8&&j>15?12:0),.2,77+8*Math.sin(k*.5)+j*.3);}n(b,h[3]+12,1.0,96,2);}b+=4;}

section('VI. The lantern song remembered',[3,4],76);
for(let j=0;j<8;j++){const key=['D','A','f','bb','G','c','A','D'][j];tempo(b,j===7?60:76);accompaniment(b,key,3,'waltz',46);const phrase=song[j].map(([p,d])=>[p===77?78:p===80?81:p,d]);melody(b,phrase,{v:86,oct:j<4});b+=3;}

section('VII. Daybreak carnival - vivo',[2,4],148);meta(b,89,[2,0]);
for(let j=0;j<32;j++){const k=j%8,key=['D','A','D','G','G','D','A','D'][k];tempo(b,148+Math.floor(j/8)*8);accompaniment(b,key,2,'dance',54);const phrase=dance[k].map(([p,d])=>[p===77?78:p===80?81:p===70?71:p===82?83:p,d]);melody(b,phrase,{v:89+j*.28,shift:j>=8&&j<16?12:0,gate:.72,oct:j>=24});if(j>=16&&j<24){const h=H[key];for(let q=0;q<4;q++)n(b+.25+q*.5,h[2+q%3]+12,.16,60,2);}b+=2;}
section('VIII. Coda - tutta forza',[4,4],168);
for(let j=0;j<3;j++){const key=['G','A','D'][j];accompaniment(b,key,4,'storm',57);const scale=j===1?[69,71,73,74,76,78,79,81]:[62,64,66,67,69,71,73,74];for(let k=0;k<16;k++)n(b+k*.25,scale[k%8]+12*Math.floor(k/8),.2,91+k*.6);b+=4;}
tempo(b,124);chord(b,[38,50,57,62,66],.7,94);chord(b+.06,[74,78,81,86],.7,100);chord(b+1.25,[33,45,57,61,67],.55,87);chord(b+1.29,[73,79,81,85],.55,97);tempo(b+2,76);chord(b+2,[26,38,50,57],3.4,94);chord(b+2.05,[62,66,74,78,81,86],3.3,103);pedal(b+2,4.4,88);b+=7;event(b,[176,64,0]);meta(b+.5,47,[]);

ev.sort((a,c)=>a.tick-c.tick||a.seq-c.seq);
const active=new Map();for(const e of ev){const s=e.data[0]&240,k=(e.data[0]&15)+':'+e.data[1];if(s===144)active.set(k,(active.get(k)||0)+1);if(s===128){if(!active.get(k))throw Error('Unmatched release '+k);active.set(k,active.get(k)-1);}}if([...active.values()].some(Boolean))throw Error('Held notes');
function vlq(x){let a=[x&127];while(x>>=7)a.unshift((x&127)|128);return a;}let prev=0,bytes=[];for(const e of ev){bytes.push(...vlq(e.tick-prev),...e.data);prev=e.tick;}
const hdr=Buffer.from([77,84,104,100,0,0,0,6,0,0,0,1,1,224]),trk=Buffer.alloc(8);trk.write('MTrk');trk.writeUInt32BE(bytes.length,4);const midi=Buffer.concat([hdr,trk,Buffer.from(bytes)]);await writeFile(new URL('codex-lanterns-at-midnight.mid',out),midi);
const score=parseStandardMidi(midi);console.log('Composition:',score.noteCount,'notes;',score.durationSeconds.toFixed(2),'seconds');
const rendered=renderMidiPerformance(score);if(rendered.clippedFrames||rendered.truncatedVoices)throw Error(JSON.stringify({clipped:rendered.clippedFrames,truncated:rendered.truncatedVoices}));
const ir=await readWav(DEFAULT_REVERB_IR_URL,{preserveChannels:true});let left=new Float32Array(rendered.mono.length+ir.channelSamples[0].length);for(let i=0;i<rendered.mono.length;i++)left[i]=rendered.mono[i]*Math.SQRT1_2;let right=left.slice();applyConvolverReverb(left,right,ir.channelSamples[0],ir.channelSamples[1],{wet:DEFAULT_REVERB_WET,sampleRate:rendered.sampleRate});
let peak=0;for(let i=0;i<left.length;i++)peak=Math.max(peak,Math.abs(left[i]),Math.abs(right[i]));if(peak>=1)throw Error('Wet clipping');
await writeStereoPcm16Wav(new URL('codex-lanterns-at-midnight-render.wav',out),left,right,rendered.sampleRate);
const report={title:'Lanterns at Midnight — an Original Codex Rhapsody',original:true,sections,notes:score.noteCount,unmatchedNotes:0,midiFormat:score.format,ppq:480,durationSeconds:left.length/rendered.sampleRate,maximumVoices:rendered.maximumVoices,sourceClippedFrames:rendered.clippedFrames,truncatedVoices:rendered.truncatedVoices,reverb:`${Math.round(DEFAULT_REVERB_WET*100)}% ${DEFAULT_REVERB_NAME}, full padded tail`,preMasterPeak:peak};await writeFile(new URL('render-report.json',out),JSON.stringify(report,null,2));console.log(report);
