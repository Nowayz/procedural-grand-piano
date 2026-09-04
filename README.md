# Procedural grand piano

`synthesizeGrandPiano(note_hz, velocity, duration_seconds)` renders a
recognizably grand-piano-like note entirely from math at call time. The runtime
module has no dependencies, files, encoded audio, network access, sample
decoder, or playback code.

The focused behavior suite scores **97/100 PASS**. The direct 480-recording
suites score **90/100 PASS** (wide) and **88.15/100** (strict). The strict command
still reports `FAIL` because several category gates remain outside its stretch
tolerances. These are regression proxies, not a claim of perceptual equivalence
to a sampled concert grand.

## API and return contract

```js
import synthesizeGrandPiano, {
  renderGrandPianoNote,
  synthesizeGrandPiano as piano,
  synthesizeGrandPianoInto,
  SAMPLE_RATE,
} from './src/grand-piano.js';

const pcm = piano(440, 0.8, 2.5);
// pcm instanceof Float32Array === true
// pcm.length === Math.round(2.5 * SAMPLE_RATE)
// SAMPLE_RATE === 44100

const reusable = new Float32Array(SAMPLE_RATE);
synthesizeGrandPianoInto(reusable, 440, 0.8, 1);

// Here 0.013 is key-down time, not output duration. The returned buffer keeps
// the modeled action travel, damper interaction, and acoustic tail.
const staccato = renderGrandPianoNote(261.625565, 0.8, 0.013);
```

The default and named exports are the same function. It returns a new mono
`Float32Array` containing normalized PCM at exactly 44,100 Hz. Samples are
finite and bounded to `[-0.94, +0.94]`. The fixed output transfer is not
per-note peak normalization, so velocity dynamics remain intact.

`duration_seconds` is the exact output-buffer duration, not a literal key-down
time. For damped notes the offline renderer uses the standard release speed
(`64 / 127`) and starts key return early enough for the modeled mechanical
travel and damping tail when they fit. It never lengthens the requested buffer:
a buffer shorter than the physical release span is boundary-faded and therefore
truncates that span. The damperless top 18 keys (MIDI 91–108, G6–C8) simply
decay naturally. Sample count is
`Math.round(clampedDuration * SAMPLE_RATE)`.

Use `renderGrandPianoNote(note_hz, velocity, key_down_seconds, options)` when
musical duration should mean physical key-down time. It drives the persistent
voice engine, issues key-up at that exact sample, and returns only after the
modeled voice has remained 80 dB below its own peak for 20 ms. Options are
`releaseVelocity`, `sampleRate`, and the safety cap `maximumTailSeconds`
(default 30). Key-down and maximum-tail inputs are each bounded to 30 seconds;
zero strike velocity returns an empty buffer. If the cap is reached, the
remaining 50 ms are boundary-faded.

Input handling is deliberate:

- All three arguments must be finite JavaScript numbers; other values throw
  `TypeError`.
- `note_hz` is clamped to A0–C8 (`27.5`–`4186.009...` Hz).
- `velocity` is clamped to `0..1` and follows the MIDI-CI Piano Profile's
  default Note On velocity curve. The renderer maps it logarithmically onto
  normalized hammer impact speed using the recommended 3% slowest-sounding
  speed; exactly zero produces correctly sized digital silence.
- `duration_seconds` is clamped to `0..30` seconds. The upper limit prevents an
  accidental unbounded allocation.

The package is ESM and works in Node 18+ and modern browsers with WebAssembly
SIMD. For browser playback, place the returned channel into an `AudioBuffer`; the synthesizer
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

For a GarageBand-style **Small Hall** master reverb, use the optional Web Audio
helper. It loads and decodes the bundled stereo IR once during setup; the
instrument's render path remains sample-free and allocation-free when a caller
supplies its output buffer.

```js
import { createGarageBandStyleReverb } from './src/reverb.js';

const context = new AudioContext();
const reverb = await createGarageBandStyleReverb(context);
source.connect(reverb.input);
reverb.connect(context.destination);
```

