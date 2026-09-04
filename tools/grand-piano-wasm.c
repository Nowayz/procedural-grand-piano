#include <math.h>
#include <stdint.h>
#include <string.h>
#include <wasm_simd128.h>
#include "high-resolution-radiation-fit.h"
#include "piano-mechanics.h"

#define SAMPLE_RATE 44100
#define MAX_SAMPLES 1323000
#define MAX_VOICES 256
#define BLOCK_SIZE 128
#define EVENT_COUNT 256
#define MAX_MODES 384
#define MODE_ROWS 23
#define IMPACT_COUNT 22
#define MAX_FORCE 512
#define SOUND_FILTER_COUNT 10
#define NOISE_FILTER_COUNT 14
#define DENSE_VOICE_THRESHOLD 4
#define SYMPATHETIC_BRIDGE_GAIN .002
/* The highest soundboard quadrature is 4.3 kHz; higher string modes still ring,
 * but cannot exchange meaningful energy through this shared bridge model. */
#define SHARED_BRIDGE_BAND_LIMIT 4300
#define FORCE_O 0
#define SOUND_O MAX_FORCE
#define NOISE_O (SOUND_O + SOUND_FILTER_COUNT * 4)
#define STATE_COUNT (NOISE_O + NOISE_FILTER_COUNT * 4)
#define PI 3.14159265358979323846264338327950288
#define TWO_PI (2 * PI)
#define FIRST_UNDAMPED_MIDI 91
#define DEFAULT_RELEASE_SPEED (64.0 / 127)
#define MINIMUM_DAMPER_CONTACT_SECONDS .05
#define REGULATED_DAMPER_STAGE_SECONDS .1
#define DAMPER_RETIREMENT_DB 80
#define RELEASE_QUIET_SECONDS .02
#define FULL_SCALE_SOUND_PRESSURE_DB_SPL 100
#define HEARING_THRESHOLD_DB_SPL 0
#define INAUDIBLE_SECONDS .12
#define REALTIME_BUS_LIMIT .9
#define REALTIME_BUS_LIMIT_RELEASE_SECONDS .05

/* Compile-time fit controls let the development optimizer evaluate the reduced
 * physical model without editing this source between renders. Release builds
 * use these measured defaults. */
#ifndef PIANO_DRIVE_BOUND
#define PIANO_DRIVE_BOUND 10
#endif
#ifndef PIANO_DRIVE_WIDTH
#define PIANO_DRIVE_WIDTH 16
#endif
#ifndef PIANO_LOSS_BOUND
#define PIANO_LOSS_BOUND 6
#endif
#ifndef PIANO_LOSS_WIDTH
#define PIANO_LOSS_WIDTH 6
#endif
#ifndef PIANO_DIFFUSE_BODY_GAIN
#define PIANO_DIFFUSE_BODY_GAIN .03
#endif
#ifndef PIANO_DIFFUSE_PLATE_GAIN
#define PIANO_DIFFUSE_PLATE_GAIN .002
#endif
#ifndef PIANO_STRING_MIX_BASE
#define PIANO_STRING_MIX_BASE .95
#endif
#ifndef PIANO_STRING_MIX_TREBLE
#define PIANO_STRING_MIX_TREBLE .13
#endif
#ifndef PIANO_SOUNDBOARD_GAIN
#define PIANO_SOUNDBOARD_GAIN 3
#endif
#ifndef PIANO_IMPACT_GAIN
#define PIANO_IMPACT_GAIN 1.35
#endif
#ifndef PIANO_HAMMER_GAIN
#define PIANO_HAMMER_GAIN 1
#endif
#ifndef PIANO_BRIDGE_PARTICIPATION_BOUND
#define PIANO_BRIDGE_PARTICIPATION_BOUND 6
#endif
#ifndef PIANO_BRIDGE_PARTICIPATION_WIDTH
#define PIANO_BRIDGE_PARTICIPATION_WIDTH 3
#endif
#ifndef PIANO_RADIATION_FLOOR
#define PIANO_RADIATION_FLOOR .14
#endif
#ifndef PIANO_RADIATION_CORNER
#define PIANO_RADIATION_CORNER 150
#endif
#ifndef PIANO_HIGH_LOSS_DB
#define PIANO_HIGH_LOSS_DB 6
#endif
#ifndef PIANO_HIGH_LOSS_CORNER
#define PIANO_HIGH_LOSS_CORNER 4000
#endif
#ifndef PIANO_RADIATION_LOSS_SCALE
#define PIANO_RADIATION_LOSS_SCALE .25
#endif
#ifndef PIANO_OUTPUT_EQ_SCALE
#define PIANO_OUTPUT_EQ_SCALE .3
#endif
#ifndef PIANO_OUTPUT_EQ_ENABLED
#define PIANO_OUTPUT_EQ_ENABLED 1
#endif
#ifndef PIANO_IMPACT_SPECTRAL_SCALE
#define PIANO_IMPACT_SPECTRAL_SCALE .1
#endif
#ifndef PIANO_TREBLE_STIFFNESS_SCALE
#define PIANO_TREBLE_STIFFNESS_SCALE .5
#endif
#ifndef PIANO_C6_SECOND_LOSS_DB_PER_SECOND
#define PIANO_C6_SECOND_LOSS_DB_PER_SECOND 12.5
#endif
#ifndef PIANO_UNISON_WIDTH_SCALE
#define PIANO_UNISON_WIDTH_SCALE 1
#endif
#ifndef PIANO_UNISON_PHASE_SCALE
#define PIANO_UNISON_PHASE_SCALE .12
#endif
#ifndef PIANO_HIGHRES_RADIATION_SCALE
#define PIANO_HIGHRES_RADIATION_SCALE 1
#endif
#ifndef PIANO_HIGHRES_IMPACT_SCALE
#define PIANO_HIGHRES_IMPACT_SCALE .6
#endif
#ifndef PIANO_IMPACT_PRESENCE_GAIN
#define PIANO_IMPACT_PRESENCE_GAIN 31
#endif
#ifndef PIANO_IMPACT_PRESENCE_HZ
#define PIANO_IMPACT_PRESENCE_HZ 2350
#endif
#ifndef PIANO_IMPACT_LOW_WIDTH
#define PIANO_IMPACT_LOW_WIDTH .13
#endif
#ifndef PIANO_IMPACT_HIGH_WIDTH
#define PIANO_IMPACT_HIGH_WIDTH .17
#endif
#ifndef PIANO_IMPACT_SLOPE
#define PIANO_IMPACT_SLOPE -.42
#endif
#ifndef PIANO_HAMMER_FELT_GAIN
#define PIANO_HAMMER_FELT_GAIN 1
#endif
#ifndef PIANO_HAMMER_PRESENCE_GAIN
#define PIANO_HAMMER_PRESENCE_GAIN 1
#endif
#ifndef PIANO_HAMMER_AIR_GAIN
#define PIANO_HAMMER_AIR_GAIN 1
#endif
#ifndef PIANO_HAMMER_BODY_GAIN
#define PIANO_HAMMER_BODY_GAIN 1
#endif
#ifndef PIANO_RADIATION_001
#define PIANO_RADIATION_001 -.865773809851
#endif
#ifndef PIANO_RADIATION_011
#define PIANO_RADIATION_011 2.220563442064
#endif
#ifndef PIANO_RADIATION_021
#define PIANO_RADIATION_021 2.08059548476
#endif
#ifndef PIANO_RADIATION_101
#define PIANO_RADIATION_101 -6.70962491042
#endif
#ifndef PIANO_RADIATION_111
#define PIANO_RADIATION_111 -2.425709313649
#endif
#ifndef PIANO_RADIATION_201
#define PIANO_RADIATION_201 6.9945502927
#endif
#ifndef PIANO_RADIATION_002
#define PIANO_RADIATION_002 1.293606491247
#endif
#ifndef PIANO_RADIATION_012
#define PIANO_RADIATION_012 -1.450529544093
#endif
#ifndef PIANO_RADIATION_102
#define PIANO_RADIATION_102 5.22609071367
#endif
#ifndef PIANO_RADIATION_003
#define PIANO_RADIATION_003 -1.79719518807
#endif
typedef struct {
 double state[STATE_COUNT], modes[MODE_ROWS][MAX_MODES], impact_state[17][IMPACT_COUNT], duplex[2][5], hammer_gains[10], radiation_state[3], radiation_step[3], radiation_gain[4], radiation_pole[4], output_eq_state[6], output_eq_step[6], output_eq_gain[7], output_eq_weight[6], highres_band[14], output_eq_normalization, highres_anchor;
 double phase_drive[3][MAX_MODES];
 double unison_inverse[MAX_MODES];
 double contact_weights[3], contact_gains[3], unison_weights[MAX_MODES], unison_shares[MAX_MODES], hammer_impulse, hammer_contact_seconds;
 int string_count;
 uint8_t mode_delays[2][MAX_MODES], piano_key, active, released, key_down, key_motion_controlled, mode_gains_unity;
 uint32_t mode_cutoff[MAX_MODES], fast_mode_cutoff[MAX_MODES], polarization_mode_cutoff[MAX_MODES], impact_fast_cutoff[IMPACT_COUNT], impact_slow_cutoff[IMPACT_COUNT], impact_attack_cutoff[IMPACT_COUNT], note_id, age, release_at, damper_at, damper_contact_at, release_end_at, noise_state, damper_noise_state, body_noise_state, quiet_samples, inaudible_samples, inaudible_window, release_quiet_samples, bridge_settle_samples;
 uint64_t serial;
 int mode_count, active_mode_count, active_fast_mode_count, active_polarization_mode_count, coupled_mode_count, impact_fast_count, impact_body_count, impact_attack_count, hammer_samples, release_samples, damper_stage_samples, damper_settle_samples, damper_noise_samples, start_fade_samples, hammer_noise_samples, strike_delay_samples;
 double contact_speed;
 double sample_rate, frequency, strike_velocity, hammer_speed, release_speed, midi, reg, velocity_gain, hammer_lowpass_step, hammer_lowpass, mechanical_lowpass, damper_lowpass, mechanical_lowpass_step, damper_lowpass_step, damper_noise_gain, body_damper_free_pole, body_damper_regulated_pole, diffuse_body_gain, output_envelope, output_peak, release_envelope_pole, inaudible_energy, inaudible_bridge_energy, inaudible_threshold_energy, felt_presence_radiation, felt_air_radiation, thump_frequency, body_rise_pole, body_tail_pole, plate_rise_pole, plate_tail_pole, felt_rise_pole, felt_tail_pole, presence_rise_pole, presence_tail_pole, early_rise_pole, early_tail_pole, body_grain_tail_pole, thump_tail_pole, thump_rise_pole, damper_rise_pole, damper_tail_pole, diffuse_plate_register, upper_bridge_plate, diffuse_low_body_scale, string_mix, previous_input, dc_blocker, bridge_output, previous_sympathetic_force, key_position, stereo_lowpass, stereo_lowpass_step, stereo_position, radiation_lobe, stereo_side, body_rise_value, body_tail_value, plate_rise_value, plate_tail_value, felt_rise_value, felt_tail_value, presence_rise_value, presence_tail_value, early_rise_value, early_tail_value, body_grain_tail_value, thump_tail_value, thump_rise_value, damper_rise_value, damper_tail_value, dc_pole;
} Voice;

typedef struct { uint32_t type, note_id, offset, reserved; double value, velocity; } Event;

static float output[MAX_SAMPLES];
static float realtime_output[BLOCK_SIZE];
static float realtime_output_left[BLOCK_SIZE], realtime_output_right[BLOCK_SIZE];
static double realtime_mix[BLOCK_SIZE], realtime_side[BLOCK_SIZE];
static Voice offline_voice, strike_template, voices[MAX_VOICES], *voice = &offline_voice;
static Event events[EVENT_COUNT];
/* Structure-of-arrays layout lets one SIMD lane pair advance two independent
 * quadrature sections without changing the underlying transfer function. */
static double soundboard_filters[6][SOUND_FILTER_COUNT];
static double noise_filters[NOISE_FILTER_COUNT][9];
static int filters_ready;
static double filters_rate;
static double realtime_rate = SAMPLE_RATE;
static uint32_t queued_events, active_voices, realtime_scan_limit, realtime_voice_limit = MAX_VOICES;
static uint64_t next_serial;
static PianoPedal sustain_pedal, soft_pedal;
static double sustain_lift, una_corda_position, sympathetic_bridge_bus, realtime_limiter_gain, realtime_limiter_release_step, left_microphone_state, right_microphone_state, left_microphone_step, right_microphone_step;

#define state (voice->state)
#define modes (voice->modes)
#define phase_drive (voice->phase_drive)
#define mode_delays (voice->mode_delays)
#define mode_cutoff (voice->mode_cutoff)
#define fast_cutoffs (voice->fast_mode_cutoff)
#define polarization_cutoffs (voice->polarization_mode_cutoff)
#define impact_state (voice->impact_state)
#define RATE (voice->sample_rate)

static inline double clamp(double value, double minimum, double maximum) { return fmin(maximum, fmax(minimum, value)); }
static inline uint8_t key_for_frequency(double frequency) { return (uint8_t)clamp(round(69 + 12 * log2(clamp(frequency, 27.5, 4186.009044809578) / 440)), 21, 108); }
static inline double lerp(double a, double b, double amount) { return a + (b - a) * amount; }
static inline double smoothstep(double value) { return value * value * (3 - 2 * value); }
static inline double transition(double value) { return smoothstep(clamp(value, 0, 1)); }
static inline double bell(double value, double center, double width, double power) { return exp(-pow((value - center) / width, power)); }
/*
 * Piano Profile Note On velocity is logarithmic in hammer impact speed.  The
 * recommended 3% slowest-sounding speed gives the inverse receiver mapping
 * below.  The unit-area hammer pulse magnitude is then linear in that speed;
 * felt nonlinearity belongs in contact duration and spectral shape instead.
 */
static inline double piano_velocity_to_hammer_speed(double velocity) {
 velocity = clamp(velocity, 0, 1);
 return velocity > 0 ? .03 * pow(1 / .03, velocity) : 0;
}
static inline double hammer_speed_gain(double normalized_speed) { return clamp(normalized_speed, 0, 1); }
static inline double decay(double sample, double seconds) { return exp(-sample / (seconds * RATE)); }
static inline uint32_t decay_samples(double amplitude, double pole) { return amplitude > 1e-6 ? (uint32_t)ceil(log(1e-6 / amplitude) / log(pole)) : 0; }
static inline double hearing_threshold_amplitude(void) { return pow(10, (HEARING_THRESHOLD_DB_SPL - FULL_SCALE_SOUND_PRESSURE_DB_SPL) / 20.0); }
static inline double saturate(double input) {
 /* Ninth-order tanh series: absolute error stays below 1.1e-12 in this branch. */
 double magnitude = fabs(input); if (magnitude >= .125) return tanh(input);
 double squared = input * input;
 return input * (1 + squared * (-1.0 / 3 + squared * (2.0 / 15 + squared * (-17.0 / 315 + squared * (62.0 / 2835)))));
}
/*
 * Normalized pedal travel is mapped to normalized felt/string contact.  Real
 * part-pedaling occupies a narrow height interval: below it the damper still
 * bears fully on the string, above it the felt is clear, and within it the
 * interaction loss falls nonlinearly.  Boolean pedal input still lands at the
 * exact endpoints.
 */
static inline double damper_contact(double lift) { return 1 - transition((clamp(lift, 0, 1) - .2) / .6); }
static inline double damper_interaction_strength(Voice *target) {
 double lift = clamp(sustain_lift, 0, 1), contact = damper_contact(lift); if (contact == 0 || lift <= .2) return contact;
 /* At a partial lift, felt contact ceases after string displacement falls
    below the remaining gap, leaving the measured final free-vibration stage. */
 double part_pedal = transition((lift - .2) / .6), separation_level = .2 * part_pedal * part_pedal * part_pedal, relative_motion = target->output_peak > 1e-12 ? target->output_envelope / target->output_peak : 1, interaction_width = fmax(.002, .75 * separation_level); return contact * transition((relative_motion - separation_level) / interaction_width);
}

