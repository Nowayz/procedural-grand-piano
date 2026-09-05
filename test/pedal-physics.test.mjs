import assert from 'node:assert/strict';
import test from 'node:test';
import { runC } from '../tools/run-c-check.mjs';
import { createGrandPianoProcessorOptions, createRealtimeGrandPianoEngine } from '../src/grand-piano.js';

const rates = [32000, 44100, 48000, 96000];
const frequency = (midi) => 440 * 2 ** ((midi - 69) / 12);
function raw(rate = 44100, voices = 8) {
 const wasm = new WebAssembly.Instance(createGrandPianoProcessorOptions(voices).wasmModule).exports;
 wasm._initialize(); wasm.rt_reset(rate, voices); return wasm;
}
function advance(wasm, frames, pattern = [128]) {
 let part = 0;
 while (frames > 0) { const n = Math.min(frames, pattern[part++ % pattern.length]); wasm.rt_process(n); frames -= n; }
}
function render(engine, frames, pattern = [128]) {
 const pcm = new Float32Array(frames), block = new Float32Array(128);
 for (let offset = 0, part = 0; offset < frames;) { const n = Math.min(frames - offset, pattern[part++ % pattern.length]); engine.process(block, n); pcm.set(block.subarray(0, n), offset); offset += n; }
 return pcm;
}
function firstDifference(a, b) { return a.findIndex((x, i) => x !== b[i]); }

test('both pedals follow the continuous-time mechanical step response at every sample rate, including silence', () => {
 for (const rate of rates) for (const soft of [0, 1]) {
  const w = raw(rate), response = soft ? .16 : .12, omega = 4.743864518390579 / response;
  (soft ? w.rt_una_corda : w.rt_sustain)(1, 0);
  // Processing an event does not teleport the position: displacement is O(dt^2).
  advance(w, 1); assert.ok(w.rt_pedal_position(soft) < 2e-6);
  const frames = Math.round(response * rate); advance(w, frames - 1, [17, 3, 128]);
  const t = frames / rate, expected = 1 - (1 + omega * t) * Math.exp(-omega * t);
  assert.ok(Math.abs(w.rt_pedal_position(soft) - expected) < 1e-10);
  assert.ok(Math.abs(w.rt_pedal_velocity(soft) - omega * omega * t * Math.exp(-omega * t)) < 1e-9);
  assert.equal(w.rt_voice_count(), 0);
 }
});

test('pedal reversals preserve momentum; reset clears position, momentum, targets, and pending events', () => {
 const w = raw(); w.rt_sustain(1, 0); advance(w, 1000);
 const before = w.rt_pedal_position(0), speed = w.rt_pedal_velocity(0);
 w.rt_sustain(0, 0); advance(w, 1);
 assert.ok(w.rt_pedal_position(0) > before, 'a foot/linkage cannot reverse velocity instantaneously');
 assert.ok(Math.abs(w.rt_pedal_velocity(0) - speed) < .1);
 for (let i = 0; i < 200; ++i) { w.rt_sustain(i % 2, 0); w.rt_una_corda((i % 3) / 2, 0); advance(w, 71); for (const pedal of [0, 1]) assert.ok(w.rt_pedal_position(pedal) >= 0 && w.rt_pedal_position(pedal) <= 1); }
 w.rt_sustain(1, 1000); w.rt_reset(44100, 8); advance(w, 10000);
 for (const pedal of [0, 1]) { assert.equal(w.rt_pedal_position(pedal), 0); assert.equal(w.rt_pedal_velocity(pedal), 0); }
});

test('dense polyphony and irregular blocks advance pedals on the same clock as sparse voices', () => {
 const engines = [createRealtimeGrandPianoEngine(8), createRealtimeGrandPianoEngine(8)];
 for (const e of engines) {
  e.sustain(1, 37).unaCorda(1, 91);
  for (let i = 0; i < 6; ++i) e.noteOn(i + 1, frequency(48 + i * 3), .55, 600 + i * 31).noteOff(i + 1, .5, 4300 + i * 17);
  e.sustain(0, 5000).sustain(.5, 6200).unaCorda(0, 8000).noteOn(9, frequency(72), .5, 9100);
 }
 const a = render(engines[0], 18000), b = render(engines[1], 18000, [1, 17, 128, 31, 3]);
 assert.equal(firstDifference(a, b), -1);
 for (const voices of [0, 1, 6]) {
  const w = raw(); w.rt_sustain(1, 37); w.rt_una_corda(1, 37);
  for (let i = 0; i < voices; ++i) w.rt_note_on(i + 1, frequency(50 + i), .3, 0);
  advance(w, 5000);
  for (const soft of [0, 1]) { const omega = 4.743864518390579 / (soft ? .16 : .12), t = (5000 - 37) / 44100; assert.ok(Math.abs(w.rt_pedal_position(soft) - (1 - (1 + omega * t) * Math.exp(-omega * t))) < 1e-10); }
 }
});

test('soft pedal affects subsequent hammer contacts without altering an already ringing note', () => {
 const plain = createRealtimeGrandPianoEngine(2), moving = createRealtimeGrandPianoEngine(2);
 plain.noteOn(1, frequency(60), .7); moving.noteOn(1, frequency(60), .7).unaCorda(1, 2205);
 assert.equal(firstDifference(render(plain, 16000), render(moving, 16000)), -1);
 const w = raw(); w.rt_una_corda(1, 0); w.rt_note_on(1, frequency(72), .7, 0); advance(w, 1);
 assert.equal(w.rt_string_contact(1, 2), 1, 'simultaneous target and strike still use the starting position');
 advance(w, 22050); w.rt_note_on(1, frequency(72), .7, 0); advance(w, 1);
 assert.equal(w.rt_string_contact(1, 2), 0, 'the shifted hammer clears the outer string, including on restrike');
});

