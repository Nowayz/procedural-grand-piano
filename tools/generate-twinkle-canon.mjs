import { mkdir, writeFile } from 'node:fs/promises';
import { parseStandardMidi } from './midi-performance.mjs';

// One continuous D-major arrangement: Canon's two-beat ground bass supports
// Twinkle's melody, with suspensions and shared motifs developed in between.
const tracks = [[], [], []];
let count = 0;
const event = (t,b,bytes) => tracks[t].push({tick:Math.round(b*480),bytes});
const meta = (b,type,data) => event(0,b,[255,type,data.length,...data]);
const marker = (b,s) => meta(b,6,[...Buffer.from(s)]);
const tempo = (b,bpm) => { const n=Math.round(60e6/bpm); meta(b,81,[n>>16,n>>8&255,n&255]); };
function note(t,b,p,d,v) {
  const onset=Math.max(0,b+.008*Math.sin(++count*2.1));
  event(t,onset,[144,p,Math.round(v+1.8*Math.sin(count*1.3))]);
  event(t,onset+d,[128,p,50]);
}
const harmony = [[38,50,57,62,66],[33,49,57,61,64],[35,50,54,59,62],[30,49,54,57,61],
  [31,50,55,59,62],[38,50,57,62,66],[31,50,55,59,62],[33,52,57,61,64]];