/*
 * Reduced soundboard mobility model.  The ten sections are quadrature points
 * on a continuous log-frequency response, not measured resonances.  The gain
 * is a low-frequency radiation-efficiency term times a smooth mean-mobility
 * loss; Q grows with frequency as the response changes from whole-board plate
 * motion toward increasingly local inter-rib motion.
 */
static void soundboard_profile(double mode, double *frequency, double *q, double *gain) {
 double u = mode / (SOUND_FILTER_COUNT - 1), low = 72, high = 4300;
 *frequency = low * exp(log(high / low) * u);
 *q = 1.25 + 3.15 * pow(u, 1.18);
 double x = log(*frequency / 116), frequency_squared = *frequency * *frequency, radiation_efficiency = frequency_squared / (frequency_squared + 65 * 65);
 *gain = .26 * radiation_efficiency * exp(x * (-.3 - .11 * x));
}

/*
 * Sparse quadrature of a plate-mobility modal sum.  The power warp represents
 * falling retained modal density above the approximately 1.1 kHz inter-rib
 * transition.  Loss is expressed as a continuous modal time constant.  The
 * alternating bridge participation sign and the smooth 2.5 kHz mobility lobe
 * replace the former individually voiced mode gains.
 */
static void impact_profile(double mode, double *frequency, double *decay_seconds, double *gain) {
 double u = mode / (IMPACT_COUNT - 1);
 *frequency = 58 + 585.1 * u + 14158.3 * pow(u, 3.277);
 *decay_seconds = .035 * pow(*frequency / 58, -.31);
 double x = log(*frequency / PIANO_IMPACT_PRESENCE_HZ), width = x < 0 ? PIANO_IMPACT_LOW_WIDTH : PIANO_IMPACT_HIGH_WIDTH, normalized_x = x / width, bridge_presence = 1 + PIANO_IMPACT_PRESENCE_GAIN * exp(-.5 * normalized_x * normalized_x);
 double participation = (mode - 2 * floor(mode * .5)) < 1 ? 1 : -1;
 *gain = participation * .065 * pow(*frequency / 58, PIANO_IMPACT_SLOPE) * bridge_presence;
}

static double bridge_participation_db(double midi, double frequency) {
 static const double fit[24] = {-.6036617916, 1.379286469, -3.563892268, 4.835472938, .2002054523, -.1005434456, 1.109189075, 3.107339963, .3526604928, -.2304112358, .6952440567, 2.452720655, .3146973067, -.2827740114, -2.330281857, .6545942256, -.1067767148, -.1230558964, -2.567189397, 1.679017489, .01049464169, -.815879291, -2.071763005, .9476143586};
 double phase = TWO_PI * (midi - 21) / 87, z = log(frequency / 560) / log(800), fitted = 0; int coefficient = 0;
 for (int harmonic = 1; harmonic <= 6; harmonic += 1) { double sine = sin(harmonic * phase), cosine = cos(harmonic * phase); fitted += fit[coefficient] * sine + fit[coefficient + 1] * cosine + fit[coefficient + 2] * z * sine + fit[coefficient + 3] * z * cosine; coefficient += 4; }
 return PIANO_BRIDGE_PARTICIPATION_BOUND * tanh(fitted / PIANO_BRIDGE_PARTICIPATION_WIDTH);
}

static double chebyshev6(double x, double c0, double c1, double c2, double c3, double c4, double c5, double c6) {
 double t0 = 1, t1 = x, t2 = 2 * x * t1 - t0, t3 = 2 * x * t2 - t1, t4 = 2 * x * t3 - t2, t5 = 2 * x * t4 - t3, t6 = 2 * x * t5 - t4;
 return c0 * t0 + c1 * t1 + c2 * t2 + c3 * t3 + c4 * t4 + c5 * t5 + c6 * t6;
}

static double string_inharmonicity(double midi) {
 double scale_law = exp(-.07643470205 * midi - 6.682289773) + exp(.07965147182 * midi - 12.91563584), measured_top_string = .001;
 return lerp(scale_law, measured_top_string, PIANO_TREBLE_STIFFNESS_SCALE * transition((midi - 81) / 18));
}

static double register_radiation_db(double midi) {
 double x = (midi - 64.5) / 43.5;
 return chebyshev6(x, .695996446059, 3.01732560524, 1.92185680683, -1.29980794626, -1.3392354863, -.138568288622, 1.39667397914);
}

/* Smooth hammer-speed/soundboard transfer measured over the complete direct
 * recording grid.  This is one differentiable surface, not a note or layer
 * lookup; its low order also keeps unsampled keys interpolative. */
static double radiation_velocity_db(double midi, double velocity) {
 double x = (midi - 64.5) / 43.5, y = 2 * velocity - 1, x2 = 2 * x * x - 1, x3 = x * (4 * x * x - 3), x4 = 8 * x * x * x * x - 8 * x * x + 1, y2 = 2 * y * y - 1, y3 = y * (4 * y * y - 3);
 return 6.248184185678 - 1.897071723824 * y - 2.41316649326 * y2 + 1.390586898341 * y3 + x * (-1.77619931434 + 2.97944222867 * y - .760181884984 * y2 + .282636225359 * y3) + x2 * (-3.65319351076 + 2.94514237354 * y + .526273931125 * y2 + .288136489482 * y3) + x3 * (1.58025682358 - .834528268921 * y - .161578075978 * y2 + .41162141597 * y3) + x4 * (.044775433122 - .07531739814 * y - .151802670391 * y2 + .117385729254 * y3);
}

/* Robustly fitted residual level over all 480 direct recordings.  Degree 6x4
 * is the lowest smooth surface that fixes the measured corner behavior while
 * retaining good held-out interpolation between the sampled pitches. */
static double level_residual_db(double midi, double velocity) {
 static const double fit[35] = {-.218043300947,-1.43762251835,.811678261252,-.373711962746,.336414662798,2.26237788313,.263068240018,.669625236248,-.357628710326,.580211333518,-.752310251709,-1.80784399889,.506869579507,-.170374833803,-.120022873911,1.52271242327,.692352858991,-.101637915166,.0679637658908,-.0949204507619,-.357672436363,-1.20615853731,.321435574396,-.0847507917545,-.034815957977,2.04336995389,.441493567095,-.479518183215,.470181062026,-.20051898526,-.0170556494807,-.453212544332,.0992561754444,-.0278578212251,-.053165148528};
 double x = (midi - 64.5) / 43.5, y = 2 * velocity - 1, tx[7] = {1,x}, ty[5] = {1,y}, result = 0; int coefficient = 0;
 for (int degree = 2; degree < 7; degree += 1) tx[degree] = 2 * x * tx[degree - 1] - tx[degree - 2]; for (int degree = 2; degree < 5; degree += 1) ty[degree] = 2 * y * ty[degree - 1] - ty[degree - 2];
 for (int i = 0; i < 7; i += 1) for (int j = 0; j < 5; j += 1) result += fit[coefficient++] * tx[i] * ty[j];
 return result;
}

static double bridge_mobility_db(double frequency) {
 double x = .3141612258263221 * log(frequency / 27.5) - 1;
 return chebyshev6(x, -.692572571189, 1.81014895596, -.465970769325, -.0960572460663, -1.22589800647, -.625141587716, 1.32942562148);
}

/* A low-order mobility/radiation residual over log frequency, string scale,
 * and hammer speed. Subtracting its fundamental value preserves the physical
 * string's level while changing only its continuous overtone transfer. */
static double radiation_residual_db(double midi, double velocity, double frequency, double fundamental) {
 double x = (midi - 64.5) / 43.5, y = 2 * velocity - 1, f = .3141612258263221 * log(frequency / 27.5) - 1, f0 = .3141612258263221 * log(fundamental / 27.5) - 1;
 double x2 = 2 * x * x - 1, y2 = 2 * y * y - 1, df1 = f - f0, df2 = 2 * (f * f - f0 * f0), df3 = 4 * (f * f * f - f0 * f0 * f0) - 3 * df1;
 return df1 * (PIANO_RADIATION_001 + PIANO_RADIATION_011 * y + PIANO_RADIATION_021 * y2 + PIANO_RADIATION_101 * x + PIANO_RADIATION_111 * x * y + PIANO_RADIATION_201 * x2) + df2 * (PIANO_RADIATION_002 + PIANO_RADIATION_012 * y + PIANO_RADIATION_102 * x) + PIANO_RADIATION_003 * df3;
}

static double spectral_fit_db(double midi, double velocity, double frequency) {
 static const double fit[31] = {8.43220904753,-9.3945821035,3.44382039286,-19.7091640916,4.22445431725,.61918037969,13.7917492392,-5.04377016359,-.178924416104,-3.85040378054,-3.62946223533,3.55110302984,9.66937572631,-5.71286459638,3.56062997785,-11.602492383,4.36614287143,-1.88127783648,6.72269909939,.994520217489,-2.10928490452,.370444304304,-3.51202204264,1.98525899008,-7.49573010169,-1.23290324608,4.02222068873,.953104564761,-.9173304702,-2.02922034375,-.0315250733533};
 double x = (midi - 64.5) / 43.5, y = 2 * velocity - 1, f = .3141612258263221 * log(frequency / 27.5) - 1, tx[5] = {1,x}, ty[3] = {1,y}, tf[6] = {1,f}, result = 0; int coefficient = 0;
 for (int degree = 2; degree <= 4; degree += 1) tx[degree] = 2 * x * tx[degree - 1] - tx[degree - 2]; ty[2] = 2 * y * y - 1; for (int degree = 2; degree <= 5; degree += 1) tf[degree] = 2 * f * tf[degree - 1] - tf[degree - 2];
 for (int k = 1; k <= 5; k += 1) for (int i = 0; i <= 4; i += 1) for (int j = 0; j <= 2; j += 1) if (i + j + k <= 5) result += fit[coefficient++] * tx[i] * ty[j] * tf[k];
 return result;
}

static double impact_spectral_fit_db(double midi, double velocity, double frequency) {
 static const double fit[31] = {-3.56715819007,-4.29904244056,6.11795885787,9.81179221642,-4.51852480715,-.337028342648,1.0928540061,-1.88005657506,-.121002559933,-.735230070889,-4.01456415521,1.21107109445,-3.46904715303,-1.78750249044,4.82916254443,7.79342617791,-.952390340725,-1.51747950967,-2.47139570245,.210077268446,1.23617971515,-4.01604798077,-.262260130188,2.51316885691,5.46860642697,-1.18814846145,-3.75041653262,-1.44322233876,.240218942382,3.71772541299,-1.26671420996};
 double x = (midi - 64.5) / 43.5, y = 2 * velocity - 1, f = .3141612258263221 * log(frequency / 27.5) - 1, tx[5] = {1,x}, ty[3] = {1,y}, tf[6] = {1,f}, result = 0; int coefficient = 0;
 for (int degree = 2; degree <= 4; degree += 1) tx[degree] = 2 * x * tx[degree - 1] - tx[degree - 2]; ty[2] = 2 * y * y - 1; for (int degree = 2; degree <= 5; degree += 1) tf[degree] = 2 * f * tf[degree - 1] - tf[degree - 2];
 for (int k = 1; k <= 5; k += 1) for (int i = 0; i <= 4; i += 1) for (int j = 0; j <= 2; j += 1) if (i + j + k <= 5) result += fit[coefficient++] * tx[i] * ty[j] * tf[k];
 return result;
}

static double output_eq_response(double frequency, double sample_rate, const double *steps, const double *gains) {
 double omega = TWO_PI * frequency / sample_rate, real = gains[6], imaginary = 0;
 for (int index = 0; index < 6; index += 1) { double pole = 1 - steps[index], denominator_real = 1 - pole * cos(omega), denominator_imaginary = pole * sin(omega), scale = steps[index] / (denominator_real * denominator_real + denominator_imaginary * denominator_imaginary), difference = gains[index] - gains[index + 1]; real += difference * scale * denominator_real; imaginary -= difference * scale * denominator_imaginary; }
 return hypot(real, imaginary);
}

static double output_eq_residual_db(double midi, double velocity, double frequency, double fundamental) {
 double x = (midi - 64.5) / 43.5, y = 2 * velocity - 1, f = .3141612258263221 * log(frequency / 27.5) - 1, f0 = .3141612258263221 * log(fundamental / 27.5) - 1, x2 = 2 * x * x - 1, df1 = f - f0, df2 = 2 * (f * f - f0 * f0);
 return df1 * (-2 * y - .25 * x + x2) - .25 * x * df2;
}

static double highres_radiation_db(Voice *target, double frequency) {
 static const double position[14] = {.0405683813627,.868244295669,1.52920834311,2.20153242881,2.86249647625,3.52346052369,4.19017239056,4.851136438,5.52346052369,6.18442457114,6.84538861858,7.51210048544,8.17306453289,8.84538861858}; double x = log2(clamp(frequency, 28.2842712475, 12649.1106407) / 27.5); int index = 0; while (index < 12 && x > position[index + 1]) index += 1; double x0 = position[index], x1 = position[index + 1], width = x1 - x0, amount = clamp((x - x0) / width, 0, 1), amount2 = amount * amount, amount3 = amount2 * amount, y0 = target->highres_band[index], y1 = target->highres_band[index + 1], slope0 = index ? (target->highres_band[index + 1] - target->highres_band[index - 1]) / (position[index + 1] - position[index - 1]) : (y1 - y0) / width, slope1 = index < 12 ? (target->highres_band[index + 2] - target->highres_band[index]) / (position[index + 2] - position[index]) : (y1 - y0) / width;
 return (2 * amount3 - 3 * amount2 + 1) * y0 + (amount3 - 2 * amount2 + amount) * width * slope0 + (-2 * amount3 + 3 * amount2) * y1 + (amount3 - amount2) * width * slope1;
}

static void initialize_highres_radiation(Voice *target) {
 if (PIANO_HIGHRES_RADIATION_SCALE == 0) return; double x = (target->midi - 64.5) / 43.5, y = 2 * target->strike_velocity - 1, tx[15] = {1,x}, ty[8] = {1,y}, latent[HIGHRES_RANK];
 for (int degree = 2; degree < 15; degree += 1) tx[degree] = 2 * x * tx[degree - 1] - tx[degree - 2]; for (int degree = 2; degree < 8; degree += 1) ty[degree] = 2 * y * ty[degree - 1] - ty[degree - 2];
 for (int component = 0; component < HIGHRES_RANK; component += 1) { double value = 0; int term = 0; for (int i = 0; i < 15; i += 1) for (int j = 0; j < 8; j += 1) value += highres_spatial[term++][component] * tx[i] * ty[j]; latent[component] = value; }
 for (int band = 0; band < 14; band += 1) { double value = 0; for (int component = 0; component < HIGHRES_RANK; component += 1) value += highres_scale[component] * latent[component] * highres_spectral[band][component]; target->highres_band[band] = value; }
 target->highres_anchor = highres_radiation_db(target, target->frequency);
}

/* Four causal radiation bands represent the frequency-dependent rate at
 * which plate energy leaves the bridge.  Each band's rate is one smooth
 * pitch/hammer-speed surface fitted to all direct recordings together. */
static double radiation_loss_db_per_second(double midi, double velocity, int band) {
 static const double fit[4][15] = {
  {-2.3621761164,3.6855166434,-.877721891678,-.169880407546,.862485304516,-4.52610761406,2.26498380232,-1.19358332152,-.0172356169,1.2577090549,-2.27513356972,.297354646057,3.26546182804,.721710301834,-.439186696279},
  {3.49914832806,3.69721278281,-.487578751742,-.140539815628,-.651748853158,-.981854293046,7.82497022503,-3.32197528374,-.355415251438,-7.08730724579,5.85802494973,-1.45761268897,-9.40838677493,-1.19396841381,-6.16398924366},
  {-7.96960637145,-.906395786231,-1.84568846725,1.6237754788,.91191764393,5.67683690376,-13.5176383827,2.14666112483,.283111932055,6.96106400098,-6.67683110089,-.208546103735,1.93872019111,2.46744369617,.766277239372},
  {9.60260558777,-4.01405265725,3.15485985486,-1.72724073648,-.241949293047,-15.0322024431,20.5504813664,-6.7014039008,2.83813049492,-2.59096127413,4.8564250739,.590854314334,-3.89479657694,-1.76674760036,2.54947357433}
 };
 double x = (midi - 64.5) / 43.5, y = 2 * velocity - 1, tx[5] = {1,x}, ty[5] = {1,y}, result = 0; int coefficient = 0;
 for (int degree = 2; degree <= 4; degree += 1) { tx[degree] = 2 * x * tx[degree - 1] - tx[degree - 2]; ty[degree] = 2 * y * ty[degree - 1] - ty[degree - 2]; }
 for (int i = 0; i <= 4; i += 1) for (int j = 0; j <= 4 - i; j += 1) result += fit[band][coefficient++] * tx[i] * ty[j];
 return result;
}