test('pedal release after key return follows actual lift, without repeating key-return travel', () => {
 for (const rate of rates) {
  const released = createRealtimeGrandPianoEngine(2).reset(rate), held = createRealtimeGrandPianoEngine(2).reset(rate);
  for (const e of [released, held]) { e.sustain(1); render(e, Math.round(.5 * rate)); e.noteOn(1, frequency(60), .7).noteOff(1, .5, Math.round(.1 * rate)); render(e, Math.round(.4 * rate)); }
  released.sustain(0);
  const a = render(released, Math.round(.1 * rate)), b = render(held, Math.round(.1 * rate));
  const delay = firstDifference(a, b) / rate;
  assert.ok(delay > .015 && delay < .04, `actual contact after ${delay}s at ${rate}Hz`);
 }
});

test('key-up does not cut off sympathetic excitation before the damper arrives', () => {
 const held = createRealtimeGrandPianoEngine(4), released = createRealtimeGrandPianoEngine(4);
 for (const e of [held, released]) e.noteOn(1, frequency(60), .6).noteOn(2, frequency(67), .6);
 released.noteOff(1, .5, 573);
 const a = render(held, 5000), b = render(released, 5000);
 const difference = firstDifference(a, b);
 assert.ok(difference >= Math.round(.05 * 44100));
 assert.ok(difference < 5000, 'contact should eventually damp the released string');
});

test('nonlinear contact duration changes with felt and contact count; passive string responds after excitation', () => {
 for (const midi of [36, 60, 84]) {
  const duration = [];
  for (const soft of [0, 1]) {
   const w = raw(); w.rt_una_corda(soft, 0); advance(w, 22050);
   w.rt_note_on(1, frequency(midi), .8, 0); advance(w, 1);
   const outer = midi < 49 ? 1 : 2;
   duration.push(w.rt_hammer_contact(1)); assert.ok(w.rt_hammer_impulse(1) > 0);
   assert.equal(w.rt_string_contact(1, outer), 1 - soft);
   assert.equal(w.rt_string_motion(1, outer), 0);
   advance(w, 2205);
   assert.ok(Math.abs(w.rt_string_motion(1, outer)) > 1e-9, 'a cleared string must still receive bridge excitation');
  }
  assert.ok(duration[1] > duration[0], `una corda contact for MIDI ${midi}: ${duration}`);
 }
});

test('contact scaling agrees with an independently integrated power-law collision; unison mixing is contractive', (t) => {
 const output = runC(`#include <assert.h>
#include <stdio.h>
#include "piano-mechanics.h"
static double acceleration(double x,double mass,double k,double p) { return -k*pow(fmax(0,x),p)/mass; }
// Independent RK4 reference, x(0)=0, x'(0)=1, through separation.
static double collision(double mass,double k,double p,double *impulse) {
 double x=0,v=1,dt=1e-7,previous=0;
 for(int i=0;i<1000000;++i) {
  previous=x;
  double a1=acceleration(x,mass,k,p),u2=v+dt*a1/2,a2=acceleration(x+dt*v/2,mass,k,p);
  double u3=v+dt*a2/2,a3=acceleration(x+dt*u2/2,mass,k,p),u4=v+dt*a3,a4=acceleration(x+dt*u3,mass,k,p);
  x+=dt*(v+2*u2+2*u3+u4)/6;v+=dt*(a1+2*a2+2*a3+a4)/6;
  if(x<0) { *impulse=mass*(1-v); return dt*(i+previous/(previous-x)); }
 }
 assert(0);return 0;
}
int main(void) {
 double worst=0;
 for(int midi=24;midi<=108;midi+=12) for(int position=1;position<=4;++position) {
  int n=1+(midi>=31)+(midi>=49);double shift=position/4.;
  PianoContact normal=piano_soft_contact(midi,n,0),soft=piano_soft_contact(midi,n,shift);
  double p=piano_felt_exponent(midi);
  double felt=1-.45*shift*shift*(3-2*shift),j0,j1;
  double t0=collision(normal.reduced_mass,n*1e9,p,&j0),t1=collision(soft.reduced_mass,soft.contact_count*felt*1e9,p,&j1);
  double error=fabs(t1/t0-soft.duration_ratio);worst=fmax(worst,error);assert(error<2e-6);
  assert(fabs(j1/j0-soft.impulse_ratio)<2e-6);
  assert(soft.duration_ratio>=1 && soft.impulse_ratio<=1);
  assert(piano_contact_overlap(1,n,n-1)==(n==1?1:0));
 }
 for(int n=2;n<=3;++n) for(int k=0;k<100;++k) {
  double x[3],sum=0,before=0,after=0,share=piano_unison_share(n,.03,8./44100);
  for(int i=0;i<n;++i) { x[i]=sin(1.2*k+i);sum+=x[i];before+=x[i]*x[i]; }
  for(int i=0;i<n;++i) { double y=x[i]-share*sum;after+=y*y; }
  assert(after<=before+1e-14);
 }
 printf("maximum contact-duration ratio error vs RK4: %.3g\\n",worst);
}`);
 assert.match(output, /maximum contact-duration ratio error vs RK4:/); t.diagnostic(output.trim());
});
