import { mkdir, writeFile } from 'node:fs/promises';
import { parseStandardMidi } from './midi-performance.mjs';

// Original piano arrangement: Starlight Variations. Quarter note = 480 ticks.
const tracks = [[], [], []], PPQ = 480;
const event = (track, beat, bytes) => tracks[track].push({ tick: Math.round(beat * PPQ), bytes });
const meta = (beat, type, bytes) => event(0, beat, [255, type, bytes.length, ...bytes]);
const label = (beat, name) => meta(beat, 6, [...Buffer.from(name)]);
const tempo = (beat, bpm) => { const n = Math.round(60e6 / bpm); meta(beat, 81, [n >> 16, n >> 8 & 255, n & 255]); };
let count = 0;
function note(track, beat, pitch, duration, velocity) {
  const drift = .009 * Math.sin(++count * 2.39);
  const onset = Math.max(0, beat + drift);
  event(track, onset, [0x90, pitch, Math.max(1, Math.min(127, Math.round(velocity + 2 * Math.sin(count * 1.71))))]);
  event(track, onset + duration, [0x80, pitch, 48]);
}
function pedal(beat, duration = 3.78, depth = 90) {
  event(0, beat, [0xb0, 64, 0]);
  event(0, beat + .14, [0xb0, 64, depth]);
  event(0, beat + duration, [0xb0, 64, 0]);
}
meta(0, 3, [...Buffer.from('Twinkle - Starlight Variations')]);
meta(0, 88, [4, 2, 24, 8]);
meta(0, 89, [0, 0]);
event(1, 0, [0xc0, 0]);
event(2, 0, [0xc0, 0]);
const chords = [
  [48,55,60,64], [45,57,60,65], [41,53,57,62], [48,55,59,62],
  [45,52,55,60], [43,53,57,59], [41,53,57,60], [43,53,57,59],
  [48,55,60,64], [45,57,60,65], [41,53,57,62], [48,55,60,64],
];
const melody = [
  [[72,1],[72,1],[79,1],[79,1]], [[81,1],[81,1],[79,2]],
  [[77,1],[77,1],[76,1],[76,1]], [[74,1],[74,1],[72,2]],
  [[79,1],[79,1],[77,1],[77,1]], [[76,1],[76,1],[74,2]],
  [[79,1],[79,1],[77,1],[77,1]], [[76,1],[76,1],[74,2]],
  [[72,1],[72,1],[79,1],[79,1]], [[81,1],[81,1],[79,2]],
  [[77,1],[77,1],[76,1],[76,1]], [[74,1],[74,1],[72,2]],
];
label(0, 'A sky full of stars'); tempo(0, 84);
for (let bar = 0; bar < 4; bar++) {
  const b = bar * 4, c = [[48,55,60,64],[45,52,59,64],[41,53,57,64],[43,55,59,62]][bar];
  pedal(b, 3.75, 78);
  c.forEach((p, i) => note(2, b + i * .5, p, 1.5, 48 + i * 3));
  [76,79,84,79].forEach((p,i) => note(1, b + 2 + i * .5, p + (bar === 1 ? -3 : 0), .42, 58 - i * 3));
}
for (let variation = 0; variation < 2; variation++) {
  const start = 16 + variation * 48;
  label(start, variation ? 'Stardust - flowing variation' : 'The familiar little star');
  tempo(start, variation ? 108 : 92);
  for (let bar = 0; bar < 12; bar++) {
    const b = start + bar * 4, c = chords[bar];
    pedal(b, 3.78, variation ? 78 : 88);
    note(2, b, c[0], 1.65, variation ? 62 : 54);
    if (variation) {
      [c[1],c[2],c[3],c[2],c[1],c[3],c[2]].forEach((p,i) => note(2,b+.5+i*.5,p,.46,52+(i%3)*3));
    } else {
      [1,2,3].forEach((offset) => {
        note(2,b+offset,c[1],.78,46);
        note(2,b+offset+.025,c[offset === 2 ? 3 : 2],.76,48);
      });
    }
    let offset = 0;
    for (const [p,d] of melody[bar]) {
      const v = (variation ? 83 : 75) + (offset === 0 ? 3 : 0) - (bar % 4 === 3 ? 5 : 0);
      note(1,b+offset,p,d*.88,v);
      if (variation && d === 2) {
        const ornaments = [p+7,p+12,p+7];
        ornaments.forEach((q,i) => note(1,b+offset+.5+i*.5,q,.37,60-i*3));
      }
      offset += d;
    }
    if (bar === 11) { tempo(b, variation ? 98 : 86); tempo(b+2, variation ? 90 : 80); }
  }
}
label(112, 'Goodnight - distant bells'); tempo(112, 78);
for (let bar=0; bar<3; bar++) {
  const b=112+bar*4, c=[[41,53,57,60],[43,55,59,62],[48,55,60,64]][bar];
  pedal(b,3.8,85);
  c.forEach((p,i)=>note(2,b+i*.12,p,2.9-i*.12,49-i*2));
  [bar===0?77:bar===1?74:72,79,84].forEach((p,i)=>note(1,b+i,p,1.25,65-i*7-bar*4));
  tempo(b,78-bar*10);
}
tempo(124,52); pedal(124,5.5,90);
[36,48,55,60,64].forEach((p,i)=>note(2,124+i*.10,p,4.5-i*.1,45-i*2));
note(1,124.6,84,3.7,53); note(1,125.5,91,2.8,43); note(1,126.5,96,1.8,37);
event(0,130,[0xb0,64,0]);
function vlq(n) { const a=[n&127]; while(n>>=7)a.unshift((n&127)|128); return a; }
function chunk(name, data) { const header=Buffer.alloc(8); header.write(name); header.writeUInt32BE(data.length,4); return Buffer.concat([header,Buffer.from(data)]); }
const header=Buffer.alloc(6); header.writeUInt16BE(1,0); header.writeUInt16BE(3,2); header.writeUInt16BE(PPQ,4);
const midi=Buffer.concat([chunk('MThd',header),...tracks.map(events=>{
  events.sort((a,b)=>a.tick-b.tick); let previous=0; const bytes=[];
  for(const e of events){ bytes.push(...vlq(e.tick-previous),...e.bytes); previous=e.tick; }
  bytes.push(0,255,47,0); return chunk('MTrk',bytes);
})]);
const parsed=parseStandardMidi(midi);
if(parsed.noteCount!==count)throw new Error('MIDI note count mismatch');
await mkdir(new URL('../demos/',import.meta.url),{recursive:true});
await writeFile(new URL('../demos/twinkle-starlight-variations.mid',import.meta.url),midi);
console.log(JSON.stringify({notes:parsed.noteCount,seconds:parsed.durationSeconds,tracks:parsed.trackCount},null,2));