static double modal_drive_correction_db(double midi, double velocity, double partial) {
 const double x = (midi - 64.5) / 43.5, y = 2 * velocity - 1, z = log2(partial) * .25, xy = x * y;
 const double fitted = z * (
  -38.1516619107
  + x * (-43.4460144826 + x * (65.274308281 + 23.64051963 * x))
  + y * (3.61160311394 + 8.47969805299 * y)
  + xy * (17.0116339792 + 13.591474559 * x + 1.72844848964 * y)
  + z * (40.1750625068 + 6.52987961005 * z + 84.1407206689 * x - 12.2875641451 * y - 1.72783187034 * xy)
 );
 return PIANO_DRIVE_BOUND * tanh(fitted / PIANO_DRIVE_WIDTH);
}

static double modal_loss_correction_db_per_second(double midi, double velocity, double partial) {
 const double x = (midi - 64.5) / 43.5, y = 2 * velocity - 1, z = log2(partial) * .25, xy = x * y;
 const double fitted =
  .720259165729
  + x * (-1.96795203624 + x * (-2.93824981216 - .927505872306 * x))
  + y * (-2.00806205353 - 1.74319697688 * y)
  + xy * (3.33712059883 + 10.7998570292 * x - 3.20139388427 * y)
  + z * (
   -8.6833744042
   + x * (11.7582034308 + 13.7480761277 * x)
   + y * (5.97762644605 - 1.69798921898 * y)
   + 18.3224054722 * xy
   + z * (29.0308772024 - 1.25048560305 * x + 5.7551504951 * y - 26.2726607486 * z)
  );
 return PIANO_LOSS_BOUND * tanh(fitted / PIANO_LOSS_WIDTH);
}

static void initialize_noise_filter(int index, double cutoff, int highpass, double sample_rate) {
 double omega = TWO_PI * cutoff / sample_rate, cosine = cos(omega), alpha = sin(omega) / (2 * M_SQRT1_2), inverse_a0 = 1 / (1 + alpha), sign = highpass ? 1 : -1, b0 = (1 + sign * cosine) * .5 * inverse_a0;
 noise_filters[index][0] = b0; noise_filters[index][1] = -(sign + cosine) * inverse_a0; noise_filters[index][2] = b0; noise_filters[index][3] = -2 * cosine * inverse_a0; noise_filters[index][4] = (1 - alpha) * inverse_a0;
}

static void initialize_filters(double sample_rate) {
 if (filters_ready && filters_rate == sample_rate) return;
 for (int index = 0; index < SOUND_FILTER_COUNT; index += 1) { double frequency, q, gain; soundboard_profile(index, &frequency, &q, &gain); double omega = TWO_PI * frequency / sample_rate, alpha = sin(omega) / (2 * q), inverse_a0 = 1 / (1 + alpha); soundboard_filters[0][index] = alpha * inverse_a0; soundboard_filters[1][index] = 0; soundboard_filters[2][index] = -alpha * inverse_a0; soundboard_filters[3][index] = -2 * cos(omega) * inverse_a0; soundboard_filters[4][index] = (1 - alpha) * inverse_a0; soundboard_filters[5][index] = gain; }
 /* Named stochastic-contact bands: felt, presence, air, body, diffuse body, plate. */
 initialize_noise_filter(0, 6500, 0, sample_rate); initialize_noise_filter(1, 6500, 0, sample_rate); initialize_noise_filter(2, 6500, 0, sample_rate); initialize_noise_filter(3, 1800, 1, sample_rate);
 initialize_noise_filter(4, 7500, 1, sample_rate); initialize_noise_filter(5, 15500, 0, sample_rate);
 initialize_noise_filter(6, 1100, 0, sample_rate); initialize_noise_filter(7, 1100, 0, sample_rate); initialize_noise_filter(8, 180, 1, sample_rate);
 initialize_noise_filter(9, 630, 0, sample_rate); initialize_noise_filter(10, 630, 0, sample_rate); initialize_noise_filter(11, 55, 1, sample_rate);
 initialize_noise_filter(12, 1600, 1, sample_rate); initialize_noise_filter(13, 8000, 0, sample_rate);
 filters_rate = sample_rate; filters_ready = 1;
}

__attribute__((export_name("output_ptr"))) uintptr_t output_ptr(void) { return (uintptr_t)output; }

static uint32_t seed_from_arguments(double frequency, double velocity) {
 union { double value; uint8_t bytes[8]; } f64 = {frequency}; union { float value; uint8_t bytes[4]; } f32 = {(float)velocity}; uint32_t hash = 0x811c9dc5; for (int index = 0; index < 8; index += 1) { hash ^= f64.bytes[index]; hash *= 0x01000193; } for (int index = 0; index < 4; index += 1) { hash ^= f32.bytes[index]; hash *= 0x01000193; } return hash;
}

static int hammer_force_length(double velocity, double reg, double frequency) {
 double soft_contact_seconds = lerp(.0034, .00085, reg), hard_contact_seconds = lerp(.00155, .00023, reg), unconstrained_contact = lerp(soft_contact_seconds, hard_contact_seconds, pow(velocity, .62)), treble_blend = transition((reg - .5) / .34), hard_contact_blend = transition((velocity - .08) / .52), tenor_cycle_limit = lerp(.24, .055, hard_contact_blend), cycle_limit = lerp(tenor_cycle_limit, .68, treble_blend), contact_seconds = fmin(unconstrained_contact, cycle_limit / frequency); return fmax(8, round(contact_seconds * RATE));
}

static void create_hammer_force(Voice *target) {
 int count = target->string_count = 1 + (target->midi >= 31) + (target->midi >= 49);
 PianoContact contact = piano_soft_contact(target->midi, count, una_corda_position);
 int samples = (int)fmin(MAX_FORCE, fmax(8, round(hammer_force_length(target->strike_velocity, target->reg, target->frequency) * contact.duration_ratio)));
 target->hammer_samples = samples; target->hammer_contact_seconds = samples / target->sample_rate;
 target->hammer_impulse = 2 * contact.reduced_mass * 5 * target->hammer_speed;
 for (int i = 0; i < count; ++i) { target->contact_weights[i] = piano_contact_overlap(una_corda_position, count, i); target->contact_gains[i] = count * target->contact_weights[i] / contact.contact_count; }
 /* The nominal pulse is an empirically calibrated source reduction. Soft
  * pedal duration and impulse follow the power-law collision's scaling laws,
  * rather than a new arbitrary gain or brightness multiplier. */
 double velocity = target->strike_velocity, exponent = lerp(1.35, 2.8, pow(velocity, .7)), skew = lerp(.18, -.08, velocity), integral = 0;
 for (int i = 0; i < samples; ++i) { double t = (double)i / (samples - 1); state[FORCE_O + i] = pow(sin(PI * t), exponent) * fmax(0, 1 + skew * (2 * t - 1)); integral += state[FORCE_O + i]; }
 for (int i = 0; i < samples; ++i) state[FORCE_O + i] *= contact.impulse_ratio / integral;
}

static double unison_phase(uint64_t serial, int midi_key, int string_index, int string_count) {
 if (string_count == 1) return 0;
 double values[3], mean = 0;
 for (int index = 0; index < string_count; index += 1) { uint32_t hash = (uint32_t)serial ^ (uint32_t)(serial >> 32) ^ ((uint32_t)midi_key * 0x9e3779b9u) ^ ((uint32_t)(index + 1) * 0x85ebca6bu); hash ^= hash >> 16; hash *= 0x7feb352du; hash ^= hash >> 15; hash *= 0x846ca68bu; hash ^= hash >> 16; values[index] = (double)(hash & 0xffffu) / 65535.0 - .5; mean += values[index]; }
 return PIANO_UNISON_PHASE_SCALE * (values[string_index] - mean / string_count);
}

static inline void init_string_mode(int index, int row, double pole, double step, double drive, double phase) { modes[row][index] = 0; modes[row + 1][index] = 0; modes[row + 2][index] = 2 * pole * cos(step); modes[row + 3][index] = -(pole * pole); modes[row + 4][index] = drive * sin(step + phase); phase_drive[row / 5][index] = -drive * pole * sin(phase); }
static inline double resonate_string(int index, int row, double force, double previous_force) { double result = modes[row + 2][index] * modes[row][index] + modes[row + 3][index] * modes[row + 1][index] + modes[row + 4][index] * force + phase_drive[row / 5][index] * previous_force; modes[row + 1][index] = modes[row][index]; modes[row][index] = result; return result; }

static int create_string_modes(double frequency, double velocity, double midi, double reg, uint64_t serial) {
 serial = serial ? serial - 1 : 0;
 double stiffness = string_inharmonicity(midi), extreme_treble = clamp((reg - .88) / .12, 0, 1), bass_broadening = transition((reg - .12) / .32), treble_voicing = transition((reg - .5) / .34), upper_treble_coupling = transition((midi - 84) / 24), middle_broadening = bass_broadening * (1 - treble_voicing), bass_voicing = transition((48 - midi) / 27), middle_presence = bell(midi, 60, 10, 2), strike_position = lerp(.127, .112, reg), broad_hammer_cutoff = 2500 + 13000 * pow(velocity, 1.2) + 3000 * reg * reg, treble_hammer_cutoff = 1050 + 8900 * pow(velocity, 1.72) + 2000 * reg * reg, brightness_cutoff = lerp(treble_hammer_cutoff, broad_hammer_cutoff, middle_broadening), spectral_limit = fmin(RATE * .475, 5500 + 15000 * pow(velocity, .62)), base_t60 = clamp(11 * pow(261.625565 / frequency, .45), 2.35, 31), stiffness_normalization = sqrt(1 + stiffness), width_cents = lerp(.32, 4.1 * PIANO_UNISON_WIDTH_SCALE, pow(clamp((midi - 31) / 77, 0, 1), 1.5)), upper_detune = lerp(.95, .7, transition((midi - 96) / 12)), unison_inequality = pow(reg, 1.5); int string_count = 1 + (midi >= 31) + (midi >= 49), mode_count = 0; double equal_weight = 1.0 / string_count;
 for (int partial = 1; partial <= 192; partial += 1) {
  double dispersed_frequency = partial * frequency * sqrt(1 + stiffness * partial * partial) / stiffness_normalization; if (dispersed_frequency > spectral_limit) break;
  double strike_coupling = .2 + .8 * fabs(sin(PI * partial * strike_position)), felt_filter = bell(dispersed_frequency, 0, brightness_cutoff, 1.3), hammer_velocity_base = lerp(.78 + .12 * velocity, .9 + .04 * velocity, middle_broadening), velocity_brightening = pow(hammer_velocity_base, log2(partial)), radiation = PIANO_RADIATION_FLOOR + (1 - PIANO_RADIATION_FLOOR) * dispersed_frequency / (dispersed_frequency + PIANO_RADIATION_CORNER), mid_bridge_coupling = 1 + 2.1 * bell(midi, 65, 10, 2) * bell(partial, 2, .75, 2), treble_loss = fmax(0, .72 - .32 * velocity - .22 * extreme_treble * velocity - 1.2 * upper_treble_coupling * (1 - velocity)), treble_mode_damping = exp(-4.4 * pow(reg, 4.2) * (partial - 1) * treble_loss * lerp(1, .45, middle_broadening)), register_radiation_gain = 1 + 2.8 * pow(reg, 2.2), bridge_presence_shape = bell(log(dispersed_frequency / 1800), 0, .29, 2), bridge_presence_gain = 1 + .7 * middle_presence * bridge_presence_shape, bridge_antiresonance_shape = bell(log(dispersed_frequency / 790), 0, .08, 2), bridge_antiresonance = 1 - .85 * middle_presence * bridge_antiresonance_shape, middle_body_shape = bell(partial, 4.5, 1, 4), middle_body_level = 1 - .5 * middle_presence * middle_body_shape, bass_overtone_radiation = 1 + 4 * bass_voicing * (1 - exp(-(partial - 1) / 1.6)), weak_bass_fundamental = 1 - (.91 - .4 * bass_voicing) * bass_voicing * bell(partial, 1, .55, 4), weak_bass_second = 1 - (.93 - .4 * bass_voicing) * bass_voicing * bell(partial, 2, .55, 4), bass_high_partial_transition = transition((partial - 10) / 7.0), bass_high_partial_radiation = 1 + 4.5 * bass_voicing * bass_high_partial_transition, bass_presence_shape = bell(log(dispersed_frequency / 1800), 0, 1.05, 4), bass_presence_radiation = 1 + 4 * (1 - bass_broadening) * bass_presence_shape, partial_rolloff = fmax(.7, lerp(1.12, .58, middle_broadening) - .18 * bass_voicing);
  partial_rolloff += bass_voicing * (.3 + .8 * velocity);
  double highres_color_db = clamp(PIANO_HIGHRES_RADIATION_SCALE * (highres_radiation_db(voice, dispersed_frequency) - voice->highres_anchor), -24, 24), amplitude = strike_coupling * felt_filter * velocity_brightening * radiation * mid_bridge_coupling * treble_mode_damping * register_radiation_gain * bridge_presence_gain * bridge_antiresonance * middle_body_level * bass_overtone_radiation * weak_bass_fundamental * weak_bass_second * bass_high_partial_radiation * bass_presence_radiation * pow(10, (bridge_mobility_db(dispersed_frequency) + modal_drive_correction_db(midi, velocity, partial) + radiation_residual_db(midi, velocity, dispersed_frequency, frequency) + highres_color_db - PIANO_HIGH_LOSS_DB * transition(log2(dispersed_frequency / PIANO_HIGH_LOSS_CORNER))) / 20) / pow(partial, partial_rolloff);
  double bass_presence_decay = transition(log2(dispersed_frequency / 500) / 2), undamped_partial_t60 = base_t60 * (.3 + .7 / pow(partial, .75)) / (1 + pow(dispersed_frequency / 9500, 2)) * (1 + .7 * (1 - bass_broadening) * bass_presence_decay), c6_mode_shape = bell(midi, 84, 3, 2) * bell(partial, 2, .55, 4), localized_termination_loss = PIANO_C6_SECOND_LOSS_DB_PER_SECOND * c6_mode_shape; undamped_partial_t60 = 60 / fmax(1.5, 60 / undamped_partial_t60 + modal_loss_correction_db_per_second(midi, velocity, partial) + localized_termination_loss); double low_order_treble_tail = bell(partial, 1.5, 1, 4), treble_high_partial_tail = 1 - exp(-(partial - 1) / 2.5), late_treble_tail = transition((midi - 94) / 14), slow_tail_t60 = undamped_partial_t60 * (1 + .15 * bass_voicing) * exp(.5 * (.75 - velocity) * treble_high_partial_tail) * (1 - .35 * late_treble_tail * treble_high_partial_tail) * (1 - low_order_treble_tail * (.25 * treble_voicing + .2 * extreme_treble)), base_fast_fraction = .14 + .43 * (partial / (partial + 5.0)), middle_low_mode_loss = (.3 * middle_presence + .4 * bell(midi, 60, 1.5, 2) * transition((velocity - .8) / .17)) * bell(partial, 1.5, .8, 4), middle_body_sustain = .38 * middle_presence * middle_body_shape, maximum_fast_fraction = fmin(.99, (partial == 1 ? lerp(.965, .82, pow(reg, 1.5)) : lerp(.94, .68, pow(reg, 1.4))) + .16 * reg * (velocity - .5) + .6 * late_treble_tail * treble_high_partial_tail), fast_fraction = clamp(base_fast_fraction + 1.03 * reg * reg + middle_low_mode_loss - middle_body_sustain, 0, maximum_fast_fraction), fast_ratio = lerp(.21, .045, pow(reg, 1.35)) * lerp(1, .72, partial / (partial + 8.0)); if (partial == 2) fast_ratio *= lerp(1, .15, reg * reg);
  double fast_t60 = undamped_partial_t60 * fast_ratio, bridge_rise_seconds = (.00125 + .005 / (1 + partial * .42)) * lerp(1.35, .78, reg) * (1 + .9 * reg * reg + 3.5 * pow(reg, 6)) * (1 + .27 * bell(midi, 93, 10, 2) + .24 * extreme_treble), vertical_second_partial_boost = partial == 2 ? 1 + 4.5 * pow(reg, 3) * velocity : 1, fast_pole = decay(6.907755, fast_t60), slow_pole = decay(6.907755, slow_tail_t60), polarization_t60 = slow_tail_t60 * lerp(.68, .34, reg), polarization_pole = decay(6.907755, polarization_t60), polarization_strength = (.035 + .11 * reg) * (.55 + .45 * velocity) / pow(partial, .2);
  double damper_a = .122, damper_b = .184, damper_contact_energy = .5 - (sin(TWO_PI * partial * damper_b) - sin(TWO_PI * partial * damper_a)) / (TWO_PI * 2 * partial * (damper_b - damper_a)), bass_damper_node = clamp(.75 + .5 * damper_contact_energy, .75, 1.25), damper_node_coupling = lerp(bass_damper_node, 1, transition((midi - 33) / 27)), damper_register_slope = lerp(170, 220, transition((midi - 21) / 69)), damper_partial_slope = 1 + .035 * (partial - 1), free_return_slope_db = damper_register_slope * damper_partial_slope * damper_node_coupling, regulated_return_slope_db = .5 * free_return_slope_db;
  for (int string_index = 0; string_index < string_count; string_index += 1) {
   double phase = unison_phase(serial, (int)round(midi), string_index, string_count);
   double cents = string_count == 1 ? 0 : string_count == 2 ? (string_index == 0 ? -.47 : .53) * width_cents : (string_index == 0 ? -.83 : string_index == 1 ? -.34 : upper_detune) * width_cents;
   double string_frequency = dispersed_frequency * pow(2, cents / 1200), angular_step = TWO_PI * string_frequency / RATE;
   double string_weight = lerp(equal_weight, string_count == 1 ? 1 : string_count == 2 ? (string_index == 0 ? .47 : .53) : (string_index == 0 ? .09 : string_index == 1 ? .46 : .45), unison_inequality);
   voice->unison_weights[mode_count] = string_weight; voice->unison_inverse[mode_count] = 1 / string_weight; voice->unison_shares[mode_count] = piano_unison_share(string_count, .03 / (1 + dispersed_frequency / 2000), 8 / RATE);
   double polarization_cents = (.35 + 1.1 * reg) * sin(2.17 * partial + 1.31 * string_index + .4), polarization_frequency = string_frequency * pow(2, polarization_cents / 1200), polarization_step = TWO_PI * polarization_frequency / RATE;
   double weighted_amplitude = amplitude * string_weight, fast_amplitude = weighted_amplitude * fast_fraction * vertical_second_partial_boost, slow_amplitude = weighted_amplitude * (1 - fast_fraction), polarization_amplitude = weighted_amplitude * polarization_strength;
   init_string_mode(mode_count, 0, fast_pole, angular_step, fast_amplitude, phase);
   init_string_mode(mode_count, 5, slow_pole, angular_step, slow_amplitude, phase);
   init_string_mode(mode_count, 10, polarization_pole, polarization_step, polarization_amplitude, phase);
   mode_delays[0][mode_count] = string_count == 3 ? (string_index == 1 ? 2 : string_index == 2 ? 1 : 0) : 0; mode_delays[1][mode_count] = string_index + 1;
   modes[15][mode_count] = 0; modes[16][mode_count] = 1 - decay(1, bridge_rise_seconds); modes[17][mode_count] = 1; modes[18][mode_count] = exp(-M_LN10 * free_return_slope_db / (20 * RATE)); modes[19][mode_count] = exp(-M_LN10 * regulated_return_slope_db / (20 * RATE)); modes[20][mode_count] = 1;
   modes[21][mode_count] = .9 * extreme_treble * pow(1 - velocity, 2) * treble_high_partial_tail; modes[22][mode_count] = decay(1, .7);
   uint32_t fast_cutoff = decay_samples(fabs(fast_amplitude), fast_pole), slow_cutoff = decay_samples(fabs(slow_amplitude), slow_pole), polarization_cutoff = decay_samples(fabs(polarization_amplitude), polarization_pole); fast_cutoffs[mode_count] = fast_cutoff; polarization_cutoffs[mode_count] = polarization_cutoff; mode_cutoff[mode_count] = fmax(fast_cutoff, fmax(slow_cutoff, polarization_cutoff)); mode_count += 1;
  }
  if (dispersed_frequency <= SHARED_BRIDGE_BAND_LIMIT) voice->coupled_mode_count = mode_count;
 }
 for (int index = mode_count - 2; index >= 0; index -= 1) { fast_cutoffs[index] = fmax(fast_cutoffs[index], fast_cutoffs[index + 1]); polarization_cutoffs[index] = fmax(polarization_cutoffs[index], polarization_cutoffs[index + 1]); mode_cutoff[index] = fmax(mode_cutoff[index], mode_cutoff[index + 1]); }
 /* Keep whole unisons alive while any member can still carry audible energy. */
 for (int base = 0; base < mode_count; base += string_count) for (int j = 1; j < string_count; ++j) {
  fast_cutoffs[base+j] = fast_cutoffs[base]; polarization_cutoffs[base+j] = polarization_cutoffs[base]; mode_cutoff[base+j] = mode_cutoff[base];
 }
 return mode_count;
}

