# Continuous calibration curves

The synth's remaining sampled-point parameter evaluators have been replaced
with continuous equations in the shared offline/realtime Wasm model. This
change preserves the established voicing; it does not recalibrate the piano
against a different instrument.

## Equations and calibration

`highres_radiation_db` previously constructed 14 frequency-band values for a
note, selected an interval, and evaluated a cubic Hermite segment. It now
evaluates one degree-64 Chebyshev polynomial in log frequency using Clenshaw's
recurrence. Its coefficients are continuous functions of pitch and velocity.
The existing low-rank spatial surface is retained. The runtime contains 65
spectral **basis coefficients** per component, with no sampled band values or
frequency knots.

The development exporter reconstructs the previous quantized response from
`high-resolution-radiation-fit.npz`, fits each component against 4,096
cosine-spaced observations by least squares, and quantizes the resulting
coefficients. Degree 64 preserves the detailed radiation response within the
0.25 dB maximum / 0.025 dB RMS regression limits. A smooth limit of width
0.0005 octaves retains the old nearly constant response beyond the calibration
range without hard derivative changes or polynomial extrapolation. The legacy
interpolator exists only in development and regression code.

`piano_string_mass` replaces log-linear interpolation between eight octave
anchors. With `S(x) = log(1 + exp(x))` and octave coordinate `o`, its fitted
log mass is `a + b o + c S(k0(o-o0))/k0 + d S(k1(o-o1))/k1`. The eight
coefficients in `piano-mechanics.h` minimize squared log-mass error against
4,097 equally spaced observations of the former C1–C8 curve; transition
steepness was bounded to 1–16 per octave. Smooth limiting of `o` to 0–7 has
width 0.01 octaves. Taking the exponential guarantees positive mass; the
regression verifies that it decreases monotonically across A0–C8.

`piano_felt_exponent` uses two smooth limited ramps through the C2/C4/C7
hardness measurements. Rounding occurs over half a semitone. The physical
collision equations use the fitted mass and exponent directly.

The other calibration paths already use polynomial, exponential, trigonometric,
or continuous blending equations. Affine blends such as `lerp(a,b,t)` remain
valid continuous functions. Integer string/mode counts, discrete key events,
filter state, generated hammer-force buffers, and digital PCM are still part
of the physical simulation; they are not interpolated calibration curves.
The optional convolution reverb is a separate effect.

## Fit and behavior checks

| Check | Result |
|---|---:|
| Radiation error, RMS / maximum | 0.0141 / 0.1850 dB |
| Radiation grid | 175 pitches × 65 velocities × 4,286 frequencies |
| Frequency coverage | 20–45,600 Hz, covering supported 32–96 kHz sample rates |
| String-mass relative error, RMS / maximum | 1.1895% / 4.8853% |
| Felt-exponent maximum absolute change | 0.004814 |
| Soft-contact duration-ratio maximum relative change | 0.0663% |
| Collision-duration ratio error vs independent RK4 integration | 1.15e-14 |
| RMS level change across 88 keys × 3 velocities, maximum | 0.0132 dB |
| Aggregate waveform difference relative to baseline energy | −60.59 dB |
| Focused synthesis behavior score | 100/100 PASS |
| Full 480-recording strict score, before → after | 95.00 → 95.00 |
| Quick 120-recording strict score, before → after | 95.08 → 95.08 |

The radiation grid checks the applied correction **after subtracting the
fundamental response**, including coefficient quantization and endpoint
smoothing. It includes half-semitone pitches, zero velocity as a mathematical
endpoint, the old knots, and all pitch-grid fundamentals. These are measured
grid bounds, not a proof over every real-valued input.

Both strict comparisons retain the same seven pre-existing failed quality
gates (transient spectrum, sustain spectrum, partial balance, three decay
measures, and register/velocity surfaces). They remain `FAIL`; the unchanged
scores do not imply perceptual equivalence to recordings. The older general
reference reports in this repository predate this regression measurement.

All 95 tests pass, including actual C evaluator comparisons to a frozen legacy
fixture, monotonic mass, finite contact behavior, radiation derivatives at old
knots/endpoints, independent collision integration, deterministic waveform
oracles, sample-rate and pedal behavior, and runtime size/allocation checks.
The waveform hashes were refreshed after the measured acoustic checks because
the fitted equations intentionally change PCM values.

The embedded Wasm is 60,142 bytes (previously 58,889); its fixed memory remains
32 MiB. On this development machine, alternating seven measured passes after
warmup gave mean onset costs across 88 keys of 0.0776 → 0.0883 ms, using the
median pass. Sixteen-voice 128-frame rendering measured 0.4360 → 0.4225 ms per
block. Timing varies with the host; fitting adds work when a note starts and
does not add curve evaluation to the sustained sample loop.

## Reproduction

With Emscripten/Binaryen on `PATH` and development Python NumPy/SciPy installed:

```sh
python tools/export-high-resolution-radiation.py --check
npm run curves:check
npm run wasm:check
npm test
node tools/score-synth.mjs
node tools/compare-reference-fidelity.mjs --no-fail
```

Regenerate coefficients with `python tools/export-high-resolution-radiation.py`
and then `npm run wasm:build`. `python tools/check-continuous-curves.py
--write-report` refreshes the machine-readable radiation audit. These Python
dependencies and the calibration NPZ are development-only; the distributed
runtime remains dependency-free. C tests use `cc` on Unix and the existing
`emcc` toolchain on Windows; `CC` can explicitly select a native compiler.
