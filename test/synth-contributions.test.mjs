import assert from 'node:assert/strict';
import test from 'node:test';
import { difference } from '../tools/audit-synth-contributions.mjs';
import { instrument } from '../tools/synth-debug-instrumentation.mjs';

test('contribution measurement catches a short stereo-only change without normalization',()=>{
  const original=new Float32Array(3*44100),changed=original.slice();
  original[0]=changed[0]=.8;
  changed[3*100+2]=.0001;
  const d=difference(original,changed,3,44100);
  assert.equal(d.changedSamples,1);
  assert.ok(d.peak>.000099);
  assert.ok(Math.abs(d.max20msRms-d.peak/Math.sqrt(882))<1e-12);
  assert.throws(()=>difference(original,new Float32Array(1)),/Length mismatch/);
  changed[20]=NaN;
  assert.throws(()=>difference(original,changed,3,44100),/Nonfinite/);
});

test('instrumentation preserves expressions and does not treat identity returns as removable',()=>{
  const probes=[];
  const source='static double unison_phase(int count) {\n if (count == 1) return 0;\n double phase = atan2(1, 2), cents = (1 + (2 * 3));\n return phase + cents;\n}\n';
  const copy=instrument(source,'example.c',probes);
  assert.equal(probes.length,4);
  assert.equal(probes.find(p=>p.expression==='0').neutral,null);
  assert.match(copy,/atan2\(1, 2\)/);
  assert.equal(probes.find(p=>p.name==='unison_phase.cents').expression.trim(),'(1 + (2 * 3))');
  assert.equal(probes.find(p=>p.name==='unison_phase.phase').neutral,0);
});
