import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runC } from '../tools/run-c-check.mjs';

const legacy = JSON.parse(readFileSync(new URL('./fixtures/legacy-radiation.json', import.meta.url)));

test('global C curves preserve calibration between anchors and have continuous derivatives', (t) => {
  const result = runC(`#include <assert.h>
#include <stdio.h>
#include "piano-mechanics.h"
#include "high-resolution-radiation-fit.h"
static const double positions[14] = {${legacy.positions.join(',')}};
static const double spectral[14][10] = {${legacy.spectral.map(row => `{${row.join(',')}}`).join(',')}};
static double coefficients[HIGHRES_SPECTRAL_TERMS], bands[14];
static void initialize(double midi, double velocity) {
 double x=(midi-64.5)/43.5,y=2*velocity-1,tx[15]={1,x},ty[8]={1,y},latent[10]={0};
 for(int i=2;i<15;i++)tx[i]=2*x*tx[i-1]-tx[i-2];
 for(int j=2;j<8;j++)ty[j]=2*y*ty[j-1]-ty[j-2];
 for(int k=0;k<10;k++)for(int i=0;i<15;i++)for(int j=0;j<8;j++)latent[k]+=highres_spatial[i*8+j][k]*tx[i]*ty[j];
 for(int i=0;i<HIGHRES_SPECTRAL_TERMS;i++) { coefficients[i]=0;for(int k=0;k<10;k++)coefficients[i]+=latent[k]*highres_scale[k]*highres_spectral[i][k]; }
 for(int i=0;i<14;i++) { bands[i]=0;for(int k=0;k<10;k++)bands[i]+=latent[k]*spectral[i][k]; }
}
static double current(double octave) {
 return piano_chebyshev(coefficients,HIGHRES_SPECTRAL_TERMS,highres_frequency_coordinate(27.5*exp2(octave)));
}
// Test-only legacy Hermite evaluator. Runtime must not contain this path.
static double previous(double x) {
 x=fmin(positions[13],fmax(positions[0],x));int i=0;while(i<12 && x>positions[i+1])i++;
 double w=positions[i+1]-positions[i],t=(x-positions[i])/w,t2=t*t,t3=t2*t;
 double s0=i ? (bands[i+1]-bands[i-1])/(positions[i+1]-positions[i-1]) : (bands[1]-bands[0])/w;
 double s1=i<12 ? (bands[i+2]-bands[i])/(positions[i+2]-positions[i]) : (bands[13]-bands[12])/w;
 return (2*t3-3*t2+1)*bands[i]+(t3-2*t2+t)*w*s0+(-2*t3+3*t2)*bands[i+1]+(t3-t2)*w*s1;
}
int main(void) {
 double max_error=0,max_derivative_jump=0;
 for(int pitch=0;pitch<=174;pitch++)for(int speed=0;speed<=16;speed++) {
  double midi=21+pitch*.5,velocity=speed/16.; initialize(midi,velocity);
  double anchor=(midi-21)/12,offset=current(anchor)-previous(anchor);
  for(int i=0;i<=214;i++) {
   double x=i<14 ? positions[i] : log2(20./27.5)+(i-14)/200.*log2(45600./20);
   double error=fabs(current(x)-previous(x)-offset);assert(isfinite(error));max_error=fmax(max_error,error);
  }
  for(int i=0;i<14;i++) {
   double x=positions[i],h=1e-7,c=current(x),left=(c-current(x-h))/h,right=(current(x+h)-c)/h;
   max_derivative_jump=fmax(max_derivative_jump,fabs(right-left));
  }
 }
 assert(max_error<.25);assert(max_derivative_jump<.05);
 double mass_error=0,mass_squared_error=0,felt_error=0,contact_error=0,last_mass=1;
 const double mass[8]={.189,.073,.0307/2,.0117/3,.0053/3,.0024/3,.00115/3,.00054/3};
 for(int step=0;step<=8700;step++) {
  double midi=21+step*.01,o=fmin(7,fmax(0,(midi-24)/12));int i=(int)fmin(6,floor(o));
  double old=exp(log(mass[i])+(o-i)*log(mass[i+1]/mass[i])),now=piano_string_mass(midi);
  double error=fabs(now/old-1);mass_error=fmax(mass_error,error);mass_squared_error+=error*error;
  assert(isfinite(now) && now>0 && now<=last_mass);last_mass=now;
  double p=piano_felt_exponent(midi),old_p=2.3+.2*fmin(1,fmax(0,(midi-36)/24))+.5*fmin(1,fmax(0,(midi-60)/36));
  assert(p>=2.3-1e-12 && p<=3+1e-12);felt_error=fmax(felt_error,fabs(p-old_p));
  int n=1+(midi>=31)+(midi>=49);double phi=sin(3.14159265358979323846*(.135-.055*o/7));
  double point=old/(2*phi*phi),hammer=.012-.001*o,normal=hammer*(point*n)/(hammer+point*n);
  for(int shift=0;shift<=4;shift++) {
   double s=shift/4.,contacts=0;for(int string=0;string<n;string++)contacts+=piano_contact_overlap(s,n,string);
   double reduced=hammer*(point*contacts)/(hammer+point*contacts),felt=1-.45*s*s*(3-2*s);
   double old_duration=pow(reduced/normal*n/(contacts*felt),1/(old_p+1));
   PianoContact current_contact=piano_soft_contact(midi,n,s);
   contact_error=fmax(contact_error,fabs(current_contact.duration_ratio/old_duration-1));
   assert(isfinite(current_contact.duration_ratio) && current_contact.impulse_ratio>0 && current_contact.impulse_ratio<=1+1e-12);
  }
 }
 assert(mass_error<.05);assert(felt_error<.005);assert(contact_error<.002);
 printf("radiation max error %.6f dB; derivative mismatch %.6f dB/octave; mass max %.4f%% RMS %.4f%%; felt max %.6f; contact duration max %.4f%%\\n",max_error,max_derivative_jump,100*mass_error,100*sqrt(mass_squared_error/8701),felt_error,100*contact_error);
}`);
  t.diagnostic(result.trim());
});

test('runtime stores global basis coefficients with no sampled-curve interpolation', () => {
  const model = readFileSync(new URL('../tools/grand-piano-wasm.c', import.meta.url), 'utf8');
  const mechanics = readFileSync(new URL('../tools/piano-mechanics.h', import.meta.url), 'utf8');
  const header = readFileSync(new URL('../tools/high-resolution-radiation-fit.h', import.meta.url), 'utf8');
  assert.doesNotMatch(model, /highres_band|position\[14\]|slope[01]|interpolate_curve/);
  assert.doesNotMatch(mechanics, /masses\[|floor\(|\blower\b|\bfraction\b/);
  assert.match(model, /piano_chebyshev\(target->highres_coefficients/);
  assert.match(header, /#define HIGHRES_SPECTRAL_TERMS 65/);
});