function accompaniment(bars,start,intensity) {
  for(let bar=0;bar<bars;bar++) {
    const b=start+bar*4;
    // Small phrase breathing, without interrupting the dance pulse.
    tempo(b, (intensity===0?108:intensity===1?116:124)-(bar%4===3?3:0));
    for(let half=0;half<2;half++) {
      const h=harmony[(bar*2+half)%8], at=b+half*2;
      event(0,at,[176,64,0]); event(0,at+.12,[176,64,72]); event(0,at+1.88,[176,64,0]);
      note(2,at,h[0],1.45,55+intensity*3);
      const pattern=intensity===0?[h[2],h[3],h[4]]:[h[2],h[3],h[4],h[3],h[2],h[3],h[4]];
      const step=intensity===0?.5:.25;
      pattern.forEach((p,i)=>note(2,at+step*(i+1),p,step*.85,47+intensity*2+(i%3===1?3:0)));
    }
  }
}
meta(0,3,[...Buffer.from('Twinkle in Canon - A Dance of Stars')]);
meta(0,88,[4,2,24,8]); meta(0,89,[2,0]); event(1,0,[192,0]);
marker(0,'The two melodies meet'); accompaniment(4,0,0);
// Canon's descending upper voice, answered by Twinkle's repeated-note calls.
const canon=[78,76,74,73,71,69,71,73];
for(let i=0;i<8;i++) {
  note(1,i*2,canon[i],.94,72);
  const answer=[74,81,83,81,79,78,76,73][i];
  note(1,i*2+1,answer,.4,63); note(1,i*2+1.5,answer,.4,66);
}
const twinkle=[
 [[74,1],[74,1],[81,1],[81,1]],[[83,1],[83,1],[81,2]],
 [[79,1],[79,1],[78,1],[78,1]],[[76,1],[76,1],[74,2]],
 [[81,1],[81,1],[79,1],[79,1]],[[78,1],[78,1],[76,2]],
 [[81,1],[81,1],[79,1],[79,1]],[[78,1],[78,1],[76,2]],
 [[74,1],[74,1],[81,1],[81,1]],[[83,1],[83,1],[81,2]],
 [[79,1],[79,1],[78,1],[78,1]],[[76,1],[76,1],[74,2]],
];
function theme(start,bright) {
  accompaniment(12,start,bright?2:1);
  twinkle.forEach((bar,j)=>{
    let off=0;
    for(const [p,d] of bar) {
      const b=start+j*4+off;
      note(1,b,p,d===2?.91:.83,bright?87:80);
      if(bright && d===1 && off%2===1) {
        // A short diatonic turn grows directly out of the melody note.
        const scale=[69,71,73,74,76,78,79,81,83,85,86];
        const k=scale.indexOf(p);
        note(1,b+.5,scale[k+1],.19,66); note(1,b+.75,p,.19,70);
      }
      if(d===2) {
        // The D over A is a prepared suspension, resolving before the ground repeats.
        const answer=p===74?[76,73]:p===81?[78,76]:[73,76];
        note(1,b+1,answer[0],.41,68); note(1,b+1.5,answer[1],.4,71);
      }
      off+=d;
    }
  });
}
marker(16,'Twinkle over the Canon ground'); theme(16,false);
marker(64,'Interwoven running variations'); accompaniment(8,64,2);
// Sequential running figures retain the repeated-note/leaping Twinkle contour
// while tracing the same eight harmonies and Canon's descending soprano.
const figures=[
 [74,78,81,79,78,74,78,81], [76,73,69,73,76,81,79,76],
 [83,78,74,78,83,81,78,74], [81,78,73,76,78,76,73,69],
 [79,74,71,74,79,81,79,76], [78,74,69,74,78,81,78,74],
 [79,78,76,74,71,74,76,79], [76,73,69,73,76,79,76,73],
];
for(let cycle=0;cycle<2;cycle++) for(let h=0;h<8;h++) {
  const b=64+cycle*16+h*2;
  const line=figures[h];
  if(cycle===0) {
    note(1,b,canon[h],.42,82); note(1,b+.5,canon[h],.4,78);
    line.slice(4).forEach((p,i)=>note(1,b+1+i*.25,p,.20,72+i*2));
  } else line.forEach((p,i)=>note(1,b+i*.25,p,.21,76+(i===0?8:i%4===0?4:0)));
}
marker(96,'Both themes in full bloom'); theme(96,true);
marker(144,'A final sparkling cadence'); accompaniment(4,144,1);
for(let h=0;h<8;h++) {
  const b=144+h*2;
  note(1,b,canon[h],.86,79-h);
  note(1,b+1,[81,81,83,81,79,78,76,73][h],.78,73-h);
  if(h>=4)tempo(b,110-(h-4)*8);
}
tempo(160,78); event(0,160,[176,64,0]); event(0,160.15,[176,64,95]);
[38,50,57,62,66].forEach((p,i)=>note(2,160+i*.045,p,4.2-i*.045,58-i*2));
[74,78,81,86].forEach((p,i)=>note(1,160+i*.25,p,3.3-i*.25,76-i*6));
event(0,165,[176,64,0]);
function vlq(n){const a=[n&127];while(n>>=7)a.unshift(n&127|128);return a;}
function chunk(s,b){const h=Buffer.alloc(8);h.write(s);h.writeUInt32BE(b.length,4);return Buffer.concat([h,Buffer.from(b)]);}
const header=Buffer.from([0,1,0,3,1,224]);
const midi=Buffer.concat([chunk('MThd',header),...tracks.map(events=>{
  events.sort((a,b)=>a.tick-b.tick);let last=0;const bytes=[];
  for(const e of events){bytes.push(...vlq(e.tick-last),...e.bytes);last=e.tick;}
  return chunk('MTrk',[...bytes,0,255,47,0]);
})]);
const performance=parseStandardMidi(midi);
if(performance.noteCount!==count)throw Error('MIDI round-trip mismatch');
const held=new Set();
for(const c of performance.controls){if(c.type==='noteOn')held.add(c.id);if(c.type==='noteOff')held.delete(c.id);}
if(held.size)throw Error('Unreleased notes');
await mkdir(new URL('../demos/',import.meta.url),{recursive:true});
await writeFile(new URL('../demos/twinkle-in-canon.mid',import.meta.url),midi);
console.log(JSON.stringify({notes:count,seconds:performance.durationSeconds,unreleasedNotes:held.size}));