static inline __attribute__((always_inline)) v128_t string_step(int row, int index) { v128_t y0 = wasm_v128_load(modes[row] + index), y1 = wasm_v128_load(modes[row + 1] + index), a1 = wasm_v128_load(modes[row + 2] + index), a2 = wasm_v128_load(modes[row + 3] + index), result = wasm_f64x2_add(wasm_f64x2_mul(a1, y0), wasm_f64x2_mul(a2, y1)); wasm_v128_store(modes[row + 1] + index, y0); wasm_v128_store(modes[row] + index, result); return result; }
static inline __attribute__((always_inline)) v128_t forced_string_step(int row, int index, v128_t force, v128_t previous_force) { v128_t y0 = wasm_v128_load(modes[row] + index), y1 = wasm_v128_load(modes[row + 1] + index), a1 = wasm_v128_load(modes[row + 2] + index), a2 = wasm_v128_load(modes[row + 3] + index), drive = wasm_v128_load(modes[row + 4] + index), phase = wasm_v128_load(phase_drive[row / 5] + index), result = wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(a1, y0), wasm_f64x2_mul(a2, y1)), wasm_f64x2_add(wasm_f64x2_mul(drive, force), wasm_f64x2_mul(phase, previous_force))); wasm_v128_store(modes[row + 1] + index, y0); wasm_v128_store(modes[row] + index, result); return result; }

static inline double filter_settled_unity_modes(int count, int coupled_count, double sympathetic_force, double previous_force_scalar) {
 int fast_count = voice->active_fast_mode_count, polarization_count = voice->active_polarization_mode_count;
 v128_t sum = wasm_f64x2_splat(0), zero = sum, force = wasm_f64x2_splat(sympathetic_force), previous_force = wasm_f64x2_splat(previous_force_scalar); int index = 0;
 for (; index + 1 < coupled_count; index += 2) { v128_t fast = index < fast_count ? forced_string_step(0, index, force, previous_force) : zero, slow = forced_string_step(5, index, force, previous_force), horizontal = index < polarization_count ? forced_string_step(10, index, force, previous_force) : zero; sum = wasm_f64x2_add(sum, wasm_f64x2_add(wasm_f64x2_add(fast, slow), horizontal)); }
 for (; index + 1 < count; index += 2) { v128_t fast = index < fast_count ? string_step(0, index) : zero, slow = string_step(5, index), horizontal = index < polarization_count ? string_step(10, index) : zero; sum = wasm_f64x2_add(sum, wasm_f64x2_add(wasm_f64x2_add(fast, slow), horizontal)); }
 double lanes[2]; wasm_v128_store(lanes, sum); double result = lanes[0] + lanes[1];
 if (index < count) { double fast = 0, slow = modes[7][index] * modes[5][index] + modes[8][index] * modes[6][index], horizontal = 0; if (index < fast_count) { fast = modes[2][index] * modes[0][index] + modes[3][index] * modes[1][index]; if (index < coupled_count) fast += modes[4][index] * sympathetic_force + phase_drive[0][index] * previous_force_scalar; modes[1][index] = modes[0][index]; modes[0][index] = fast; } if (index < polarization_count) { horizontal = modes[12][index] * modes[10][index] + modes[13][index] * modes[11][index]; if (index < coupled_count) horizontal += modes[14][index] * sympathetic_force + phase_drive[2][index] * previous_force_scalar; modes[11][index] = modes[10][index]; modes[10][index] = horizontal; } if (index < coupled_count) slow += modes[9][index] * sympathetic_force + phase_drive[1][index] * previous_force_scalar; modes[6][index] = modes[5][index]; modes[5][index] = slow; result += fast + slow + horizontal; }
 return result;
}

static inline double filter_rising_unity_modes(int count, int coupled_count, double sympathetic_force, double previous_force_scalar) {
 int fast_count = voice->active_fast_mode_count, polarization_count = voice->active_polarization_mode_count;
 v128_t sum = wasm_f64x2_splat(0), zero = sum, one = wasm_f64x2_splat(1), two = wasm_f64x2_splat(2), three = wasm_f64x2_splat(3), force = wasm_f64x2_splat(sympathetic_force), previous_force = wasm_f64x2_splat(previous_force_scalar); int index = 0;
 for (; index + 1 < count; index += 2) { v128_t fast = zero, slow, horizontal = zero; if (index < coupled_count) { if (index < fast_count) fast = forced_string_step(0, index, force, previous_force); slow = forced_string_step(5, index, force, previous_force); if (index < polarization_count) horizontal = forced_string_step(10, index, force, previous_force); } else { if (index < fast_count) fast = string_step(0, index); slow = string_step(5, index); if (index < polarization_count) horizontal = string_step(10, index); } v128_t bridge = wasm_v128_load(modes[15] + index), bridge_step = wasm_v128_load(modes[16] + index); bridge = wasm_f64x2_add(bridge, wasm_f64x2_mul(wasm_f64x2_sub(one, bridge), bridge_step)); wasm_v128_store(modes[15] + index, bridge); v128_t transmission = wasm_f64x2_mul(wasm_f64x2_mul(bridge, bridge), wasm_f64x2_sub(three, wasm_f64x2_mul(two, bridge))); sum = wasm_f64x2_add(sum, wasm_f64x2_mul(wasm_f64x2_add(wasm_f64x2_add(fast, slow), horizontal), transmission)); }
 double lanes[2]; wasm_v128_store(lanes, sum); double result = lanes[0] + lanes[1];
 if (index < count) { double fast = 0, slow = modes[7][index] * modes[5][index] + modes[8][index] * modes[6][index], horizontal = 0; if (index < fast_count) { fast = modes[2][index] * modes[0][index] + modes[3][index] * modes[1][index]; if (index < coupled_count) fast += modes[4][index] * sympathetic_force + phase_drive[0][index] * previous_force_scalar; modes[1][index] = modes[0][index]; modes[0][index] = fast; } if (index < polarization_count) { horizontal = modes[12][index] * modes[10][index] + modes[13][index] * modes[11][index]; if (index < coupled_count) horizontal += modes[14][index] * sympathetic_force + phase_drive[2][index] * previous_force_scalar; modes[11][index] = modes[10][index]; modes[10][index] = horizontal; } if (index < coupled_count) slow += modes[9][index] * sympathetic_force + phase_drive[1][index] * previous_force_scalar; modes[6][index] = modes[5][index]; modes[5][index] = slow; modes[15][index] += (1 - modes[15][index]) * modes[16][index]; double bridge = modes[15][index]; result += (fast + slow + horizontal) * bridge * bridge * (3 - 2 * bridge); }
 return result;
}

static inline double filter_free_modes(int count, double damper_strength, double free_return_blend, double sympathetic_force) {
 double previous_force_scalar = voice->previous_sympathetic_force;
 int coupled_count = 0, bridge_settled = voice->age >= voice->bridge_settle_samples, termination_active = voice->reg > .88, index = 0;
 if (sympathetic_force != 0 || previous_force_scalar != 0) { coupled_count = voice->coupled_mode_count; if (coupled_count < count && (coupled_count & 1)) coupled_count += 1; if (coupled_count > count) coupled_count = count; }
 if (damper_strength > 0) voice->mode_gains_unity = 0;
 if (!termination_active && damper_strength <= 0 && voice->mode_gains_unity) { double result = bridge_settled ? filter_settled_unity_modes(count, coupled_count, sympathetic_force, previous_force_scalar) : filter_rising_unity_modes(count, coupled_count, sympathetic_force, previous_force_scalar); voice->previous_sympathetic_force = sympathetic_force; return result; }
 int fast_count = voice->active_fast_mode_count, polarization_count = voice->active_polarization_mode_count;
 v128_t sum = wasm_f64x2_splat(0), zero = sum, one = wasm_f64x2_splat(1), two = wasm_f64x2_splat(2), three = wasm_f64x2_splat(3), strength = wasm_f64x2_splat(damper_strength), blend = wasm_f64x2_splat(free_return_blend), horizontal_fraction = wasm_f64x2_splat(.45), force = wasm_f64x2_splat(sympathetic_force), previous_force = wasm_f64x2_splat(previous_force_scalar);
 for (; index + 1 < count; index += 2) {
  v128_t fast = index < fast_count ? (index < coupled_count ? forced_string_step(0, index, force, previous_force) : string_step(0, index)) : zero, slow = index < coupled_count ? forced_string_step(5, index, force, previous_force) : string_step(5, index), vertical;
  if (termination_active) { v128_t termination = wasm_f64x2_mul(wasm_v128_load(modes[21] + index), wasm_v128_load(modes[22] + index)); wasm_v128_store(modes[21] + index, termination); vertical = wasm_f64x2_add(fast, wasm_f64x2_mul(slow, wasm_f64x2_sub(one, termination))); }
  else vertical = wasm_f64x2_add(fast, slow);
  v128_t horizontal = index < polarization_count ? (index < coupled_count ? forced_string_step(10, index, force, previous_force) : string_step(10, index)) : zero, transmission = one;
  if (!bridge_settled) { v128_t bridge = wasm_v128_load(modes[15] + index), bridge_step = wasm_v128_load(modes[16] + index); bridge = wasm_f64x2_add(bridge, wasm_f64x2_mul(wasm_f64x2_sub(one, bridge), bridge_step)); wasm_v128_store(modes[15] + index, bridge); transmission = wasm_f64x2_mul(wasm_f64x2_mul(bridge, bridge), wasm_f64x2_sub(three, wasm_f64x2_mul(two, bridge))); }
  v128_t gain = wasm_v128_load(modes[17] + index), horizontal_gain = wasm_v128_load(modes[20] + index);
  if (damper_strength > 0) { v128_t regulated_pole = wasm_v128_load(modes[19] + index), free_pole = wasm_v128_load(modes[18] + index), target_pole = wasm_f64x2_add(regulated_pole, wasm_f64x2_mul(wasm_f64x2_sub(free_pole, regulated_pole), blend)), effective_pole = wasm_f64x2_add(one, wasm_f64x2_mul(wasm_f64x2_sub(target_pole, one), strength)), horizontal_pole = wasm_f64x2_add(one, wasm_f64x2_mul(wasm_f64x2_sub(effective_pole, one), horizontal_fraction)); gain = wasm_f64x2_mul(gain, effective_pole); horizontal_gain = wasm_f64x2_mul(horizontal_gain, horizontal_pole); wasm_v128_store(modes[17] + index, gain); wasm_v128_store(modes[20] + index, horizontal_gain); }
  v128_t value = wasm_f64x2_add(wasm_f64x2_mul(vertical, gain), wasm_f64x2_mul(horizontal, horizontal_gain)); sum = wasm_f64x2_add(sum, wasm_f64x2_mul(value, transmission));
 }
 double lanes[2]; wasm_v128_store(lanes, sum); double result = lanes[0] + lanes[1];
 if (index < count) {
  double fast = 0, slow = modes[7][index] * modes[5][index] + modes[8][index] * modes[6][index], polarization = 0; if (index < fast_count) { fast = modes[2][index] * modes[0][index] + modes[3][index] * modes[1][index]; if (index < coupled_count) fast += modes[4][index] * sympathetic_force + phase_drive[0][index] * previous_force_scalar; modes[1][index] = modes[0][index]; modes[0][index] = fast; } if (index < polarization_count) { polarization = modes[12][index] * modes[10][index] + modes[13][index] * modes[11][index]; if (index < coupled_count) polarization += modes[14][index] * sympathetic_force + phase_drive[2][index] * previous_force_scalar; modes[11][index] = modes[10][index]; modes[10][index] = polarization; } if (index < coupled_count) slow += modes[9][index] * sympathetic_force + phase_drive[1][index] * previous_force_scalar; modes[6][index] = modes[5][index]; modes[5][index] = slow;
  if (termination_active) { modes[21][index] *= modes[22][index]; slow *= 1 - modes[21][index]; }
  double transmission = 1; if (!bridge_settled) { modes[15][index] += (1 - modes[15][index]) * modes[16][index]; double bridge = modes[15][index]; transmission = bridge * bridge * (3 - 2 * bridge); }
  double gain = modes[17][index], horizontal_gain = modes[20][index]; if (damper_strength > 0) { double target_pole = lerp(modes[19][index], modes[18][index], free_return_blend), effective_pole = lerp(1, target_pole, damper_strength); gain *= effective_pole; horizontal_gain *= lerp(1, effective_pole, .45); modes[17][index] = gain; modes[20][index] = horizontal_gain; }
  result += ((fast + slow) * gain + polarization * horizontal_gain) * transmission;
 }
 voice->previous_sympathetic_force = sympathetic_force; return result;
}

