#ifndef PIANO_MECHANICS_H
#define PIANO_MECHANICS_H

#include <math.h>

/* Reduced mechanics, with units and derivations in reports/PEDAL_PHYSICS.md.
 * These response times are voicing defaults, not measured human speed limits.
 * 4.7438645 is the root of (1 + x) exp(-x) = .05. */
#ifndef PIANO_SUSTAIN_RESPONSE_SECONDS
#define PIANO_SUSTAIN_RESPONSE_SECONDS .12
#endif
#ifndef PIANO_UNA_CORDA_RESPONSE_SECONDS
#define PIANO_UNA_CORDA_RESPONSE_SECONDS .16
#endif

typedef struct { double position, velocity, target, omega, retention; } PianoPedal;

static inline void piano_pedal_reset(PianoPedal *pedal, double seconds, double rate) {
 pedal->position = pedal->velocity = pedal->target = 0;
 pedal->omega = 4.743864518390579 / seconds;
 pedal->retention = exp(-pedal->omega / rate);
}

/* Exact zero-order-hold update of x'' + 2 omega x' + omega^2(x-u) = 0.
 * A new target preserves both position and velocity, including at reversals.
 * No block-size-dependent interpolation and no overshoot of physical stops. */
static inline void piano_pedal_step(PianoPedal *pedal, double dt) {
 double error = pedal->position - pedal->target;
 double c = pedal->velocity + pedal->omega * error;
 pedal->position = pedal->target + (error + c * dt) * pedal->retention;
 pedal->velocity = (pedal->velocity - pedal->omega * c * dt) * pedal->retention;
 if (pedal->position <= 0) { pedal->position = 0; pedal->velocity = fmax(0, pedal->velocity); }
 if (pedal->position >= 1) { pedal->position = 1; pedal->velocity = fmin(0, pedal->velocity); }
}

static inline double piano_contact_overlap(double shift, int count, int string) {
 if (count == 1 || string != count - 1) return 1;
 /* Overlap of the hammer edge with the outer wire, over the final third of
  * action shift. At full travel the wire is completely clear of the felt. */
 double overlap = fmin(1, fmax(0, (.95 - shift) / .3));
 return overlap * overlap * (3 - 2 * overlap);
}

typedef struct { double reduced_mass, contact_count, duration_ratio, impulse_ratio; } PianoContact;

/* Two-body reduction at the hammer contact. The point effective mass of the
 * first string mode is M/(2 sin^2(pi a)), a being the strike position / length.
 * Wood's Broadwood parameter table supplies per-string and hammer mass anchors.
 * Felt exponent follows measured C2/C4/C7 values (Hall & Askenfelt).
 * The 0.55 fresh-felt stiffness ratio and edge overlap are calibration choices. */
static inline PianoContact piano_soft_contact(double midi, int strings, double shift) {
 const double masses[8] = {.189,.073,.0307/2,.0117/3,.0053/3,.0024/3,.00115/3,.00054/3};
 double octave = fmin(7, fmax(0, (midi - 24)/12)); int lower = (int)fmin(6, floor(octave));
 double fraction = octave - lower, string_mass = exp(log(masses[lower]) + fraction * log(masses[lower+1]/masses[lower]));
 double hammer_mass = .012 - .001 * octave, a = .135 - .055 * octave / 7;
 double phi = sin(3.14159265358979323846 * a), point_mass = string_mass / (2 * phi * phi);
 double contacts = 0; for (int i=0;i<strings;++i) contacts += piano_contact_overlap(shift,strings,i);
 double normal_load = point_mass * strings, shifted_load = point_mass * contacts;
 double normal_mass = hammer_mass * normal_load / (hammer_mass + normal_load);
 double shifted_mass = hammer_mass * shifted_load / (hammer_mass + shifted_load);
 double p = 2.3 + .2*fmin(1,fmax(0,(midi-36)/24)) + .5*fmin(1,fmax(0,(midi-60)/36));
 double felt = 1 - .45 * shift * shift * (3 - 2 * shift), mass_ratio = shifted_mass / normal_mass;
 /* F=K delta^p -> T proportional to (mu/K)^(1/(p+1));
  * impulse J=2 mu v for the elastic reference. Any unchanged restitution
  * coefficient cancels from the ratio used by the calibrated source. */
 PianoContact result = {shifted_mass, contacts, pow(mass_ratio * strings / (contacts * felt), 1/(p+1)), mass_ratio};
 return result;
}

/* Exact exp(-gamma * 11^T * dt) in the nearly degenerate unison subspace.
 * Eigenvalues: exp(-N gamma dt) for collective motion, 1 for differential
 * motion. Thus coupling can excite an unstruck string but cannot add energy. */
static inline double piano_unison_share(int strings, double gamma, double dt) {
 return -expm1(-strings * gamma * dt) / strings;
}

#endif
