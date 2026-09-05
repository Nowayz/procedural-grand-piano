import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readWav } from './audio-analysis.mjs';

const inputs=process.argv.slice(2);
if(inputs.length!==2)throw new Error('Usage: node tools/prepare-default-reverb.mjs <Boston Hall A left-input.wav> <Boston Hall A right-input.wav>');
const captures=await Promise.all(inputs.map(file=>readWav(file,{preserveChannels:true})));
for(const capture of captures)if(capture.channels!==2||capture.sampleRate!==44100)throw new Error('Expected native 44.1 kHz stereo source captures');
const frames=Math.max(...captures.map(capture=>capture.samples.length));
const wav=Buffer.alloc(44+frames*8);
wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(3,20);wav.writeUInt16LE(2,22);wav.writeUInt32LE(44100,24);wav.writeUInt32LE(44100*8,28);wav.writeUInt16LE(8,32);wav.writeUInt16LE(32,34);wav.write('data',36);wav.writeUInt32LE(frames*8,40);
for(let i=0;i<frames;i++)for(let channel=0;channel<2;channel++) {
  const value=.5*((captures[0].channelSamples[channel][i]??0)+(captures[1].channelSamples[channel][i]??0));
  if(!Number.isFinite(value))throw new Error('Nonfinite impulse response');
  wav.writeFloatLE(value,44+(i*2+channel)*4);
}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const output=new URL('../src/impulse-responses/bricasti-m7-boston-hall-a.wav',import.meta.url);
await writeFile(output,wav);
const metadata={name:'Bricasti M7 Boston Hall A',captureBy:'Samplicity',archiveVersion:'2023-10',sourcePage:'https://samplicity.com/downloads/',archiveUrl:'https://cdn.samplicity.com/downloads/Samplicity%20-%20Bricasti%20IRs%20version%202023-10.zip',archiveFiles:['Samplicity - Bricasti IRs version 2023-10, left-right files, 44.1 Khz/1 Halls 18 Boston Hall A, 44K L.wav','Samplicity - Bricasti IRs version 2023-10, left-right files, 44.1 Khz/1 Halls 18 Boston Hall A, 44K R.wav'],sourceSha256:await Promise.all(inputs.map(async file=>hash(await readFile(file)))),sha256:hash(wav),sampleRate:44100,channels:2,format:'float32',frames,durationSeconds:frames/44100,processing:'Average corresponding output channels of the left-input and right-input captures. No resampling, EQ, normalization, predelay, or tail truncation.'};
await writeFile(new URL('../src/impulse-responses/bricasti-m7-boston-hall-a.json',import.meta.url),JSON.stringify(metadata,null,2)+'\n');
console.log(`Prepared ${frames} stereo frames (${metadata.durationSeconds.toFixed(3)} seconds), SHA-256 ${metadata.sha256}`);