static double filter_driven_strings(int mode_count, int strike_index, int hammer_samples, double damper_strength, double free_return_blend) {
 if (damper_strength > 0) voice->mode_gains_unity = 0; double strings = 0; for (int index = 0; index < mode_count; index += 1) { int force_index = strike_index - mode_delays[0][index], polarization_force_index = strike_index - mode_delays[1][index]; double string_force = force_index >= 0 && force_index < hammer_samples ? (state[FORCE_O + force_index] * voice->contact_gains[index % voice->string_count]) : 0, previous_string_force = force_index > 0 && force_index <= hammer_samples ? (state[FORCE_O + force_index - 1] * voice->contact_gains[index % voice->string_count]) : 0, polarization_force = polarization_force_index >= 0 && polarization_force_index < hammer_samples ? (state[FORCE_O + polarization_force_index] * voice->contact_gains[index % voice->string_count]) : 0, previous_polarization_force = polarization_force_index > 0 && polarization_force_index <= hammer_samples ? (state[FORCE_O + polarization_force_index - 1] * voice->contact_gains[index % voice->string_count]) : 0, fast = resonate_string(index, 0, string_force, previous_string_force), slow = resonate_string(index, 5, string_force, previous_string_force), polarization = resonate_string(index, 10, polarization_force, previous_polarization_force); modes[21][index] *= modes[22][index]; modes[15][index] += (1 - modes[15][index]) * modes[16][index]; if (damper_strength > 0) { double target_pole = lerp(modes[19][index], modes[18][index], free_return_blend), effective_pole = lerp(1, target_pole, damper_strength); modes[17][index] *= effective_pole; modes[20][index] *= lerp(1, effective_pole, .45); } strings += ((fast + slow * (1 - modes[21][index])) * modes[17][index] + polarization * modes[20][index]) * smoothstep(modes[15][index]); } return strings;
}

static inline void couple_unison_modes(Voice *target) {
 int strings = target->string_count; if (strings < 2 || (target->age & 7)) return;
 int count = target->active_mode_count;
 for (int base = 0; base + strings <= count; base += strings) {
  double share = target->unison_shares[base];
  for (int row = 0; row <= 10; row += 5) {
   if ((row == 0 && base >= target->active_fast_mode_count) || (row == 10 && base >= target->active_polarization_mode_count)) continue;
   double sum = 0, previous_sum = 0;
   for (int j = 0; j < strings; ++j) { int i = base + j; sum += modes[row][i] * target->unison_inverse[i]; previous_sum += modes[row + 1][i] * target->unison_inverse[i]; }
   for (int j = 0; j < strings; ++j) { int i = base + j; modes[row][i] -= share * sum * target->unison_weights[i]; modes[row + 1][i] -= share * previous_sum * target->unison_weights[i]; }
  }
 }
}

static inline void init_impact_mode(int index, int row, double pole, double step, double drive) { impact_state[row][index] = 0; impact_state[row + 1][index] = 0; impact_state[row + 2][index] = 2 * pole * cos(step); impact_state[row + 3][index] = -(pole * pole); impact_state[row + 4][index] = drive * sin(step); }

static void create_duplex_modes(Voice *target) {
 for (int index = 0; index < 2; index += 1) { double ratio = 3 + index, frequency = target->frequency * ratio * (1 + .0025 * (index ? 1 : -1)); if (frequency >= .45 * target->sample_rate) continue; double step = TWO_PI * frequency / target->sample_rate, pole = exp(-6.907755 / (lerp(1.1, .42, target->reg) * target->sample_rate)); target->duplex[index][2] = 2 * pole * cos(step); target->duplex[index][3] = -(pole * pole); target->duplex[index][4] = .008 * sin(step) / ratio; }
}

static double filter_duplex_modes(Voice *target, double bridge_force) {
 double result = 0; for (int index = 0; index < 2; index += 1) { double *mode = target->duplex[index], value = mode[2] * mode[0] + mode[3] * mode[1] + mode[4] * bridge_force; mode[1] = mode[0]; mode[0] = value; result += value; } return result;
}

static void create_impact_soundboard(double velocity, double reg, double midi) {
 double impact_strength = pow(velocity, 1.15) * (.82 + .18 * reg), middle_body = bell(midi, 60, 10, 2), upper_tenor_antinode = bell(midi, 82, 7, 2), soft_contact_coupling = pow(1 - velocity, 4), treble_body = transition((midi - 72) / 36), extreme_treble_body = transition((midi - 99) / 9), treble_velocity_voicing = transition((midi - 84) / 18), bass_plate_transition = transition((midi - 30) / 30), extreme_treble = clamp((reg - .88) / .12, 0, 1), body_velocity = fmax(velocity, .04), low_body_velocity_scale = lerp(pow(body_velocity, -.45), .1 * pow(body_velocity, -2.5), treble_velocity_voicing), coupled_body_drive = .75 * (1 + 2 * middle_body + 16 * upper_tenor_antinode * soft_contact_coupling + 6 * extreme_treble_body) * low_body_velocity_scale; voice->impact_body_count = treble_body > 0 ? 11 : 9; voice->impact_attack_count = treble_body > 0 ? 11 : 0;
  voice->impact_fast_count = IMPACT_COUNT;
  for (int index = 0; index < IMPACT_COUNT; index += 1) { double frequency, decay_seconds, gain; impact_profile(index, &frequency, &decay_seconds, &gain); double impact_color = PIANO_IMPACT_SPECTRAL_SCALE * (impact_spectral_fit_db(midi, velocity, frequency) - impact_spectral_fit_db(midi, velocity, voice->frequency)) + PIANO_HIGHRES_IMPACT_SCALE * clamp(highres_radiation_db(voice, frequency) - voice->highres_anchor, -24, 24); gain *= pow(10, (bridge_participation_db(midi, frequency) + impact_color) / 20); double angular_step = TWO_PI * frequency / RATE, body_mode_weight = frequency < 1000 ? 1 : frequency < 1700 ? treble_body : 0; int low_body_mode = body_mode_weight > 0; double fast_decay_seconds = decay_seconds * (low_body_mode ? 1 + body_mode_weight * (1.75 * reg * reg + 13 * middle_body + 10 * treble_body) : 1), low_plate_weight = transition((400 - frequency) / 350), slow_body_fraction = low_body_mode ? body_mode_weight * (.2 * middle_body + .1 * treble_body * (1 + 2 * low_plate_weight)) * (1 - .98 * extreme_treble_body) : 0, slow_decay_seconds = decay_seconds * (1 + body_mode_weight * (90 * middle_body + 100 * treble_body)), fast_pole = decay(1, fast_decay_seconds), slow_pole = decay(1, slow_decay_seconds), attack_decay_multiplier = frequency >= 250 ? 2.8 : 2.2, attack_pole = decay(1, attack_decay_multiplier * decay_seconds), high_frequency = fmax(1, frequency / 500), felt_brightness = pow(.58 + .42 * velocity, log2(high_frequency)), mode_shape = .72 + .28 * sin(.73 * index + 3.1 * reg), impact_radiation = lerp(1, clamp(sqrt(frequency / 2000), .2, 1), reg * reg); if (low_body_mode) impact_radiation = lerp(impact_radiation, 1, extreme_treble); double mid_plate_scale = frequency >= 1800 && frequency < 3800 ? lerp(1, .18, extreme_treble) : 1, low_body_drive = lerp(1, coupled_body_drive, body_mode_weight), bass_high_plate_scale = frequency >= 1800 ? lerp(.1, 1, bass_plate_transition) : 1, lowest_plate_coupling = index == 0 ? .45 : 1, drive = gain * low_body_drive * bass_high_plate_scale * mid_plate_scale * lowest_plate_coupling * impact_strength * felt_brightness * mode_shape * impact_radiation, fast_drive = drive * (1 - slow_body_fraction), slow_drive = drive * slow_body_fraction, attack_drive = drive * (2.5 * body_mode_weight * treble_body); init_impact_mode(index, 0, fast_pole, angular_step, fast_drive); init_impact_mode(index, 5, slow_pole, angular_step, slow_drive); init_impact_mode(index, 10, attack_pole, angular_step, attack_drive); voice->impact_fast_cutoff[index] = decay_samples(fabs(fast_drive), fast_pole); voice->impact_slow_cutoff[index] = decay_samples(fabs(slow_drive), slow_pole); voice->impact_attack_cutoff[index] = decay_samples(fabs(attack_drive), attack_pole); impact_state[15][index] = 0; impact_state[16][index] = 1 - decay(1, .008); }
  for (int index = IMPACT_COUNT - 2; index >= 0; index -= 1) { voice->impact_fast_cutoff[index] = fmax(voice->impact_fast_cutoff[index], voice->impact_fast_cutoff[index + 1]); voice->impact_slow_cutoff[index] = fmax(voice->impact_slow_cutoff[index], voice->impact_slow_cutoff[index + 1]); voice->impact_attack_cutoff[index] = fmax(voice->impact_attack_cutoff[index], voice->impact_attack_cutoff[index + 1]); }
}

static inline __attribute__((always_inline)) v128_t impact_step(int row, int index, v128_t force) { v128_t y0 = wasm_v128_load(impact_state[row] + index), y1 = wasm_v128_load(impact_state[row + 1] + index), a1 = wasm_v128_load(impact_state[row + 2] + index), a2 = wasm_v128_load(impact_state[row + 3] + index), drive = wasm_v128_load(impact_state[row + 4] + index), result = wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(a1, y0), wasm_f64x2_mul(a2, y1)), wasm_f64x2_mul(drive, force)); wasm_v128_store(impact_state[row + 1] + index, y0); wasm_v128_store(impact_state[row] + index, result); return result; }
static inline __attribute__((always_inline)) double impact_scalar(int row, int index, double force) { double result = impact_state[row + 2][index] * impact_state[row][index] + impact_state[row + 3][index] * impact_state[row + 1][index] + impact_state[row + 4][index] * force; impact_state[row + 1][index] = impact_state[row][index]; impact_state[row][index] = result; return result; }

static double filter_impact_soundboard(double scalar_force) {
 int count = voice->impact_fast_count; if (count < voice->impact_body_count) count = voice->impact_body_count; if (count < voice->impact_attack_count) count = voice->impact_attack_count;
 v128_t sum = wasm_f64x2_splat(0), zero = sum, force = wasm_f64x2_splat(scalar_force), one = wasm_f64x2_splat(1); int index = 0;
 for (; index + 1 < count; index += 2) { v128_t value = zero; if (index < voice->impact_fast_count) value = wasm_f64x2_add(value, impact_step(0, index, force)); if (index < voice->impact_body_count) value = wasm_f64x2_add(value, impact_step(5, index, force)); if (index < voice->impact_attack_count) { v128_t attack = impact_step(10, index, force), envelope = wasm_v128_load(impact_state[15] + index); envelope = wasm_f64x2_add(envelope, wasm_f64x2_mul(wasm_f64x2_sub(one, envelope), wasm_v128_load(impact_state[16] + index))); wasm_v128_store(impact_state[15] + index, envelope); value = wasm_f64x2_add(value, wasm_f64x2_mul(attack, envelope)); } sum = wasm_f64x2_add(sum, value); }
 if (index < count) { double value = 0; if (index < voice->impact_fast_count) value += impact_scalar(0, index, scalar_force); if (index < voice->impact_body_count) value += impact_scalar(5, index, scalar_force); if (index < voice->impact_attack_count) { double attack = impact_scalar(10, index, scalar_force); impact_state[15][index] += (1 - impact_state[15][index]) * impact_state[16][index]; value += attack * impact_state[15][index]; } sum = wasm_f64x2_add(sum, wasm_f64x2_make(value, 0)); }
 double lanes[2]; wasm_v128_store(lanes, sum); return lanes[0] + lanes[1];
}

static void damp_coupled_body(double pole) {
 v128_t damping = wasm_f64x2_splat(pole);
 for (int index = 0; index < IMPACT_COUNT; index += 2) {
  wasm_v128_store(impact_state[0] + index, wasm_f64x2_mul(wasm_v128_load(impact_state[0] + index), damping));
  wasm_v128_store(impact_state[1] + index, wasm_f64x2_mul(wasm_v128_load(impact_state[1] + index), damping));
  wasm_v128_store(impact_state[5] + index, wasm_f64x2_mul(wasm_v128_load(impact_state[5] + index), damping));
  wasm_v128_store(impact_state[6] + index, wasm_f64x2_mul(wasm_v128_load(impact_state[6] + index), damping));
  wasm_v128_store(impact_state[10] + index, wasm_f64x2_mul(wasm_v128_load(impact_state[10] + index), damping));
  wasm_v128_store(impact_state[11] + index, wasm_f64x2_mul(wasm_v128_load(impact_state[11] + index), damping));
 }
}

static inline __attribute__((always_inline)) double filter_biquad(double input, const double *filter, int offset) { double result = filter[0] * input + filter[1] * state[offset] + filter[2] * state[offset + 1] - filter[3] * state[offset + 2] - filter[4] * state[offset + 3]; state[offset + 1] = state[offset]; state[offset] = input; state[offset + 3] = state[offset + 2]; state[offset + 2] = result; return result; }
static double filter_chain(double input, double filters[][9], int state_offset, int start, int end) { while (start < end) { input = filter_biquad(input, filters[start], state_offset + start * 4); start += 1; } return input; }
static double filter_soundboard(double input) {
 v128_t sum = wasm_f64x2_splat(0), current_input = wasm_f64x2_splat(input);
 for (int index = 0; index < SOUND_FILTER_COUNT; index += 2) {
  v128_t x1 = wasm_v128_load(state + SOUND_O + index), x2 = wasm_v128_load(state + SOUND_O + SOUND_FILTER_COUNT + index), y1 = wasm_v128_load(state + SOUND_O + 2 * SOUND_FILTER_COUNT + index), y2 = wasm_v128_load(state + SOUND_O + 3 * SOUND_FILTER_COUNT + index);
  v128_t result = wasm_f64x2_sub(wasm_f64x2_add(wasm_f64x2_add(wasm_f64x2_mul(wasm_v128_load(soundboard_filters[0] + index), current_input), wasm_f64x2_mul(wasm_v128_load(soundboard_filters[1] + index), x1)), wasm_f64x2_mul(wasm_v128_load(soundboard_filters[2] + index), x2)), wasm_f64x2_add(wasm_f64x2_mul(wasm_v128_load(soundboard_filters[3] + index), y1), wasm_f64x2_mul(wasm_v128_load(soundboard_filters[4] + index), y2)));
  wasm_v128_store(state + SOUND_O + SOUND_FILTER_COUNT + index, x1); wasm_v128_store(state + SOUND_O + index, current_input); wasm_v128_store(state + SOUND_O + 3 * SOUND_FILTER_COUNT + index, y1); wasm_v128_store(state + SOUND_O + 2 * SOUND_FILTER_COUNT + index, result);
  sum = wasm_f64x2_add(sum, wasm_f64x2_mul(wasm_v128_load(soundboard_filters[5] + index), result));
 }
 double lanes[2]; wasm_v128_store(lanes, sum); return lanes[0] + lanes[1];
}