The default wet send is 18%; call `reverb.setWet(0..1)` to change it. The
1.359-second stereo response is derived from the MIT-licensed [Conner IR
Library](https://github.com/itsmusician/IR-Library). GarageBand's acoustic
piano reverb varies by patch, so this targets its documented **Small Hall**
master preset rather than claiming to copy an Apple impulse response.

## Realtime keyboard API

The realtime API keeps each note alive while it remains acoustically audible and uses an `AudioWorklet` as the audio clock. A matching key-up controls the damper, but a voice whose radiated output and bridge energy have both fallen below the hearing threshold retires even if its key or the sustain pedal remains down. Wasm owns the fixed voice pool, note state, sustain state, and mono mix; JavaScript only forwards controls and copies the finished block into the browser-provided output channel. No objects, arrays, or views are created inside the worklet's `process()` callback.

```js
import { createRealtimeGrandPiano, REALTIME_SCHEDULING_LEAD_SECONDS } from 'procedural-grand-piano/realtime';
import { createGarageBandStyleReverb } from 'procedural-grand-piano/reverb';

const context = new AudioContext();
const piano = await createRealtimeGrandPiano(context, { polyphony: 32 });
const reverb = await createGarageBandStyleReverb(context);
piano.connect(reverb.input);
reverb.connect(context.destination);

const id = 60;
piano.noteOn(id, 261.625565, 0.75);
piano.noteOff(id, 0.4, context.currentTime + 1);
piano.sustain(true);
piano.sustain(false, context.currentTime + 2);
```

`id` identifies one physical key press. Different IDs may describe successive strikes, but all strikes whose frequencies map to the same one of the piano's 88 keys reuse that key's single string voice. A restrike transfers ownership to its newest ID, injects a fresh hammer excitation into the existing modal state, and makes a later stale note-off for the prior ID harmless. `noteOn`, `noteOff`, and `sustain` accept absolute `AudioContext` times. An omitted time means “the next available render quantum,” which minimizes interactive latency but depends on main-thread and `MessagePort` scheduling. Sequencers should submit events at least `REALTIME_SCHEDULING_LEAD_SECONDS` (20 ms) ahead for stable sample placement. DOM events and `EventTarget` may be used by the interface, but they are deliberately absent from the DSP callback.

`release_velocity` is a normalized key-return speed, clamped to `0..1`: `0`
gives the slowest return, `1` the fastest, and omission uses `64 / 127`. It
controls action travel, felt settling, modal attenuation, and release noise,
independently of strike velocity. Key release does not mute a voice immediately:
damper contact is scheduled 45–85 ms after key-up and cannot precede 50 ms after
the strike. Consequently, even a 13 ms key gate produces a finite piano tone
rather than a 13 ms sample cut.

`sustain()` accepts either a Boolean or normalized pedal lift from `0` (felt
fully down) to `1` (felt clear). Intermediate values drive the narrow
part-pedal interaction regime. The model begins with free key-return travel,
applies nonlinear partial felt contact, then leaves a quieter free residual
when string motion falls below the remaining felt gap. Re-pedaling during key
return or damping catches the string at its current energy: future attenuation
stops, but energy already absorbed by the felt is not restored.

All voices mix inside one Wasm engine and one mono `AudioWorkletNode`; do not create an audio node per note. Connect that node to the optional `ConvolverNode` reverb as shown above. The fixed pool defaults to 32 voices and supports up to 256 slots, although the one-resonator-per-key rule limits a piano performance to 88 active physical voices. When a smaller configured pool fills, it deterministically steals the quietest released voice, then the quietest key-up/pedal-held voice, then the quietest held voice. `reset()` immediately clears voices and pending controls, while `destroy()` resets, disconnects, and closes the control port.

Realtime coefficients and timing follow the actual `AudioContext.sampleRate`; rates from 32 to 96 kHz are supported. Sustained 32-voice rendering at 48 kHz measured 1.37 ms median and 1.62 ms p95 per 2.67 ms quantum on the development machine. Starting many voices is more expensive because each strike constructs its modal state: an artificial simultaneous 32-note onset took 5.75 ms, while ordinary one-to-ten-finger keyboard attacks stay within a quantum on that machine.

Standard MIDI files can be rendered through the same persistent voice engine with `npm run track:midi -- score.mid output.wav`. The importer supports format 0/1 files, tempo changes, running status, overlapping notes, and continuous CC64 pedal values; equal-tick controls retain file order. A zero MIDI Note Off velocity is treated as unspecified and mapped to `64 / 127`. `renderMidiPerformance()` treats `tailSeconds` (default 3) as a minimum, renders until all physical voices retire, and caps the search with `maximumTailSeconds` (default 30). It returns `truncatedVoices`; a nonzero value means the cap forced a 50 ms output fade. Missing final note-offs and a pedal left down are released at the performance end. The command-line output receives the bundled Small Hall convolution reverb.

## Compact runtime

The distributable runtime remains dependency-free with no required build step. Its embedded WebAssembly module owns the complete offline and realtime simulation: hammer/string modes, soundboard and radiation filters, deterministic microstructure, staged damper contact, envelopes, voice state, event scheduling, mixing, limiting, fades, and output. JavaScript only validates the API contract, manages caller-owned buffers, invokes Wasm, and copies finished samples.

Each independent engine has one fixed 32 MiB Wasm memory containing the 256-voice pool, 256-event queue, mix block, every scratch value, and the maximum 30-second offline output arena. Memory growth is disabled and the simulation calls no allocator, so rendering into caller-provided buffers performs no allocation.

The canonical full-model source is [`tools/grand-piano-wasm.c`](tools/grand-piano-wasm.c). Run `npm run wasm:build` to compile and embed it with Emscripten and Binaryen, or `npm run wasm:check` to verify that the embedded bytes match the project source. The test suite enforces budgets of 101,000 raw bytes and 45,000 gzip bytes; that includes the complete model, realtime engine, fixed data, and required standalone math routines.

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
- The force pulse is normalized to unit area and its excitation magnitude is
  linear in normalized hammer impact speed. MIDI velocity is first converted
  to hammer speed by `s = 0.03 * (1 / 0.03) ** velocity` for nonzero input, as
  specified by the MIDI-CI Piano Profile receiver curve. Thus doubling hammer
  speed gives an unclipped first-order peak-amplitude change of approximately
  6.02 dB; register voicing does not redefine that dynamic law.
- One, two, or three strings are used by register. Unequal string coupling,
  several-cent treble offsets, and a small deterministic per-strike zero-mean
  phase spread form resolvable unison lines; weak orthogonal
  polarizations add irregular energy returns rather than a periodic tremolo.
- Each mode has independent fast vertical, slow horizontal, polarization, and
  damper poles. Bridge transmission rises causally, upper modes shed energy
  faster, and short treble strings transfer most vertical energy very early.
  Modal loss follows the reduced stiff-string law
  `T60(f) ~ T60base / (1 + (f / 9500)²)` plus smooth register-dependent loss;
  poles are `exp(-ln(1000)/(T60·44100))`.
- Ten broad radiation filters sampled from a continuous mean-mobility profile
  plus 22 short plate modes generated from a warped modal-density, loss, and
  bridge-participation model describe the soundboard/bridge/case response. Two quiet deterministic
  microstructure bands add a decaying low-mid wooden body and delayed plate
  diffusion between the string lines. Their register-dependent coupling
  supplies the action thud, body bloom, and residual plate presence without an
  impulse response or recorded data.
- A sixth-order function of log-frequency supplies the mean bridge-mobility
  envelope across the homogeneous-plate to inter-rib transition. It has no
  per-key or per-velocity interpolation and never replays a spectral frame.
- Separate deterministic felt, mechanical, presence, air, and diffuse-board
  bands model non-periodic energy. They have independent rise/decay constants;
  the hammer bands stay local to the collision while the board microstructure
  decays through the sustain.
- Same-key restrikes add a new coherent hammer excitation while the prior
  string vibration continues to decay instead of being reset.
- Key-up starts an action-return stage rather than multiplying the shared output
  by a release envelope. Release speed sets 45–85 ms of travel and 4–30 ms of
  felt-contact settling; contact never begins before 50 ms from the strike.
- Damper loss is applied independently to every string mode. The first 100 ms
  interpolates between regulated and free-return slopes; base attenuation rises
  from 170 to 220 dB/s across the damped register, increases with partial number,
  and includes a bass damper-position/node factor. Orthogonal polarization is
  damped at 45% of the vertical rate, leaving a quieter residual phase. Long
  coupled body modes are attenuated in their internal state at 100–180 dB/s,
  while already-radiating broad soundboard modes decay naturally. Damper noise
  starts at felt contact and follows release speed.
- Normalized pedal lift maps through a smooth, narrow felt-contact interval.
  Partial lift weakens modal damping and ends contact when the decaying string
  displacement falls below the modeled felt gap, preserving the measured
  quieter final free-vibration stage instead of treating CC64 as a mute switch.
- Keys G6–C8 have no dampers and ignore key release acoustically. Every realtime
  voice, including a key-held or pedal-held one, retires only after both its
  radiated output and bridge energy remain below the calibrated 0 dB SPL
  hearing threshold for 120 ms; there is no fixed note-off cutoff or forced
  release fade.
- Extreme-treble participation in the very slow low-frequency body branch tapers
  toward C8, so a synthetic 58 Hz body rumble no longer determines an
  eighteen-second top-key lifespan.
- A low-cut DC blocker, register-dependent raised-cosine onset ramp, 256-sample
  final fade, and fixed soft saturation keep boundaries quiet and output
  bounded.
- Hammer, damper, and body noise use independent note/velocity-derived PRNG
  states. Repeated event streams are sample-exact; changing only offline
  duration preserves the common prefix until the shorter render begins its
  scheduled release.

## Reference calibration

The supplied `SalamanderGrandPianoV3_44.1khz16bit` folder was used only as a
development reference. Its SFZ maps 30 sampled pitches at minor-third spacing,
16 velocity layers, chromatic key releases, three sympathetic-release
strengths, and pedal action. Initial calibration measured twenty sustain
recordings spanning A0, A2, C4, A4, and A6 at four velocities plus six
release/resonance recordings. The final wide-grid analysis measures **all 480
sustain recordings** (30 pitches × 16 velocity layers) against independently
rendered procedural notes.

Those SFZ layer numbers are sample-switching regions, not measured hammer
speeds and not a MIDI-CI Piano Profile calibration. Their within-note level
curve remains a useful recording comparison, but it is not physical evidence
for redefining the hammer-speed-to-amplitude law.

That path is now a submodule pointing to the canonical Salamander Grand Piano
repository. Upstream currently ships a newer 48 kHz/24-bit FLAC edition; the
original measurements were produced from the older 44.1 kHz/16-bit WAV
edition, and the validation tools now discover and decode either layout. The
two sample editions are not byte-identical, so rebuilding reports from the
submodule also refreshes their source signature and scalar feature cache.

The source is Alexander Holm's **Salamander Grand Piano V3**, a Yamaha C5
recorded with two AKG C414 microphones in an AB arrangement. The source is
[cataloged here](https://sfzinstruments.github.io/pianos/salamander/) as
CC BY 3.0. The attached SFZ itself identifies Holm and `CC-by`; its hash and the
full usage/preprocessing record are in
[`reports/reference-analysis.json`](reports/reference-analysis.json).

Reference PCM is decoded at its native format and bit depth. Comparisons
convert the upstream 48 kHz FLAC edition onto the synthesizer's 44.1 kHz
timebase while preserving both physical pitch and duration. No SFZ tuning,
key-zone transposition, or other frequency shift is applied. Waveform statistics use an
arithmetic stereo mid; spectra are measured per channel and power-averaged so
AB phase cancellation does not erase treble
energy. Only scalar measurements are retained in reports. No recording or
sample-derived waveform is present in the implementation or procedural demos.

Key calibration observations were a median 22.7 ms attack-to-peak time,
velocity-dependent centroid increases in every measured register, rising
inharmonicity into the treble, and approximate fundamental T60 values of 16.2 s
at A2, 12.4 s at C4, 7.5 s at A4, and 4.1 s at A6. Bass T60 estimates are less
reliable because the reference fundamental is weak and the recordings reach a
noise floor.

The wide-grid pass independently onset-aligns every pair, power-averages the
two reference microphone channels, and
compares pitch, attack time, five-frame onset shape, broadband centroid, up to
twelve normalized partials, and a seven-window decay trajectory. It also
scores every 16-point within-note velocity curve and every 30-note scale at all
16 layers. Current aggregate errors are: pitch-gap median **9.01 cents**
(natural recording offsets dominate its p90), attack-time median **10.48 ms**,
onset-shape median **2.74 dB**, partial-profile median **4.08 dB**, and decay
trajectory median **2.45 dB**. It scores **90/100 PASS**; its deliberately
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

| Strict metric, median / p90 | Current |
|---|---:|
| Global level residual | **1.63 / 4.48 dB** |
| Attack envelope | **1.36 / 3.24 dB** |
| Transient spectrum | **6.45 / 8.96 dB** |
| Sustain spectrum | **7.37 / 10.34 dB** |
| Partial balance | **5.15 / 8.62 dB** |
| Partial decay | **5.51 / 9.21 dB** |
| Multiband decay | **5.87 / 8.66 dB** |
| Harmonic/residual balance | **0.29 / 4.92 dB** |
| Stiff-partial location | **2.40 / 4.24 cents** |

The complete score, tolerances, signed residual maps, register/layer buckets,
worst pairs, and remaining failed gates are in
[`reports/strict-fidelity-report.json`](reports/strict-fidelity-report.json).
Its spectrum and decay errors are perceptual proxies: they expose static buzz,
missing body, and implausible loss rates, but do not measure stereo image,
microphone phase, or listener preference.

Reference validation is intentionally limited to the 30 keys that were
physically recorded. The tools never manufacture missing-key references from a
neighboring string. Scalar reference-feature caches contain no PCM.

## Evaluation

Run everything with:

```sh
npm run validate
```

This runs the API/runtime/tooling tests, the focused 100-point synthesis
analysis, reference re-analysis, the 480-cell recorded-root suites, and
complete public-domain-track validation. Strict
suites are report-only within this umbrella command: their remaining stretch
failures are printed and retained in JSON without hiding successful runtime
validation. Run a strict command without its `:report` suffix when failures
should produce a nonzero exit status. Reference tools print `SKIP` if the
external reference folder has intentionally been removed. Individual commands
are:

```sh
npm test                  # API, edge, pitch, dynamics, no-sample checks
npm run analyze           # writes reports/validation-report.json
npm run analyze:references # writes reports/reference-analysis.json
npm run analyze:grid      # all 30 pitches × all 16 SFZ velocity layers
npm run analyze:fidelity  # strict 480-pair suite; exits nonzero on any failed gate
npm run analyze:fidelity:quick # 120-pair recorded subset, report-only
npm run demos             # deterministically regenerates demos/*.wav
npm run track             # renders the complete BWV 846 Prelude
npm run validate:track    # validates the generated full-track WAV
```

All reference comparison modes use a deterministic Node worker pool,
defaulting to every available physical core on Linux, with CPU-affinity and
container quotas respected. Other platforms use Node's available-processor
count. Append `-- --jobs=1` to an npm command for the serial path, or choose any
positive worker count. Results retain original SFZ order regardless of
completion order. On the current 16-core/32-thread host, 16 workers reduced the
full strict pass from 7.90 to 4.89 seconds and the wide-grid pass from 4.89 to
3.06 seconds versus the former eight-worker default. Forcing all 32 SMT threads
was slower for both FFT-heavy workloads.

The focused behavior score requires at least 90/100 and currently earns:

| Category | Result | What it guards |
|---|---:|---|
| Signal contract | 20/20 | counts/rate, finite and bounded PCM, RMS/DC, boundaries |
| Pitch | 12/12 | local fundamental peak across A0–C8, ≤3 cents |
| Attack and dynamics | 10/13 | timing, monotonic energy, velocity brightness |
| Spectrum | 12/15 | partials, stiffness, middle-C body response, register contrast |
| Decay | 12/12 | natural loss, bass contrast, register-dependent partial ordering |
| Hammer and resonance | 16/20 | A6 attack shape, transient bands, unison lines, two-stage/beat behavior |
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
velocity layers**. Its pitch-gap allowance accounts for the raw recordings'
natural tuning and weak fundamentals; the bass and C8 files cannot serve as
sub-cent pitch ground truth. Likewise, exact sampled-key
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

This small reduced model does not reproduce a specific concert grand. The
offline single-note API is stateless and mono; the realtime engine adds key
identity and binary sustain, but not continuous key displacement, half-pedaling,
una-corda, duplex-scale state, true inter-note sympathetic coupling,
room/microphone simulation, or mechanical repetition. Release velocity is a
proxy for return kinematics, and the C1-derived damper footprint is blended
across the bass rather than using measured geometry for every key. The separate
full-track renderer supplies score-level overlap, keyboard-width panning, and
synthetic delay-line ambience, but summed notes still do not exchange energy.
Extreme bass and treble remain the hardest registers, and the modal spectrum is
smoother than a real instrument's irregular coupled modes.

See [`reports/PROGRESS.md`](reports/PROGRESS.md) for the measured iteration log.
