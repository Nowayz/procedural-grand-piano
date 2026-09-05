// Deliberately instrument a generated COPY: release C has no logging branches.
// This scanner handles this repository's scalar declarations, not arbitrary C.
// Source expressions and locations are saved so every experiment is reviewable.
export const zeroTerms = new Set(`highres_color_db localized_termination_loss polarization_amplitude fast_amplitude slow_amplitude cents phase polarization_cents unison_inequality middle_low_mode_loss middle_body_sustain bass_presence_decay low_order_treble_tail treble_high_partial_tail late_treble_tail soft_contact_coupling slow_body_fraction attack_drive bridge_presence_shape bridge_antiresonance_shape middle_body_shape bass_high_partial_transition skew width_cents`.split(/\s+/));
export const unityTerms = new Set(`strike_coupling felt_filter velocity_brightening radiation mid_bridge_coupling treble_mode_damping register_radiation_gain bridge_presence_gain bridge_antiresonance middle_body_level bass_overtone_radiation weak_bass_fundamental weak_bass_second bass_high_partial_radiation bass_presence_radiation vertical_second_partial_boost bass_damper_node damper_node_coupling damper_partial_slope mode_shape impact_radiation mid_plate_scale low_body_drive bass_high_plate_scale lowest_plate_coupling felt_brightness impact_strength bass_compensation bass_trim diffuse_low_body_scale bridge_presence mass_ratio felt`.split(/\s+/));
const zeroReturns = new Set(`bridge_participation_db register_radiation_db radiation_velocity_db level_residual_db bridge_mobility_db radiation_residual_db spectral_fit_db impact_spectral_fit_db output_eq_residual_db radiation_loss_db_per_second modal_drive_correction_db modal_loss_correction_db_per_second string_inharmonicity unison_phase filter_soundboard filter_impact_soundboard filter_duplex_modes piano_unison_share`.split(/\s+/));
const unityReturns = new Set(['piano_contact_overlap']);

function matching(text, start, open, close) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    if (text[i] === close && --depth === 0) return i;
  }
  throw new Error(`Unbalanced ${open} at ${start}`);
}

export function instrument(source, file, probes) {
  const mask = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"/g, s => s.replace(/[^\n]/g, ' '));
  const functions = [...mask.matchAll(/\b(?:double|void|int|uint32_t|PianoContact)\s+(\w+)\([^;{}]*\)\s*\{/g)].map(m => {
    const start = m.index + m[0].lastIndexOf('{');
    return { name: m[1], start, end: matching(mask, start, '{', '}'), scalar: m[0].startsWith('double ') };
  });
  const edits = [];
  function wrap(start, end, name, neutral, kind) {
    const fn = functions.find(f => start > f.start && start < f.end);
    if (!fn) return;
    if (fn.name === 'piano_soft_contact' && name === 'felt') neutral = 1;
    if (kind === 'return' && Number(source.slice(start,end).trim()) === neutral) neutral = null;
    const id = probes.length;
    probes.push({ id, name: `${fn.name}.${name}`, file, line: source.slice(0, start).split('\n').length, expression: source.slice(start, end), neutral: neutral ?? null, kind });
    edits.push({start,end,text:`piano_debug_tap(${id}, (${source.slice(start,end)}))`});
  }
  for (const m of mask.matchAll(/\bdouble\s+(\w+)\s*=/g)) {
    let name = m[1], start = m.index + m[0].length;
    while (true) {
      let end = start, depth = 0;
      for (; end < mask.length; end++) {
        const c = mask[end];
        if ('([{'.includes(c)) depth++;
        if (')]}'.includes(c)) depth--;
        if (depth === 0 && (c === ',' || c === ';')) break;
      }
      wrap(start, end, name, zeroTerms.has(name) ? 0 : unityTerms.has(name) ? 1 : null, 'initializer');
      if (mask[end] !== ',') break;
      const next = /^\s*(\w+)\s*=/.exec(mask.slice(end + 1));
      if (!next) break;
      name = next[1]; start = end + 1 + next[0].length;
    }
  }
  for (const fn of functions.filter(f => f.scalar)) {
    const body = mask.slice(fn.start, fn.end);
    for (const m of body.matchAll(/\breturn\s+([^;]+);/g)) {
      const start = fn.start + m.index + m[0].indexOf(m[1]);
      wrap(start, start + m[1].length, 'return', zeroReturns.has(fn.name) ? 0 : unityReturns.has(fn.name) ? 1 : null, 'return');
    }
  }
  edits.sort((a,b) => b.start-a.start);
  let last = source.length;
  for (const e of edits) {
    if (e.end > last) throw new Error(`Overlapping instrumentation in ${file}`);
    source = source.slice(0,e.start)+e.text+source.slice(e.end); last=e.start;
  }
  return source;
}

export function debugHeader(probes) {
  return `#ifndef PIANO_DEBUG_H\n#define PIANO_DEBUG_H
#include <math.h>
#include <stdint.h>
#include <string.h>
#define PIANO_DEBUG_COUNT ${probes.length}
/* count, minimum, maximum, sumSquares, last, sum, nonfinite */
static double piano_debug_stats[PIANO_DEBUG_COUNT][7];
static unsigned char piano_debug_disabled[PIANO_DEBUG_COUNT];
static double piano_debug_hits[PIANO_DEBUG_COUNT];
static int piano_debug_logging;
static const double piano_debug_neutral[PIANO_DEBUG_COUNT] = {${probes.map(p=>p.neutral??0).join(',')}};
static double piano_debug_tap(int id, double value) {
 if (piano_debug_logging) {
  double *s = piano_debug_stats[id];
  if (!isfinite(value)) s[6] += 1;
  else { if (!s[0]) s[1] = s[2] = value; s[0] += 1; s[1] = fmin(s[1], value); s[2] = fmax(s[2], value); s[3] += value*value; s[4] = value; s[5] += value; }
 }
 if (piano_debug_disabled[id]) { piano_debug_hits[id] += 1; return piano_debug_neutral[id]; }
 return value;
}
__attribute__((export_name("debug_stats_ptr"))) uintptr_t debug_stats_ptr(void) { return (uintptr_t)piano_debug_stats; }
__attribute__((export_name("debug_logging"))) void debug_logging(int enabled) { piano_debug_logging = enabled; memset(piano_debug_stats, 0, sizeof(piano_debug_stats)); }
__attribute__((export_name("debug_clear"))) void debug_clear(void) { memset(piano_debug_disabled, 0, sizeof(piano_debug_disabled)); memset(piano_debug_hits, 0, sizeof(piano_debug_hits)); }
__attribute__((export_name("debug_hits"))) double debug_hits(int id) { return id >= 0 && id < PIANO_DEBUG_COUNT ? piano_debug_hits[id] : 0; }
__attribute__((export_name("debug_disable"))) int debug_disable(int id) { if (id < 0 || id >= PIANO_DEBUG_COUNT) return -1; piano_debug_disabled[id] = 1; return 0; }
#endif\n`;
}