__attribute__((noinline, minsize)) static void start_voice(Voice *target, uint32_t note_id, double note_hz, double velocity, double sample_rate, uint64_t serial) {
 memset(target, 0, sizeof(*target)); voice = target; target->sample_rate = sample_rate; initialize_filters(sample_rate); target->frequency = clamp(note_hz, 27.5, 4186.009044809578); target->strike_velocity = clamp(velocity, 0, 1); target->hammer_speed = piano_velocity_to_hammer_speed(target->strike_velocity); target->midi = 69 + 12 * log2(target->frequency / 440); target->reg = clamp((target->midi - 21) / 87, 0, 1); initialize_highres_radiation(target); target->piano_key = key_for_frequency(target->frequency); target->note_id = note_id; target->serial = serial; target->active = target->strike_velocity > 0; target->key_down = target->active; target->key_position = target->active; target->mode_gains_unity = 1; target->release_at = UINT32_MAX; target->damper_at = UINT32_MAX; target->damper_contact_at = UINT32_MAX; target->release_end_at = UINT32_MAX;
 target->inaudible_window = round(INAUDIBLE_SECONDS * sample_rate); target->release_quiet_samples = round(RELEASE_QUIET_SECONDS * sample_rate); /* The bridge smoothstep is within floating-point audio precision after 250 ms. */ target->bridge_settle_samples = round(.25 * sample_rate); double hearing_threshold = hearing_threshold_amplitude(); target->inaudible_threshold_energy = hearing_threshold * hearing_threshold * target->inaudible_window;
 create_hammer_force(target); target->mode_count = create_string_modes(target->frequency, target->strike_velocity, target->midi, target->reg, serial); target->active_mode_count = target->active_fast_mode_count = target->active_polarization_mode_count = target->mode_count; create_duplex_modes(target); create_impact_soundboard(target->strike_velocity, target->reg, target->midi); uint32_t noise_seed = seed_from_arguments(target->frequency, target->strike_velocity); target->noise_state = noise_seed ? noise_seed : 0x6d2b79f5; target->damper_noise_state = (noise_seed ^ 0x85ebca6b) ? (noise_seed ^ 0x85ebca6b) : 0x6d2b79f5; target->body_noise_state = (noise_seed ^ 0x9e3779b9) ? (noise_seed ^ 0x9e3779b9) : 0x6d2b79f5;
 double bass_compensation = 1 + .48 * clamp((45 - target->midi) / 24, 0, 1), bass_trim = lerp(.25, 1, transition((target->midi - 21) / 27)); target->damper_stage_samples = fmax(1, round(REGULATED_DAMPER_STAGE_SECONDS * sample_rate)); target->damper_noise_samples = fmax(1, round(.12 * sample_rate)); target->start_fade_samples = round(lerp(160, 32, transition((target->midi - 21) / 27)) * sample_rate / SAMPLE_RATE); target->velocity_gain = .3 * bass_compensation * bass_trim * pow(10, (register_radiation_db(target->midi) + radiation_velocity_db(target->midi, target->strike_velocity) + level_residual_db(target->midi, target->strike_velocity)) / 20) * hammer_speed_gain(target->hammer_speed);
 double hammer_cutoff = 1300 + 8600 * pow(target->strike_velocity, 1.55), bass_noise_transition = transition((target->midi - 36) / 24), diffuse_body_decay_seconds = lerp(2.6, 1.15, target->reg), top_body_transition = transition((target->midi - 93) / 12), bridge_position = .08 + .84 * pow(target->reg, .78); target->hammer_lowpass_step = 1 - exp(-TWO_PI * hammer_cutoff / sample_rate); target->mechanical_lowpass_step = 1 - exp(-TWO_PI * 950 / sample_rate); target->damper_lowpass_step = 1 - exp(-TWO_PI * 1150 / sample_rate); target->hammer_noise_samples = round(.085 * sample_rate); target->felt_presence_radiation = lerp(.12, 1, bass_noise_transition); target->felt_air_radiation = lerp(.04, 1, bass_noise_transition); target->strike_delay_samples = fmax(1, round(8 * sample_rate / SAMPLE_RATE)); target->thump_frequency = lerp(82, 155, target->reg) * lerp(.96, 1.08, target->strike_velocity); target->body_rise_pole = decay(1, .004); target->body_tail_pole = decay(1, diffuse_body_decay_seconds); target->plate_rise_pole = decay(1, .06); target->plate_tail_pole = decay(1, .45); target->felt_rise_pole = decay(1, .00055); target->felt_tail_pole = decay(1, .028); target->presence_rise_pole = decay(1, .00035); target->presence_tail_pole = decay(1, .07); target->early_rise_pole = decay(1, .0012); target->early_tail_pole = decay(1, .008); target->body_grain_tail_pole = decay(1, .032); target->thump_tail_pole = decay(1, .012); target->thump_rise_pole = decay(1, .00045); target->damper_rise_pole = decay(1, .0015); target->damper_tail_pole = decay(1, .026); target->diffuse_plate_register = clamp((target->midi - 57) / 36, 0, 1); target->upper_bridge_plate = 1 + 2 * bell(target->midi, 81, 10, 2); target->diffuse_low_body_scale = 1 - .97 * top_body_transition * sqrt(target->strike_velocity); target->stereo_lowpass_step = 1 - exp(-TWO_PI * 850 / sample_rate); target->stereo_position = 2 * target->reg - 1; target->radiation_lobe = sin(PI * (2.25 + 3.5 * target->reg) * bridge_position);
 double strike = target->strike_velocity; target->hammer_gains[0] = PIANO_HAMMER_FELT_GAIN * .024 * pow(strike, 1.55); target->hammer_gains[1] = PIANO_HAMMER_PRESENCE_GAIN * .05 * pow(strike, 1.75) * target->felt_presence_radiation; target->hammer_gains[2] = PIANO_HAMMER_PRESENCE_GAIN * .04 * pow(strike, 1.62) * target->felt_presence_radiation; target->hammer_gains[3] = PIANO_HAMMER_AIR_GAIN * .0022 * pow(strike, 1.9) * target->felt_air_radiation; target->hammer_gains[4] = PIANO_HAMMER_BODY_GAIN * .2 * pow(strike, .45) * target->reg * target->reg; target->hammer_gains[5] = PIANO_HAMMER_FELT_GAIN * .005 * pow(strike, 1.35); target->hammer_gains[6] = PIANO_HAMMER_PRESENCE_GAIN * .012 * pow(strike, 1.55) * target->felt_presence_radiation; target->hammer_gains[7] = PIANO_HAMMER_AIR_GAIN * .006 * pow(strike, 1.9) * target->felt_air_radiation; target->hammer_gains[8] = PIANO_HAMMER_BODY_GAIN * .03 * pow(strike, 1.2); target->hammer_gains[9] = .72 + .28 * target->reg;
 if (PIANO_RADIATION_LOSS_SCALE != 0) { const double cutoffs[3] = {250,900,2500}; for (int index = 0; index < 3; index += 1) target->radiation_step[index] = 1 - exp(-TWO_PI * cutoffs[index] / sample_rate); for (int band = 0; band < 4; band += 1) { double loss = PIANO_RADIATION_LOSS_SCALE * radiation_loss_db_per_second(target->midi, strike, band); target->radiation_pole[band] = exp(-M_LN10 * loss / (20 * sample_rate)); target->radiation_gain[band] = 1; } }
 if (PIANO_OUTPUT_EQ_ENABLED) { const double cutoffs[6] = {63,160,400,1000,2500,6300}, centers[7] = {35,100,250,630,1600,4000,10000}; double anchor = spectral_fit_db(target->midi, strike, target->frequency); for (int index = 0; index < 6; index += 1) target->output_eq_step[index] = 1 - exp(-TWO_PI * cutoffs[index] / sample_rate); for (int band = 0; band < 7; band += 1) { double fitted = PIANO_OUTPUT_EQ_SCALE * (spectral_fit_db(target->midi, strike, centers[band]) - anchor) + output_eq_residual_db(target->midi, strike, centers[band], target->frequency); target->output_eq_gain[band] = pow(10, clamp(fitted, -18, 18) / 20); } for (int band = 0; band < 6; band += 1) target->output_eq_weight[band] = target->output_eq_gain[band] - target->output_eq_gain[band + 1]; target->output_eq_normalization = output_eq_response(target->frequency, sample_rate, target->output_eq_step, target->output_eq_gain); }
 target->stereo_position = -target->stereo_position;
 double body_damper_slope_db = lerp(100, 180, target->reg); target->body_damper_free_pole = exp(-M_LN10 * body_damper_slope_db / (20 * sample_rate)); target->body_damper_regulated_pole = exp(-M_LN10 * .5 * body_damper_slope_db / (20 * sample_rate)); target->diffuse_body_gain = 1; target->string_mix = PIANO_STRING_MIX_BASE + PIANO_STRING_MIX_TREBLE * bell(target->midi, 93, 10, 2); target->body_rise_value = 1; target->body_tail_value = 1; target->plate_rise_value = 1; target->plate_tail_value = 1; target->felt_rise_value = 1; target->felt_tail_value = 1; target->presence_rise_value = 1; target->presence_tail_value = 1; target->early_rise_value = 1; target->early_tail_value = 1; target->body_grain_tail_value = 1; target->thump_tail_value = 1; target->thump_rise_value = 1; target->damper_rise_value = 1; target->damper_tail_value = 1; target->release_envelope_pole = decay(1, .03); target->dc_pole = pow(.99945, SAMPLE_RATE / sample_rate);
}

#undef state
#undef modes
#undef phase_drive
#undef mode_delays
#undef mode_cutoff
#undef fast_cutoffs
#undef polarization_cutoffs
#undef impact_state

__attribute__((noinline, minsize)) static void retrigger_voice(Voice *target, uint32_t note_id, double velocity, uint64_t serial) {
 uint32_t old_strike_index = target->age > (uint32_t)target->strike_delay_samples ? target->age - target->strike_delay_samples : 0; int old_mode_count = target->active_mode_count, old_fast_mode_count = target->active_fast_mode_count, old_polarization_mode_count = target->active_polarization_mode_count, old_impact_fast_count = target->impact_fast_count, old_impact_body_count = target->impact_body_count, old_impact_attack_count = target->impact_attack_count; double old_gain = target->velocity_gain;
 start_voice(&strike_template, note_id, target->frequency, velocity, target->sample_rate, serial); Voice *next = &strike_template; double state_scale = next->velocity_gain > 1e-300 ? old_gain / next->velocity_gain : 1; int common_modes = old_mode_count < next->mode_count ? old_mode_count : next->mode_count;
 for (int index = 0; index < common_modes; index += 1) { double vertical_scale = target->modes[17][index] * state_scale, slow_scale = vertical_scale * (1 - target->modes[21][index]), horizontal_scale = target->modes[20][index] * state_scale; next->modes[0][index] = target->modes[0][index] * vertical_scale; next->modes[1][index] = target->modes[1][index] * vertical_scale; next->modes[5][index] = target->modes[5][index] * slow_scale; next->modes[6][index] = target->modes[6][index] * slow_scale; next->modes[10][index] = target->modes[10][index] * horizontal_scale; next->modes[11][index] = target->modes[11][index] * horizontal_scale; next->modes[15][index] = target->modes[15][index]; uint32_t remaining = target->mode_cutoff[index] > old_strike_index ? target->mode_cutoff[index] - old_strike_index : 0; if (next->mode_cutoff[index] < remaining) next->mode_cutoff[index] = remaining; }
 for (int index = 0; index < common_modes; index += 1) { if (index < old_fast_mode_count) { uint32_t remaining = target->fast_mode_cutoff[index] > old_strike_index ? target->fast_mode_cutoff[index] - old_strike_index : 0; if (next->fast_mode_cutoff[index] < remaining) next->fast_mode_cutoff[index] = remaining; } if (index < old_polarization_mode_count) { uint32_t remaining = target->polarization_mode_cutoff[index] > old_strike_index ? target->polarization_mode_cutoff[index] - old_strike_index : 0; if (next->polarization_mode_cutoff[index] < remaining) next->polarization_mode_cutoff[index] = remaining; } }
 for (int index = next->mode_count; index < old_mode_count; index += 1) { for (int row = 0; row < MODE_ROWS; row += 1) next->modes[row][index] = target->modes[row][index]; for (int row = 0; row < 3; row += 1) next->phase_drive[row][index] = 0; next->unison_weights[index] = target->unison_weights[index]; next->unison_inverse[index] = target->unison_inverse[index]; next->unison_shares[index] = target->unison_shares[index]; next->mode_delays[0][index] = target->mode_delays[0][index]; next->mode_delays[1][index] = target->mode_delays[1][index]; double vertical_scale = target->modes[17][index] * state_scale, slow_scale = vertical_scale * (1 - target->modes[21][index]), horizontal_scale = target->modes[20][index] * state_scale; next->modes[0][index] *= vertical_scale; next->modes[1][index] *= vertical_scale; next->modes[5][index] *= slow_scale; next->modes[6][index] *= slow_scale; next->modes[10][index] *= horizontal_scale; next->modes[11][index] *= horizontal_scale; next->modes[4][index] = next->modes[9][index] = next->modes[14][index] = 0; next->modes[17][index] = next->modes[20][index] = 1; next->mode_cutoff[index] = target->mode_cutoff[index] > old_strike_index ? target->mode_cutoff[index] - old_strike_index : 0; }
 for (int index = next->mode_count; index < old_mode_count; index += 1) { next->fast_mode_cutoff[index] = index < old_fast_mode_count && target->fast_mode_cutoff[index] > old_strike_index ? target->fast_mode_cutoff[index] - old_strike_index : 0; next->polarization_mode_cutoff[index] = index < old_polarization_mode_count && target->polarization_mode_cutoff[index] > old_strike_index ? target->polarization_mode_cutoff[index] - old_strike_index : 0; }
 if (old_mode_count > next->mode_count) next->mode_count = old_mode_count; next->active_mode_count = next->mode_count; if (next->active_fast_mode_count < old_fast_mode_count) next->active_fast_mode_count = old_fast_mode_count; if (next->active_polarization_mode_count < old_polarization_mode_count) next->active_polarization_mode_count = old_polarization_mode_count; int old_coupled_count = target->coupled_mode_count < old_mode_count ? target->coupled_mode_count : old_mode_count; if (next->coupled_mode_count < old_coupled_count) next->coupled_mode_count = old_coupled_count;
 for (int index = 0; index < IMPACT_COUNT; index += 1) { next->impact_state[0][index] = target->impact_state[0][index] * state_scale; next->impact_state[1][index] = target->impact_state[1][index] * state_scale; next->impact_state[5][index] = target->impact_state[5][index] * state_scale; next->impact_state[6][index] = target->impact_state[6][index] * state_scale; next->impact_state[10][index] = target->impact_state[10][index] * state_scale; next->impact_state[11][index] = target->impact_state[11][index] * state_scale; next->impact_state[15][index] = fmax(next->impact_state[15][index], target->impact_state[15][index]); }
 for (int index = 0; index < IMPACT_COUNT; index += 1) { if (index < old_impact_fast_count) { uint32_t remaining = target->impact_fast_cutoff[index] > old_strike_index ? target->impact_fast_cutoff[index] - old_strike_index : 0; if (next->impact_fast_cutoff[index] < remaining) next->impact_fast_cutoff[index] = remaining; } if (index < old_impact_body_count) { uint32_t remaining = target->impact_slow_cutoff[index] > old_strike_index ? target->impact_slow_cutoff[index] - old_strike_index : 0; if (next->impact_slow_cutoff[index] < remaining) next->impact_slow_cutoff[index] = remaining; } if (index < old_impact_attack_count) { uint32_t remaining = target->impact_attack_cutoff[index] > old_strike_index ? target->impact_attack_cutoff[index] - old_strike_index : 0; if (next->impact_attack_cutoff[index] < remaining) next->impact_attack_cutoff[index] = remaining; } }
 for (int index = SOUND_O; index < STATE_COUNT; index += 1) next->state[index] = target->state[index] * state_scale; for (int index = 0; index < 2; index += 1) { next->duplex[index][0] = target->duplex[index][0]; next->duplex[index][1] = target->duplex[index][1]; }
 next->previous_input = target->previous_input; next->dc_blocker = target->dc_blocker; next->bridge_output = target->bridge_output; next->previous_sympathetic_force = target->previous_sympathetic_force; next->stereo_lowpass = target->stereo_lowpass; next->stereo_side = target->stereo_side; next->start_fade_samples = 0; memcpy(target, next, sizeof(*target)); voice = target;
}

