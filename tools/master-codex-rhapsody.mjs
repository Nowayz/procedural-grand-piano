import { execFileSync } from 'node:child_process';
import { readFile,writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const dir=new URL('../demos/codex-lanterns-at-midnight/',import.meta.url);
const file=s=>fileURLToPath(new URL(s,dir));
const base='codex-lanterns-at-midnight';
function run(args){return execFileSync('ffmpeg',['-hide_banner','-nostats',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});}
import { spawnSync } from 'node:child_process';
function analyze(path){const p=spawnSync('ffmpeg',['-hide_banner','-nostats','-i',path,'-af','loudnorm=I=-18:TP=-1.5:LRA=20:print_format=json','-f','null','NUL'],{encoding:'utf8'});if(p.status!==0)throw Error(p.stderr);const m=JSON.parse(p.stderr.slice(p.stderr.lastIndexOf('{'),p.stderr.lastIndexOf('}')+1));return {integratedLUFS:+m.input_i,truePeakDbTP:+m.input_tp,loudnessRangeLU:+m.input_lra,completeDecode:true};}
const source=analyze(file(base+'-render.wav')),gainDb=Number((-18-source.integratedLUFS).toFixed(2));
run(['-y','-i',file(base+'-render.wav'),'-af',`volume=${gainDb}dB`,'-c:a','pcm_s24le',file(base+'.wav')]);
run(['-y','-i',file(base+'.wav'),'-c:a','libmp3lame','-b:a','192k','-metadata','title=Lanterns at Midnight - An Original Codex Rhapsody','-metadata','artist=Codex',file(base+'.mp3')]);
const wav=analyze(file(base+'.wav')),mp3=analyze(file(base+'.mp3'));
if(wav.truePeakDbTP> -1.5||mp3.truePeakDbTP> -1.5||Math.abs(wav.integratedLUFS+18)>.2)throw Error('Master outside limits');
const report=JSON.parse(await readFile(new URL('render-report.json',dir),'utf8'));report.mastering={method:'Constant gain only; no dynamic compression or limiting',gainDb,source,wav,mp3};await writeFile(new URL('render-report.json',dir),JSON.stringify(report,null,2));console.log(report.mastering);
