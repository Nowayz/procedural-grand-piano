# Procedural grand piano

`synthesizeGrandPiano(note_hz, velocity, duration_seconds)` renders a
recognizably grand-piano-like note entirely from math at call time. The runtime
module has no dependencies, files, encoded audio, network access, sample
decoder, or playback code.

The focused behavior suite scores **100/100**, and the older wide-grid suite
scores **90/100 PASS**. A newer, deliberately harsher 480-recording fidelity
suite scores **86.77/100**, up from its frozen **56.13/100** baseline. It clears
the fixed 85-point aggregate target but still reports `FAIL` because seven
category gates remain outside their stretch tolerances. These are regression
proxies, not a claim of perceptual equivalence to a sampled concert grand.

## API and return contract

```js
import synthesizeGrandPiano, {
  synthesizeGrandPiano as piano,
  SAMPLE_RATE,
} from './src/grand-piano.js';

const pcm = piano(440, 0.8, 2.5);
// pcm instanceof Float32Array === true
// pcm.length === Math.round(2.5 * SAMPLE_RATE)
// SAMPLE_RATE === 44100
```

The default and named exports are the same function. It returns a new mono
`Float32Array` containing normalized PCM at exactly 44,100 Hz. Samples are
finite and bounded to `[-0.94, +0.94]`. The fixed output transfer is not
per-note peak normalization, so velocity dynamics remain intact.

`duration_seconds` is the complete buffer duration, including the modeled
note-off/damper tail. Sample count is
`Math.round(clampedDuration * SAMPLE_RATE)`.

Input handling is deliberate:

- All three arguments must be finite JavaScript numbers; other values throw
  `TypeError`.
- `note_hz` is clamped to A0–C8 (`27.5`–`4186.009...` Hz).
- `velocity` is clamped to `0..1`; exactly zero produces correctly sized
  digital silence.
- `duration_seconds` is clamped to `0..30` seconds. The upper limit prevents an
  accidental unbounded allocation.

The package is ESM and works in Node 18+ and modern browsers. For browser
playback, place the returned channel into an `AudioBuffer`; the synthesizer
itself intentionally does not own playback:

```js
const context = new AudioContext();
const pcm = synthesizeGrandPiano(261.625565, 0.7, 2);
const buffer = context.createBuffer(1, pcm.length, SAMPLE_RATE);
buffer.copyToChannel(pcm, 0);
const source = context.createBufferSource();
source.buffer = buffer;
source.connect(context.destination);
source.start();
```

## Acoustic/DSP model

The implementation is a compact causal struck-string/soundboard model rather
than an oscillator bank under one shared envelope:

- Up to 192 stiff-string modes use
  `f_n = n f_1 sqrt((1 + B n²) / (1 + B))`, preserving the requested
  fundamental while stretching upper partials. `B` follows a smooth
  register-dependent curve.
- A finite nonlinear felt-force pulse drives damped second-order string
  resonators from rest. Contact duration, force shape, strike position, and
  spectral hardness vary continuously with register and velocity.
- One, two, or three strings are used by register. Unequal string coupling and
  several-cent treble offsets form resolvable unison lines; weak orthogonal
  polarizations add irregular energy returns rather than a periodic tremolo.
- Each mode has independent fast vertical, slow horizontal, polarization, and
  damper poles. Bridge transmission rises causally, upper modes shed energy
  faster, and short treble strings transfer most vertical energy very early.
- Ten broad radiation filters plus 22 short, mathematically generated plate
  modes model soundboard/bridge/case response. Two quiet deterministic
  microstructure bands add a decaying low-mid wooden body and delayed plate
  diffusion between the string lines. Their register-dependent coupling
  supplies the action thud, body bloom, and residual plate presence without an
  impulse response or recorded data.
- Separate deterministic felt, mechanical, presence, air, and diffuse-board
  bands model non-periodic energy. They have independent rise/decay constants;
  the hammer bands stay local to the collision while the board microstructure
  decays through the sustain.
- A short filtered damper/key-release event begins near the end of the requested
  duration. The undamped top register uses a longer release coefficient.
- A low-cut DC blocker, squared 32-sample raised-cosine onset ramp, 256-sample
  final fade, and fixed soft saturation keep boundaries quiet and output
  bounded.
- Hammer and damper noise use a note/velocity-derived PRNG seed. Repeated calls
  are sample-exact, and changing only duration preserves the pre-release prefix.

## Reference calibration