#define state (voice->state)
#define modes (voice->modes)
#define phase_drive (voice->phase_drive)
#define mode_delays (voice->mode_delays)
#define mode_cutoff (voice->mode_cutoff)
#define fast_cutoffs (voice->fast_mode_cutoff)
#define polarization_cutoffs (voice->polarization_mode_cutoff)
#define impact_state (voice->impact_state)

static inline double normalize_release_speed(double velocity) { return clamp(velocity, 0, 1); }

static int damper_decay_length(Voice *target, double release_speed) {
 voice = target; double slowest_slope_db = 1e9; for (int index = 0; index < target->mode_count; index += 1) { double slope_db = -20 * target->sample_rate * log(modes[18][index]) / M_LN10; slowest_slope_db = fmin(slowest_slope_db, slope_db); }
 double settle_seconds = (double)target->damper_settle_samples / target->sample_rate, early_slope_db = slowest_slope_db * (.5 + .5 * release_speed), early_loss_db = early_slope_db * fmax(0, REGULATED_DAMPER_STAGE_SECONDS - .5 * settle_seconds), remaining_loss_db = fmax(0, DAMPER_RETIREMENT_DB - early_loss_db), decay_seconds = REGULATED_DAMPER_STAGE_SECONDS + remaining_loss_db / slowest_slope_db; return fmax(1, round(decay_seconds * target->sample_rate));
}

static void release_voice(Voice *target, double velocity) {
 if (!target->active || target->released) return; target->released = 1; target->release_at = target->age; target->release_speed = normalize_release_speed(velocity); if (!target->key_motion_controlled) target->key_position = 0; target->quiet_samples = 0;
 if (target->midi >= FIRST_UNDAMPED_MIDI - .5) { target->damper_at = UINT32_MAX; target->release_samples = 0; target->release_end_at = target->age; return; }
 double travel_seconds = lerp(.085, .045, pow(target->release_speed, .65)); uint32_t travel_samples = round(travel_seconds * target->sample_rate), earliest_contact = round(MINIMUM_DAMPER_CONTACT_SECONDS * target->sample_rate); target->damper_at = target->age + travel_samples; if (target->damper_at < earliest_contact) target->damper_at = earliest_contact;
 target->damper_settle_samples = fmax(1, round(lerp(.03, .004, target->release_speed) * target->sample_rate)); target->release_samples = damper_decay_length(target, target->release_speed); target->release_end_at = target->damper_at + target->release_samples; target->damper_noise_gain = .011 * (.35 + .65 * target->release_speed); target->damper_rise_pole = exp(-1 / (lerp(.006, .0015, target->release_speed) * target->sample_rate)); target->damper_tail_pole = exp(-1 / (lerp(.05, .026, target->release_speed) * target->sample_rate)); target->damper_rise_value = 1; target->damper_tail_value = 1; target->damper_lowpass = 0;
}

static inline void catch_damper(Voice *target) { if (!target->active || target->key_down || !target->released || target->midi >= FIRST_UNDAMPED_MIDI - .5) return; target->released = 0; target->release_at = UINT32_MAX; target->damper_at = UINT32_MAX; target->damper_contact_at = UINT32_MAX; target->release_end_at = UINT32_MAX; target->quiet_samples = 0; }

static double step_voice(Voice *target, double sympathetic_force) {
 voice = target; int sample_index = target->age, strike_index = sample_index - target->strike_delay_samples, released = target->released;
 uint32_t damper_index = 0; double damper_strength = 0, free_return_blend = 1, body_damper_pole = 1;
 if (released && target->damper_at != UINT32_MAX && (uint32_t)sample_index >= target->damper_at) {
  double return_ramp = transition((double)(sample_index - target->damper_at + 1) / target->damper_settle_samples);
  double key_lift = transition((target->key_position - .18) / .5);
  damper_strength = return_ramp * damper_interaction_strength(target) * (1 - key_lift);
 }
 if (damper_strength > 1e-9) {
  if (target->damper_contact_at == UINT32_MAX) {
   target->damper_contact_at = sample_index;
   target->contact_speed = sustain_pedal.velocity < 0 ? clamp(-sustain_pedal.velocity / (sustain_pedal.omega / exp(1)), 0, 1) : target->release_speed;
   target->damper_noise_gain = .011 * (.35 + .65 * target->contact_speed);
   target->damper_rise_value = target->damper_tail_value = 1;
  }
  damper_index = sample_index - target->damper_contact_at;
  free_return_blend = damper_index < (uint32_t)target->damper_stage_samples ? target->contact_speed : 1;
  body_damper_pole = lerp(1, lerp(target->body_damper_regulated_pole, target->body_damper_free_pole, free_return_blend), damper_strength);
 } else target->damper_contact_at = UINT32_MAX; double force = strike_index >= 0 && strike_index < target->hammer_samples ? state[FORCE_O + strike_index] : 0, diffuse_body = 0;
 if (body_damper_pole < 1) target->diffuse_body_gain *= body_damper_pole; if (strike_index >= 0) { target->body_noise_state ^= target->body_noise_state << 13; target->body_noise_state ^= target->body_noise_state >> 17; target->body_noise_state ^= target->body_noise_state << 5; double body_white = (double)target->body_noise_state / 4294967296.0 * 2 - 1, body_grain = filter_chain(body_white, noise_filters, NOISE_O, 9, 12), plate_grain = filter_chain(body_white, noise_filters, NOISE_O, 12, 14), body_rise = 1 - target->body_rise_value, body_tail = target->body_tail_value, plate_rise = 1 - target->plate_rise_value, plate_tail = target->plate_tail_value; diffuse_body = target->diffuse_body_gain * (PIANO_DIFFUSE_BODY_GAIN * (1.7 - 1.4 * target->strike_velocity) * (.55 + .45 * target->reg) * target->diffuse_low_body_scale * body_grain * body_rise * body_tail + PIANO_DIFFUSE_PLATE_GAIN * target->diffuse_plate_register * target->upper_bridge_plate * plate_grain * plate_rise * plate_tail); }
 while (target->active_mode_count > 0 && strike_index >= 0 && (uint32_t)strike_index >= mode_cutoff[target->active_mode_count - 1]) target->active_mode_count -= 1; while (target->active_fast_mode_count > 0 && strike_index >= 0 && (uint32_t)strike_index >= fast_cutoffs[target->active_fast_mode_count - 1]) target->active_fast_mode_count -= 1; while (target->active_polarization_mode_count > 0 && strike_index >= 0 && (uint32_t)strike_index >= polarization_cutoffs[target->active_polarization_mode_count - 1]) target->active_polarization_mode_count -= 1; if (target->active_fast_mode_count > target->active_mode_count) target->active_fast_mode_count = target->active_mode_count; if (target->active_polarization_mode_count > target->active_mode_count) target->active_polarization_mode_count = target->active_mode_count; while (target->impact_fast_count > 0 && strike_index >= 0 && (uint32_t)strike_index >= target->impact_fast_cutoff[target->impact_fast_count - 1]) target->impact_fast_count -= 1; while (target->impact_body_count > 0 && strike_index >= 0 && (uint32_t)strike_index >= target->impact_slow_cutoff[target->impact_body_count - 1]) target->impact_body_count -= 1; while (target->impact_attack_count > 0 && strike_index >= 0 && (uint32_t)strike_index >= target->impact_attack_cutoff[target->impact_attack_count - 1]) target->impact_attack_count -= 1; double open_string_force = (1 - damper_strength) * sympathetic_force, strings = strike_index < target->hammer_samples + 3 ? filter_driven_strings(target->active_mode_count, strike_index, target->hammer_samples, damper_strength, free_return_blend) : filter_free_modes(target->active_mode_count, damper_strength, free_return_blend, open_string_force), hammer = 0;
 if (strike_index >= 0 && strike_index < target->hammer_noise_samples) { target->noise_state ^= target->noise_state << 13; target->noise_state ^= target->noise_state >> 17; target->noise_state ^= target->noise_state << 5; double white = (double)target->noise_state / 4294967296.0 * 2 - 1; target->hammer_lowpass += target->hammer_lowpass_step * (white - target->hammer_lowpass); double felt_lowpassed = filter_chain(white, noise_filters, NOISE_O, 0, 3), felt_presence = filter_biquad(felt_lowpassed, noise_filters[3], NOISE_O + 12), felt_air = filter_chain(white, noise_filters, NOISE_O, 4, 6), body_grain = filter_chain(white, noise_filters, NOISE_O, 6, 9); target->mechanical_lowpass += target->mechanical_lowpass_step * (white - target->mechanical_lowpass); double lingering_felt = felt_lowpassed * (1 - target->felt_rise_value) * target->felt_tail_value, lingering_presence = felt_presence * (1 - target->presence_rise_value) * target->presence_tail_value, early_presence = felt_presence * (1 - target->early_rise_value) * target->early_tail_value, lingering_air = felt_air * (1 - target->presence_rise_value) * target->presence_tail_value, body_grain_envelope = (1 - target->body_rise_value) * target->body_grain_tail_value; hammer = target->hammer_gains[0] * lingering_felt + target->hammer_gains[1] * lingering_presence + target->hammer_gains[2] * early_presence + target->hammer_gains[3] * lingering_air + target->hammer_gains[4] * body_grain * body_grain_envelope; if (strike_index < target->hammer_samples) { double collision_shape = state[FORCE_O + strike_index] * target->hammer_samples, collision = sqrt(collision_shape), felt = target->hammer_lowpass * collision, felt_contact = felt_presence * collision, air_contact = felt_air * collision, mechanical_impact = target->hammer_gains[8] * target->mechanical_lowpass * collision, thump = sin(TWO_PI * target->thump_frequency * strike_index / target->sample_rate) * target->thump_tail_value * (1 - target->thump_rise_value); hammer += (target->hammer_gains[5] * felt + target->hammer_gains[6] * felt_contact + target->hammer_gains[7] * air_contact + mechanical_impact + .006 * thump) * target->hammer_gains[9]; } }
 double damper = 0; if (damper_strength > 0 && damper_index < (uint32_t)target->damper_noise_samples) { double contact_position = (double)damper_index / target->damper_noise_samples; target->damper_noise_state ^= target->damper_noise_state << 13; target->damper_noise_state ^= target->damper_noise_state >> 17; target->damper_noise_state ^= target->damper_noise_state << 5; double white = (double)target->damper_noise_state / 4294967296.0 * 2 - 1; target->damper_lowpass += target->damper_lowpass_step * (white - target->damper_lowpass); double noise_envelope = damper_strength * (1 - target->damper_rise_value) * target->damper_tail_value * sin(PI * contact_position); damper = target->damper_noise_gain * (.7 + .3 * sqrt(target->strike_velocity)) * target->damper_lowpass * noise_envelope; target->damper_rise_value *= target->damper_rise_pole; target->damper_tail_value *= target->damper_tail_pole; }
 couple_unison_modes(target); hammer += diffuse_body; target->bridge_output = target->velocity_gain * strings; double excitation = strings + hammer, body = filter_soundboard(excitation), impact_body = filter_impact_soundboard(force), duplex = filter_duplex_modes(target, open_string_force); if (body_damper_pole < 1) damp_coupled_body(body_damper_pole); double sample = target->velocity_gain * (target->string_mix * strings + PIANO_SOUNDBOARD_GAIN * body + PIANO_IMPACT_GAIN * impact_body + PIANO_HAMMER_GAIN * hammer + damper) + duplex; if (PIANO_RADIATION_LOSS_SCALE != 0) { v128_t input = wasm_f64x2_splat(sample), state01 = wasm_v128_load(target->radiation_state), gain01 = wasm_v128_load(target->radiation_gain), gain23 = wasm_v128_load(target->radiation_gain + 2), low = wasm_f64x2_splat(.1), high = wasm_f64x2_splat(4); state01 = wasm_f64x2_add(state01, wasm_f64x2_mul(wasm_v128_load(target->radiation_step), wasm_f64x2_sub(input, state01))); wasm_v128_store(target->radiation_state, state01); target->radiation_state[2] += target->radiation_step[2] * (sample - target->radiation_state[2]); gain01 = wasm_f64x2_min(high, wasm_f64x2_max(low, wasm_f64x2_mul(gain01, wasm_v128_load(target->radiation_pole)))); gain23 = wasm_f64x2_min(high, wasm_f64x2_max(low, wasm_f64x2_mul(gain23, wasm_v128_load(target->radiation_pole + 2)))); wasm_v128_store(target->radiation_gain, gain01); wasm_v128_store(target->radiation_gain + 2, gain23); sample = (target->radiation_gain[0] - target->radiation_gain[1]) * target->radiation_state[0] + (target->radiation_gain[1] - target->radiation_gain[2]) * target->radiation_state[1] + (target->radiation_gain[2] - target->radiation_gain[3]) * target->radiation_state[2] + target->radiation_gain[3] * sample; } if (PIANO_OUTPUT_EQ_ENABLED) { v128_t input = wasm_f64x2_splat(sample), sum = wasm_f64x2_splat(0); for (int index = 0; index < 6; index += 2) { v128_t state_pair = wasm_v128_load(target->output_eq_state + index); state_pair = wasm_f64x2_add(state_pair, wasm_f64x2_mul(wasm_v128_load(target->output_eq_step + index), wasm_f64x2_sub(input, state_pair))); wasm_v128_store(target->output_eq_state + index, state_pair); sum = wasm_f64x2_add(sum, wasm_f64x2_mul(wasm_v128_load(target->output_eq_weight + index), state_pair)); } double lanes[2]; wasm_v128_store(lanes, sum); sample = (lanes[0] + lanes[1] + target->output_eq_gain[6] * sample) / target->output_eq_normalization; } sample = .94 * saturate(1.12 * sample); double highpassed = sample - target->previous_input + target->dc_pole * target->dc_blocker; target->previous_input = sample; target->dc_blocker = highpassed; sample = highpassed;
 if (sample_index < target->start_fade_samples) { double start_fade = .5 - .5 * cos(PI * sample_index / (target->start_fade_samples - 1)); sample *= start_fade * start_fade; } if (strike_index >= 0) { target->body_rise_value *= target->body_rise_pole; target->body_tail_value *= target->body_tail_pole; target->plate_rise_value *= target->plate_rise_pole; target->plate_tail_value *= target->plate_tail_pole; } if (strike_index >= 0 && strike_index < target->hammer_noise_samples) { target->felt_rise_value *= target->felt_rise_pole; target->felt_tail_value *= target->felt_tail_pole; target->presence_rise_value *= target->presence_rise_pole; target->presence_tail_value *= target->presence_tail_pole; target->early_rise_value *= target->early_rise_pole; target->early_tail_value *= target->early_tail_pole; target->body_grain_tail_value *= target->body_grain_tail_pole; target->thump_tail_value *= target->thump_tail_pole; target->thump_rise_value *= target->thump_rise_pole; }
 target->stereo_lowpass += target->stereo_lowpass_step * (sample - target->stereo_lowpass); double high_radiation = sample - target->stereo_lowpass; target->stereo_side = (.147 * target->stereo_position + .075 * target->radiation_lobe) * high_radiation + .018 * target->stereo_position * target->stereo_lowpass; double absolute_sample = fabs(sample); target->output_peak = fmax(target->output_peak, absolute_sample); target->output_envelope = fmax(absolute_sample, target->output_envelope * target->release_envelope_pole); int release_spent = released && target->release_end_at != UINT32_MAX && (uint32_t)sample_index >= target->release_end_at, natural_modes_spent = strike_index >= 0 && target->active_mode_count == 0; double relative_quiet_threshold = fmax(1e-9, target->output_peak * 1e-4), absolute_quiet_threshold = hearing_threshold_amplitude(); if ((release_spent || natural_modes_spent) && target->output_envelope <= fmin(relative_quiet_threshold, absolute_quiet_threshold)) target->quiet_samples += 1; else target->quiet_samples = 0; target->inaudible_energy += sample * sample; double audible_bridge = SYMPATHETIC_BRIDGE_GAIN * target->bridge_output; target->inaudible_bridge_energy += audible_bridge * audible_bridge; target->inaudible_samples += 1; if (target->inaudible_samples >= target->inaudible_window) { double threshold_energy = target->inaudible_threshold_energy; if (target->inaudible_energy > threshold_energy || target->inaudible_bridge_energy > threshold_energy) { target->inaudible_samples = 0; target->inaudible_energy = target->inaudible_bridge_energy = 0; } } target->age += 1; return sample;
}