The supplied `SalamanderGrandPianoV3_44.1khz16bit` folder was used only as a
development reference. Its SFZ maps 30 sampled pitches at minor-third spacing,
16 velocity layers, chromatic key releases, three sympathetic-release
strengths, and pedal action. Initial calibration measured twenty sustain
recordings spanning A0, A2, C4, A4, and A6 at four velocities plus six
release/resonance recordings. The final wide-grid analysis measures **all 480
sustain recordings** (30 pitches × 16 velocity layers) against independently
rendered procedural notes.

The source is Alexander Holm's **Salamander Grand Piano V3**, a Yamaha C5
recorded with two AKG C414 microphones in an AB arrangement. The source is
[cataloged here](https://sfzinstruments.github.io/pianos/salamander/) as
CC BY 3.0. The attached SFZ itself identifies Holm and `CC-by`; its hash and the
full usage/preprocessing record are in
[`reports/reference-analysis.json`](reports/reference-analysis.json).

Reference PCM is decoded at its native 44.1 kHz/16-bit rate without resampling.
Waveform statistics use an arithmetic stereo mid; spectra are measured per
channel and power-averaged so AB phase cancellation does not erase treble
energy. Only scalar measurements are retained in reports. No recording or
sample-derived waveform is present in the implementation or procedural demos.

Key calibration observations were a median 22.7 ms attack-to-peak time,
velocity-dependent centroid increases in every measured register, rising
inharmonicity into the treble, and approximate fundamental T60 values of 16.2 s
at A2, 12.4 s at C4, 7.5 s at A4, and 4.1 s at A6. Bass T60 estimates are less
reliable because the reference fundamental is weak and the recordings reach a
noise floor.

The second physics pass focused on `A6v16.wav`, whose SFZ region is velocity
121–127 (midpoint `0.976378`) and is retuned by −12 cents. Its causal
onset-to-peak time is 21.202 ms. On the current model the corresponding render
is 22.15 ms. The measured reference unison spans 5.690 Hz; the model spans
5.524 Hz with lines at 1757.34, 1759.06, and 1762.86 Hz. Across thirty
onset-aligned body/string/presence/air measurements, the mean absolute error is
about 1.56 dB; the five-frame normalized RMS-shape error is under 0.7 dB. These are
calibration proxies, not waveform matching.

The wide-grid pass independently onset-aligns every pair, power-averages the
two reference microphone channels, applies the retuned SFZ metadata, and
compares pitch, attack time, five-frame onset shape, broadband centroid, up to
twelve normalized partials, and a seven-window decay trajectory. It also
scores every 16-point within-note velocity curve and every 30-note scale at all
16 layers. Current aggregate errors are: pitch-gap median **4.33 cents**
(reference tuning residuals dominate its p90), attack-time median **10.22 ms**,
onset-shape median **2.63 dB**, partial-profile median **3.53 dB**, and decay
trajectory median **2.46 dB**. It scores **90/100 PASS**; its deliberately
retained broadband-centroid diagnostic misses its p90 stretch target even
though the resolved-partial and strict time-frequency measures improve. The
complete matrix and per-layer/per-register results are in
[`reports/reference-grid-convergence.json`](reports/reference-grid-convergence.json).

The strict suite supersedes that permissive grid as the main fidelity target.
It renders every one of the 480 SFZ pitch/velocity cells for 2.55 seconds and
permits only one global level offset—never a per-note or per-layer match. It
compares sixty attack-envelope samples, three attack-energy quantiles, five
transient and seven sustain spectra in fourteen auditory bands, up to sixteen
resolved partials and their inharmonic locations, partial/multiband/broadband
decay, harmonic-to-residual energy, unison modulation, and every note's
velocity surface. Reference features are cached as measurements only; the
cache contains no PCM.

| Strict metric, median / p90 | Frozen baseline | Current |
|---|---:|---:|
| Global level residual | 1.94 / 5.11 dB | **1.30 / 3.50 dB** |
| Transient spectrum | 8.00 / 14.02 dB | **6.34 / 9.23 dB** |
| Sustain spectrum | 14.40 / 24.91 dB | **7.26 / 11.38 dB** |
| Partial balance | 6.31 / 14.99 dB | **4.86 / 7.17 dB** |
| Partial decay | 6.03 / 12.99 dB | **5.55 / 8.47 dB** |
| Multiband decay | 13.73 / 31.43 dB | **5.93 / 8.68 dB** |
| Harmonic/residual balance | 1.36 / 14.15 dB | **0.32 / 5.31 dB** |
| Stiff-partial location | 3.22 / 6.80 cents | **0.54 / 3.70 cents** |

The complete score, tolerances, signed residual maps, register/layer buckets,
worst pairs, and remaining failed gates are in
[`reports/strict-fidelity-report.json`](reports/strict-fidelity-report.json).
Its spectrum and decay errors are perceptual proxies: they expose static buzz,
missing body, and implausible loss rates, but do not measure stereo image,
microphone phase, or listener preference.

## Evaluation

Run everything with:

```sh
npm run validate
```

This runs fourteen API/runtime/score tests, the focused 100-point synthesis
analysis, reference re-analysis, both 480-pair comparison suites, and complete
public-domain-track validation. The strict suite is report-only within this
umbrella command: its remaining stretch-gate failures are printed and retained
in JSON without hiding successful runtime validation. Run
`npm run analyze:fidelity` when those quality gates should produce a nonzero
exit status. Reference tools print `SKIP` if the external reference folder has
intentionally been removed. Individual commands are:

```sh
npm test                  # API, edge, pitch, dynamics, no-sample checks
npm run analyze           # writes reports/validation-report.json
npm run analyze:references # writes reports/reference-analysis.json
npm run analyze:grid      # all 30 pitches × all 16 SFZ velocity layers
npm run analyze:fidelity  # strict 480-pair suite; exits nonzero on any failed gate
npm run analyze:fidelity:quick # 120-pair tuning subset, report-only
npm run demos             # deterministically regenerates demos/*.wav
npm run track             # renders the complete BWV 846 Prelude
npm run validate:track    # validates the generated full-track WAV
```

The focused behavior score requires at least 90/100 and currently earns:

| Category | Result | What it guards |
|---|---:|---|
| Signal contract | 20/20 | counts/rate, finite and bounded PCM, RMS/DC, boundaries |
| Pitch | 12/12 | local fundamental peak across A0–C8, ≤3 cents |
| Attack and dynamics | 13/13 | timing, monotonic energy, velocity brightness |
| Spectrum | 15/15 | partials, stiffness, middle-C body response, register contrast |
| Decay | 12/12 | natural loss, bass contrast, register-dependent partial ordering |
| Hammer and resonance | 20/20 | A6 attack shape, transient bands, unison lines, two-stage/beat behavior |
| Edges/repeatability | 8/8 | determinism, prefix consistency, silence, clamps, durations |

These metrics are proxies. Spectral centroid approximates brightness; fitted
inharmonicity compresses coupled strings to one value; RMS-window decay is more
robust to beating but is not a reverberation measurement; and boundary deltas
predict clicks without replacing listening tests. Exact measurements and every
tolerance are in
[`reports/validation-report.json`](reports/validation-report.json).

The separate full-grid score also requires exact 480-cell coverage, procedural
pitch accuracy at every cell, reference-relative pitch and attack agreement,
onset/spectral/decay convergence, all 30 within-note velocity curves, separate
bass/middle/treble bounds, and scale-order convergence at **each of the 16
velocity layers**. Its pitch-gap allowance is explicitly tied to the measured
residual tuning of the retuned references: weak bass fundamentals and the C8
files cannot serve as sub-cent pitch ground truth. Likewise, exact sampled-key
attack-peak order is reported but not treated as perceptual ground truth; the
gain-invariant five-frame onset shape is the stricter transient gate.

## Demonstrations and limitations

`npm run demos` creates low/middle/high single notes, a chord, a short phrase,
and an `A6v16-procedural.wav` render at the reference region's midpoint
velocity as mono PCM16 WAV files. `npm run track` additionally renders Bach's
complete 35-measure **Prelude in C major, BWV 846** as a 2:37 stereo WAV. Its
549 note events come from a public-domain Mutopia/Wikisource score, while all
performance timing, dynamics, piano audio, stereo placement, and algorithmic
room ambience are generated locally and deterministically. No recorded piano
or sampled impulse response is used. Exact provenance, output measurements,
and SHA-256 are recorded in
[`reports/public-domain-track.json`](reports/public-domain-track.json); the
checked-in audio files are described in [`demos/README.md`](demos/README.md).

This small model does not reproduce a specific concert grand. Its public note
API is mono and has no pedal/state API, half-pedaling, una-corda model,
duplex-scale state, true inter-note sympathetic coupling, room/microphone
simulation, or mechanical repetition behavior. The separate full-track
renderer supplies score-level overlap, keyboard-width panning, and synthetic
delay-line ambience, but summed notes still do not exchange energy. Extreme
bass and treble remain the hardest registers, and the modal spectrum is
smoother than a real instrument's irregular coupled modes.

See [`reports/PROGRESS.md`](reports/PROGRESS.md) for the measured iteration log.