static int planned_release_span(Voice *target, double velocity) {
 if (target->midi >= FIRST_UNDAMPED_MIDI - .5) return 0; double release_speed = normalize_release_speed(velocity), travel_seconds = lerp(.085, .045, pow(release_speed, .65)); target->damper_settle_samples = fmax(1, round(lerp(.03, .004, release_speed) * target->sample_rate)); return round(travel_seconds * target->sample_rate) + damper_decay_length(target, release_speed);
}

__attribute__((export_name("synthesize"))) int synthesize(double note_hz, double velocity, double duration_seconds) {
 double duration = clamp(duration_seconds, 0, 30), strike_velocity = clamp(velocity, 0, 1); int sample_count = round(duration * SAMPLE_RATE); if (sample_count == 0) return 0; if (strike_velocity == 0) { memset(output, 0, sample_count * sizeof(float)); return sample_count; }
 start_voice(&offline_voice, 0, note_hz, strike_velocity, SAMPLE_RATE, 0); int physical_release_span = planned_release_span(&offline_voice, DEFAULT_RELEASE_SPEED), maximum_offline_release_span = round(.25 * SAMPLE_RATE), planned_span = fmin(physical_release_span, maximum_offline_release_span), release_start = offline_voice.midi >= FIRST_UNDAMPED_MIDI - .5 ? 0 : sample_count - fmin(sample_count, planned_span), final_fade_samples = fmin(sample_count, 256);
 for (int sample_index = 0; sample_index < sample_count; sample_index += 1) { if (sample_index == release_start) release_voice(&offline_voice, DEFAULT_RELEASE_SPEED); double sample = step_voice(&offline_voice, 0); if (sample_index >= sample_count - final_fade_samples) { int remaining = sample_count - 1 - sample_index; double end_fade = .5 - .5 * cos(PI * remaining / (final_fade_samples - 1 ? final_fade_samples - 1 : 1)); sample *= end_fade; } output[sample_index] = fmin(.94, fmax(-.94, sample)); }
 output[0] = 0; output[sample_count - 1] = 0; return sample_count;
}

static int queue_event(uint32_t type, uint32_t note_id, double value, double velocity, uint32_t offset) { if (queued_events >= EVENT_COUNT) return -1; uint32_t position = queued_events; while (position && events[position - 1].offset > offset) { events[position] = events[position - 1]; position -= 1; } Event *event = events + position; queued_events += 1; event->type = type; event->note_id = note_id; event->offset = offset; event->reserved = 0; event->value = value; event->velocity = velocity; return 0; }
static Voice *find_voice(uint32_t note_id) { Voice *newest = 0; for (uint32_t index = 0; index < realtime_scan_limit; index += 1) if (voices[index].active && voices[index].note_id == note_id && (!newest || voices[index].serial > newest->serial)) newest = voices + index; return newest; }
static Voice *find_key_voice(double frequency) { uint8_t piano_key = key_for_frequency(frequency); Voice *newest = 0; for (uint32_t index = 0; index < realtime_scan_limit; index += 1) if (voices[index].active && voices[index].piano_key == piano_key && (!newest || voices[index].serial > newest->serial)) newest = voices + index; return newest; }
static int quieter_voice(Voice *target, Voice *candidate) { return !candidate || target->output_envelope < candidate->output_envelope || (target->output_envelope == candidate->output_envelope && target->serial < candidate->serial); }
static Voice *claim_voice(void) { Voice *candidate = 0; for (uint32_t index = 0; index < realtime_scan_limit; index += 1) if (!voices[index].active) return voices + index; if (realtime_scan_limit < realtime_voice_limit) return voices + realtime_scan_limit++; for (uint32_t index = 0; index < realtime_scan_limit; index += 1) if (voices[index].released && damper_contact(sustain_lift) > 0 && quieter_voice(voices + index, candidate)) candidate = voices + index; if (candidate) return candidate; for (uint32_t index = 0; index < realtime_scan_limit; index += 1) if (!voices[index].key_down && quieter_voice(voices + index, candidate)) candidate = voices + index; if (candidate) return candidate; for (uint32_t index = 0; index < realtime_scan_limit; index += 1) if (quieter_voice(voices + index, candidate)) candidate = voices + index; return candidate; }
static inline void deactivate_voice(uint32_t index) { voices[index].active = 0; active_voices -= 1; if (index + 1 == realtime_scan_limit) while (realtime_scan_limit && !voices[realtime_scan_limit - 1].active) realtime_scan_limit -= 1; }
static void apply_event(const Event *event) {
 if (event->type == 1) {
  Voice *identity = find_voice(event->note_id);
  if (event->velocity <= 0) { if (identity) { identity->key_down = 0; release_voice(identity, DEFAULT_RELEASE_SPEED); } return; }
  Voice *target = find_key_voice(event->value); double strike_velocity = event->velocity;
  if (identity && identity->key_motion_controlled) { double action_return = transition((.72 - identity->key_position) / .52); strike_velocity *= lerp(.72, 1, action_return); }
  if (identity && identity != target) { identity->key_down = 0; release_voice(identity, DEFAULT_RELEASE_SPEED); }
  if (target) { retrigger_voice(target, event->note_id, strike_velocity, ++next_serial); return; }
  target = claim_voice(); if (!target->active) active_voices += 1;
  start_voice(target, event->note_id, event->value, strike_velocity, realtime_rate, ++next_serial); return;
 }
 if (event->type == 2) { Voice *target = find_voice(event->note_id); if (target) { target->key_down = 0; release_voice(target, event->value); } return; }
 /* Events set targets. The mechanics, including while silent, run on the audio clock. */
 if (event->type == 3) sustain_pedal.target = clamp(event->value, 0, 1);
 if (event->type == 4) soft_pedal.target = clamp(event->value, 0, 1);
 if (event->type == 5) {
  Voice *target = find_voice(event->note_id); if (!target) return;
  double position = clamp(event->value, 0, 1); target->key_motion_controlled = 1; target->key_position = position;
  if (position < .08 && target->key_down) { target->key_down = 0; release_voice(target, event->velocity); }
  else if (position > .68 && target->released) { catch_damper(target); target->key_down = 1; }
 }
}

static inline void advance_pedals(void) {
 piano_pedal_step(&sustain_pedal, 1 / realtime_rate);
 piano_pedal_step(&soft_pedal, 1 / realtime_rate);
 sustain_lift = sustain_pedal.position; una_corda_position = soft_pedal.position;
}
/* Path selection and retirement happen per sample, so neither pedal motion nor
 * coupling can depend on how the caller partitions its render blocks. */
static void render_segment(uint32_t start, uint32_t end) {
 for (uint32_t frame = start; frame < end; ++frame) {
  int dense = active_voices > DENSE_VOICE_THRESHOLD;
  double previous_bus = isfinite(sympathetic_bridge_bus) ? sympathetic_bridge_bus : 0, next_bus = 0;
  for (uint32_t index = 0; index < realtime_scan_limit; ++index) {
   Voice *target = voices + index; if (!target->active) continue;
   double force = dense ? 0 : SYMPATHETIC_BRIDGE_GAIN * (previous_bus - target->bridge_output);
   double sample = step_voice(target, force);
   if (!isfinite(sample) || !isfinite(target->bridge_output) || fabs(target->bridge_output) > 16) { memset(target, 0, sizeof(Voice)); deactivate_voice(index); continue; }
   realtime_mix[frame] += sample; realtime_side[frame] += target->stereo_side; next_bus += target->bridge_output;
   if (target->quiet_samples >= target->release_quiet_samples || target->inaudible_samples >= target->inaudible_window) deactivate_voice(index);
  }
  sympathetic_bridge_bus = !dense && isfinite(next_bus) ? next_bus : 0;
  advance_pedals();
 }
}

__attribute__((export_name("rt_output_ptr"))) uintptr_t realtime_output_ptr(void) { return (uintptr_t)realtime_output; }
__attribute__((export_name("rt_output_left_ptr"))) uintptr_t realtime_output_left_ptr(void) { return (uintptr_t)realtime_output_left; }
__attribute__((export_name("rt_output_right_ptr"))) uintptr_t realtime_output_right_ptr(void) { return (uintptr_t)realtime_output_right; }
__attribute__((export_name("rt_reset"))) int reset(double sample_rate, uint32_t voice_limit) { if (!isfinite(sample_rate) || sample_rate < 32000 || sample_rate > 96000 || voice_limit < 1 || voice_limit > MAX_VOICES) return -1; memset(voices, 0, sizeof(voices)); memset(realtime_output, 0, sizeof(realtime_output)); memset(realtime_output_left, 0, sizeof(realtime_output_left)); memset(realtime_output_right, 0, sizeof(realtime_output_right)); memset(realtime_mix, 0, sizeof(realtime_mix)); memset(realtime_side, 0, sizeof(realtime_side)); realtime_rate = sample_rate; realtime_voice_limit = voice_limit; realtime_scan_limit = 0; queued_events = 0; active_voices = 0; next_serial = 0; sustain_lift = 0; una_corda_position = 0; piano_pedal_reset(&sustain_pedal, PIANO_SUSTAIN_RESPONSE_SECONDS, sample_rate); piano_pedal_reset(&soft_pedal, PIANO_UNA_CORDA_RESPONSE_SECONDS, sample_rate); sympathetic_bridge_bus = 0; realtime_limiter_gain = 1; realtime_limiter_release_step = 1 - exp(-1 / (REALTIME_BUS_LIMIT_RELEASE_SECONDS * sample_rate)); left_microphone_state = 0; right_microphone_state = 0; left_microphone_step = 1 - exp(-TWO_PI * 12000 / sample_rate); right_microphone_step = 1 - exp(-TWO_PI * 10500 / sample_rate); voice = &offline_voice; initialize_filters(sample_rate); return 0; }
__attribute__((export_name("rt_note_on"))) int note_on(uint32_t note_id, double note_hz, double velocity, uint32_t offset) { if (!isfinite(note_hz) || !isfinite(velocity)) return -2; return queue_event(1, note_id, note_hz, velocity, offset); }
__attribute__((export_name("rt_note_off"))) int note_off(uint32_t note_id, double release_velocity, uint32_t offset) { if (!isfinite(release_velocity)) return -2; return queue_event(2, note_id, release_velocity, 0, offset); }
__attribute__((export_name("rt_sustain"))) int sustain(double lift, uint32_t offset) { if (!isfinite(lift)) return -2; return queue_event(3, 0, clamp(lift, 0, 1), 0, offset); }
__attribute__((export_name("rt_una_corda"))) int una_corda(double position, uint32_t offset) { if (!isfinite(position)) return -2; return queue_event(4, 0, clamp(position, 0, 1), 0, offset); }
__attribute__((export_name("rt_key_position"))) int key_position(uint32_t note_id, double position, double speed, uint32_t offset) { if (!isfinite(position) || !isfinite(speed)) return -2; return queue_event(5, note_id, clamp(position, 0, 1), clamp(speed, 0, 1), offset); }
__attribute__((export_name("rt_process"))) int process(uint32_t frame_count) { if (frame_count > BLOCK_SIZE) return -1; memset(realtime_mix, 0, frame_count * sizeof(double)); memset(realtime_side, 0, frame_count * sizeof(double)); initialize_filters(realtime_rate); uint32_t cursor = 0, event_index = 0; while (event_index < queued_events && events[event_index].offset < frame_count) { uint32_t offset = events[event_index].offset; render_segment(cursor, offset); do { apply_event(events + event_index); event_index += 1; } while (event_index < queued_events && events[event_index].offset == offset); cursor = offset; } render_segment(cursor, frame_count); for (uint32_t frame = 0; frame < frame_count; frame += 1) { double mid = realtime_mix[frame], side = realtime_side[frame], left = mid + side, right = mid - side; if (!isfinite(mid) || !isfinite(side)) { mid = side = left = right = 0; sympathetic_bridge_bus = 0; } if (!isfinite(left_microphone_state)) left_microphone_state = 0; if (!isfinite(right_microphone_state)) right_microphone_state = 0; left_microphone_state += left_microphone_step * (left - left_microphone_state); right_microphone_state += right_microphone_step * (right - right_microphone_state); double left_output = .88 * left + .12 * left_microphone_state, right_output = .86 * right + .14 * right_microphone_state, bus_peak = fmax(fabs(mid), fmax(fabs(left_output), fabs(right_output))), target_gain = bus_peak > REALTIME_BUS_LIMIT ? REALTIME_BUS_LIMIT / bus_peak : 1; realtime_limiter_gain = target_gain < realtime_limiter_gain ? target_gain : fmin(target_gain, realtime_limiter_gain + realtime_limiter_release_step * (1 - realtime_limiter_gain)); realtime_output[frame] = mid * realtime_limiter_gain; realtime_output_left[frame] = left_output * realtime_limiter_gain; realtime_output_right[frame] = right_output * realtime_limiter_gain; } uint32_t future_count = queued_events - event_index; if (future_count) memmove(events, events + event_index, future_count * sizeof(Event)); queued_events = future_count; for (uint32_t index = 0; index < queued_events; index += 1) events[index].offset -= frame_count; return frame_count; }
__attribute__((export_name("rt_voice_count"))) uint32_t voice_count(void) { return active_voices; }
__attribute__((export_name("rt_voice_capacity"))) uint32_t voice_capacity(void) { return MAX_VOICES; }
__attribute__((export_name("rt_voice_limit"))) uint32_t voice_limit(void) { return realtime_voice_limit; }
__attribute__((export_name("rt_note_active"))) int note_active(uint32_t note_id) { return find_voice(note_id) != 0; }
__attribute__((export_name("rt_sample_rate"))) double realtime_sample_rate(void) { return realtime_rate; }

/* Read-only physical state for diagnostics and numerical validation. */
__attribute__((export_name("rt_pedal_position"))) double pedal_position(uint32_t soft) { return soft ? soft_pedal.position : sustain_pedal.position; }
__attribute__((export_name("rt_pedal_velocity"))) double pedal_velocity(uint32_t soft) { return soft ? soft_pedal.velocity : sustain_pedal.velocity; }
__attribute__((export_name("rt_hammer_contact"))) double hammer_contact(uint32_t id) { Voice *target = find_voice(id); return target ? target->hammer_contact_seconds : 0; }
__attribute__((export_name("rt_hammer_impulse"))) double hammer_impulse(uint32_t id) { Voice *target = find_voice(id); return target ? target->hammer_impulse : 0; }
__attribute__((export_name("rt_string_contact"))) double string_contact(uint32_t id, uint32_t string) { Voice *target = find_voice(id); return target && string < (uint32_t)target->string_count ? target->contact_weights[string] : 0; }
__attribute__((export_name("rt_string_motion"))) double string_motion(uint32_t id, uint32_t string) { Voice *target = find_voice(id); if (!target || string >= (uint32_t)target->string_count) return 0; voice = target; return modes[5][string] / target->unison_weights[string]; }
