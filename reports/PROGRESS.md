# Development and calibration log

This log records changes driven by measurements. It distinguishes improvements
to the synthesizer from corrections to the measurement method.

## Reference baseline

The supplied Salamander SFZ was parsed before model tuning. It identifies
Alexander Holm and a CC-BY sample set; the upstream instrument catalog identifies
the instrument as a Yamaha C5 and the license as CC BY 3.0. The runtime never
opens this folder.

Twenty native 44.1 kHz/16-bit stereo sustain files were selected: A0, A2, C4,
A4, and A6 at SFZ layers 4, 8, 12, and 16. Six additional recordings cover
chromatic key release and soft/loud/third sympathetic releases. Analysis used a
3 ms RMS onset tracker, Hann-window FFTs, power-averaged stereo spectra, local
partial-peak searches, and dB/time regressions. No reference was resampled,
normalized, trimmed on disk, or redistributed.

| Reference note | Attack-to-peak range | Centroid, layer 4 → 16 | Median fitted B | Fundamental T60 proxy |
|---|---:|---:|---:|---:|
| A0 | 14.2–24.5 ms | 164 → 275 Hz | 2.59e-4 | 73.1 s (low confidence) |
| A2 | 23.6–27.1 ms | 216 → 355 Hz | 1.70e-4 | 16.2 s |
| C4 | 28.5–28.8 ms | 424 → 482 Hz | 3.16e-4 | 12.4 s |
| A4 | 14.0–15.1 ms | 482 → 534 Hz | 6.19e-4 | 7.5 s |
| A6 | 21.2–21.3 ms | 1768 → 1834 Hz | 5.15e-3 | 4.1 s |

The A0 fundamental lies over 40 dB below a stronger low partial in several
windows, so its fitted T60 and some low-note B fits are noise/peak-selection
sensitive. They were treated as directional targets, not exact constants.

## Iteration 1 — basic independent modes

The first runnable model already had stiff-string modal positions, register
dependent string counts, separate two-stage decay per partial/string, synthetic
body filters, deterministic hammer noise, and a release tail. It met numerical
safety and pitch goals, but spectral measurements showed overly dominant
fundamentals through the bass/middle and excessive treble overtones.

At velocity 1.0, early centroids were approximately 62 Hz at A0, 176 Hz at A2,
377 Hz at C4, and 1932 Hz at A6, versus reference hard-layer targets of 275,
355, 482, and 1834 Hz. The model sounded structurally tonal by proxy, but its
register balance was not yet piano-like enough.

Changes made:

- Added low-frequency soundboard radiation loss so bass upper partials radiate
  more efficiently than the fundamental.
- Added a smooth bridge/body emphasis around the second partial of middle
  notes, matching the strong C4/A4 second partial seen in the reference.
- Added rapidly increasing treble upper-mode damping.
- Tuned fundamental and partial T60 curves to the A2/C4/A4/A6 reference trend.

After this pass, hard-strike centroids moved to about 142 Hz (A0), 241 Hz (A2),
433 Hz (C4), and 1762 Hz (A6). This was closer in direction without copying a
reference spectrum.

## Iteration 2 — scored regression pass (88/100)

The first complete score exposed three failures:

| Failure | Measured | Required |
|---|---:|---:|
| Top-octave hard/soft RMS ratio | 23.781× | 2.2–10× |
| C8 hard/soft centroid ratio | 1.000× | >1.001× |
| Start-region maximum delta | 0.0743 | <0.035 |

The first two were model problems: a low-velocity C8 fundamental fell far above
the soft-hammer cutoff, and velocity-independent treble damping erased any hard
strike upper-mode difference. The model was changed to give small treble
hammers a register-dependent cutoff floor and to reduce upper-mode damping as
velocity rises. A quiet, deterministic lingering-felt excitation was also
extended beyond the immediate contact interval.

The third failure was an analysis mistake. The test scanned the first 96
samples, well past the explicit 32-sample fade, and labeled legitimate C8
waveform slope as a boundary discontinuity. Restricting the criterion to the
actual first 16 boundary samples produced a maximum delta of 0.0071 while exact
first/last zeros and the 256-sample end fade remained independently required.

## Iteration 3 — first complete measured state (100/100)

The revised model passes every criterion at the documented 90-point threshold:

- maximum fundamental error: **0.976 cents** across A0–C8;
- representative maximum peak: **0.6914**, below the fixed 0.94 bound;
- maximum absolute DC: **0.001078**;
- attack-to-peak range: **13.15–39.48 ms**;
- hard/soft RMS ratios: **3.46×–7.61×**;
- hard/soft centroid ratios: **1.002×–1.976×**, increasing in every register;
- fitted output B: A2 **4.52e-5**, C4 **2.82e-4**, A6 **4.66e-3**;
- broadband decay over the fixed windows: A0 **−5.19 dB**, C4 **−14.05 dB**,
  A6 **−20.74 dB**;
- C4 fundamental/fourth-partial changes: **−8.89 / −17.96 dB**;
- exact sample equality across repeated renders, including noise.

The complete machine-readable values, tolerances, weights, and proxy caveats
are in `validation-report.json`. A 100/100 result means the implementation
retains the intended acoustic behaviors under these tests; it is not a
subjective listening score and does not imply equivalence to the Yamaha C5
recordings.

## Iteration 4 — finite collision and coupled-resonance pass

Focused A/B listening to `A6v16.wav` exposed a blind spot in the first score:
the model could pass while its treble was a nearly stationary set of lines with
too little hammer/bridge presence. The reference was remeasured with a causal
RMS detector after a centered-window experiment was found to look ahead across
sample zero. Detailed targets now retain only scalar frame, band, line, and
decay measurements; no reference PCM enters tests or runtime.

The string bank was replaced by resonators driven from rest by a finite,
nonlinear felt-force history. Each string now has fast vertical, slow
horizontal, and weak orthogonal-polarization paths. Unequal unison coupling,
measured-scale detuning, causal bridge transmission, a short synthetic plate,
and separately filtered felt/mechanical/presence/air excitations create the
attack and subsequent energy exchange. Noise seeding no longer depends on
requested duration, so a longer render preserves the same onset prefix.

| Focused A6v16 metric | Previous model | Reference | Current model |
|---|---:|---:|---:|
| Causal onset-to-peak | 15.94 ms | 21.20 ms | 22.15 ms |
| Significant unison lines / span | 2 / 1.859 Hz | 4 / 5.690 Hz | 3 / 5.524 Hz |
| 30 transient-band values, mean absolute error | 8.82 dB | — | 1.56 dB |
| Five onset-frame centroids, mean absolute error | 6.01% | — | 1.87% |
| 100 ms RMS relative to 20 ms | −3.09 dB | −18.22 dB | −16.25 dB |
| 100→150 ms beat rebound | −2.47 dB | +5.72 dB | +3.16 dB |
| 3 s RMS relative to 20 ms | −46.04 dB | −55.94 dB | −55.17 dB |

The current three procedural lines are 1757.34, 1759.06, and 1762.86 Hz at
approximately −9.1, −0.5, and 0 dB. They align with the principal SFZ-retuned
reference cluster while leaving the recording's extra coupled side line
unmodeled. The early frame still has less absolute energy than the recording,
and the 0.25–2 s beating trajectory is only approximate; those remain useful
limits rather than claims of waveform identity.

The 100-point analysis was reweighted and now reserves 20 points for the
focused hammer/resonance behavior: attack shape, six time-varying bands,
centroids, unequal unison lines, two-stage loss, and a beat rebound. The prior
model fails the transient-spectrum, cluster, and rebound checks. The current
model earns 100/100 with all ten runtime/API tests passing.

## Iteration 5 — complete 480-cell pitch/velocity grid

The focused-note suite did not establish whether the same voicing generalized
through the SFZ. A new repeatable grid tool therefore parsed both supplied SFZ
files and compared every sustain region: **30 sampled pitches × 16 velocity
layers = 480 reference recordings and 480 fresh procedural renders**. It uses
only the first 1.65 seconds of each source in memory, with no resampling or
on-disk preprocessing. Reference stereo channels are FFT-analyzed separately
and power-averaged; timing and decay comparisons are independently
onset-aligned.

The first complete run scored **57/100** and found a genuine generalization
failure hidden by the A6 focus: bass/middle modal spectra rolled off too fast.
Velocity curves were already strong (median normalized-curve correlation
0.986), as were onset-frame and decay trajectories, but median/p90 normalized
partial-profile error was **8.95/20.68 dB** and median broadband-centroid error
was **528 cents**.

Two physical corrections were evaluated across the entire matrix:

- The low/middle hammer-to-string coupling now uses a broader modal-velocity
  spectrum, smoothly returning to the separately calibrated treble voicing.
- The lumped felt contact is cycle-limited from the tenor upward so it does not
  impose a second, unmeasured upper-mode cancellation on top of the explicit
  felt filter. Bass bridge radiation also supplies a smooth low-order overtone
  shelf while preserving an unambiguous procedural fundamental.

A post-saturation DC blocker fixed nonlinear mean offset exposed during that
tuning. The inharmonicity regression was also corrected to use a 120 ms window,
after the short synthetic plate modes have decayed; timbre metrics retain their
25 ms post-onset window.

Final complete-grid measurements are:

| Metric over 480 pairs | Initial | Final |
|---|---:|---:|
| Broadband centroid difference, median | 528.0 cents | **303.9 cents** |
| Broadband centroid difference, p90 | 1673.1 cents | **955.8 cents** |
| Partial-profile MAE, median | 8.95 dB | **6.56 dB** |
| Partial-profile MAE, p90 | 20.68 dB | **15.96 dB** |
| Onset-frame shape MAE, median | 2.62 dB | **2.73 dB** |
| Decay-trajectory MAE, median | 2.44 dB | **2.38 dB** |

The final grid score is **100/100**. All 16 velocity layers contain all 30
pitches. Across the 30 within-note curves, median dynamic correlation remains
above 0.98 and all reference/model brightness endpoints move in the same
direction. Across all sixteen 30-pitch scales, centroid-rank correlation stays
above the 0.90 gate and 400 ms decay-rank correlation stays above 0.70.

Two diagnostics deliberately retain wider limits. The reference fundamental
itself has a 25.81-cent p90 residual after SFZ retuning because several bass
fundamentals are weaker than overtones and C8 remains about 61 cents sharp; the
procedural renders have 3.54-cent p95 and 4.44-cent maximum local-peak error.
Reference onset peaks also vary irregularly between adjacent sampled keys, so
the 32.56 ms attack-difference p90 is paired with the much tighter 7.48 dB p90
five-frame onset-shape gate. These exceptions are visible in the JSON rather
than silently discarded.

## Iteration 6 — C4 listening correction

Listening to the regenerated `C4-medium.wav` revealed a defect that the global
grid score did not make salient: the note was recognizably pitched but audibly
muffled beside `C4v10.wav` and `C4v11.wav`. Direct band and partial analysis
confirmed the report. At the demo velocity (`0.62`), the old model was far
below the C4v10 reference through the presence and air bands:

| Band relative to 20 Hz–8 kHz | Reference C4v10 | Previous demo | Current model |
|---|---:|---:|---:|
| 0.8–1.6 kHz | −14.7 dB | −23.3 dB | **−14.7 dB** |
| 1.6–3.2 kHz | −21.2 dB | −45.8 dB | **−20.5 dB** |
| 3.2–8.0 kHz | −28.2 dB | −75.0 dB | **−35.8 dB** |

The cause was twofold. The finite contact pulse imposed a second upper-mode
low-pass on top of the explicit felt filter, and the model omitted the broad
approximately 1.8 kHz bridge-admittance region visible in the recordings. The
tenor contact limit is now velocity dependent—longer for soft felt contact and
shorter for hard blows—and a smooth, register-tapered 1.8 kHz bridge-presence
region supports C4 partials 4–11. The latter is generated analytically and is
not an impulse response or extracted waveform.

At SFZ layer 10, C4 partial-profile MAE fell from **16.41 dB to 2.31 dB**.
Across all 480 cells, median/p90 partial-profile MAE improved from the prior
**6.56/15.96 dB to 4.39/8.89 dB**. The full grid remains 100/100. A new focused
runtime test requires C4 energy in the 0.8–1.6, 1.6–3.2, and 3.2–8 kHz bands so
this perceptually important regression cannot again hide inside an aggregate
score.

## Iteration 7 — replace C4 buzz with two-stage body

Listening to the first presence-corrected demo revealed that matching a static
spectrum was not sufficient: C4 had become bright but buzzy rather than full.
Time-resolved partial analysis found two causes. The model's third partial near
785 Hz was only **4.6 dB** below its strongest mode versus **21.5 dB** in
`C4v10.wav`, and its fundamental fell only about **10 dB** by 0.9 seconds versus
about **23 dB** in the reference. Conversely, the reference's fourth/fifth
partial body survives after that low-mode vertical energy is gone.

The correction separates four acoustic behaviors that one shared amplitude
curve could not represent:

- A narrow, smooth bridge antiresonance around 790 Hz suppresses the persistent
  third-partial buzz. It is computed from frequency/register, not copied EQ.
- The first two C4-region string modes transfer more energy through the fast
  vertical bridge path, exposing the body instead of droning underneath it.
- Fourth/fifth modes start at a lower level but retain a larger slow horizontal
  component, supplying body without a loud stationary ring.
- Low, inharmonic impact-board modes receive a longer and stronger
  register-tapered coupling, adding a wooden bloom rather than another harmonic
  oscillator.

The focused regression now also constrains C4's third partial to −30..−15 dB.
The old assumption that every upper partial must decay faster was replaced by
the measured register-dependent pattern: A2's fourth partial falls faster than
its fundamental, while at C4 the fundamental falls faster than partial 4. The
reference values over the scoring windows are −30.4/−16.0 dB at C4.

Final C4 layer-10 centroid is **461 Hz** versus **458 Hz** in the reference, and
partial-profile MAE is **2.18 dB**. Across all sixteen C4 layers, centroid error
is 0.5–18 Hz and partial-profile MAE is 1.51–2.78 dB. Across the complete
480-cell grid, partial-profile median/p90 is **4.16/9.02 dB** and decay-trajectory
median/p90 is **3.26/5.49 dB**. Both focused and full-grid scores remain
100/100.

## Full-piece render — public-domain BWV 846 Prelude

A complete work was added as a longer-form listening test after the single-note
and short-phrase iterations. The selected work is J. S. Bach's 35-measure
**Prelude in C major, BWV 846**. Note data was transcribed from the Mutopia
2011/09/12 LilyPond edition hosted by Wikisource; both the 1742 composition and
that typesetting are identified there as Public Domain. Wikimedia's Open
Well-Tempered Clavier CC0 score was used as a visual cross-check. No source
recording was downloaded or used in the render.

The deterministic performance contains **549 note events** with continuous
tempo arcs, more than 100 distinct quantized velocity values, half-measure
damper overlap, a broadened cadence, and a rolled final chord. The stereo stage
uses note-position panning plus mathematically generated early reflections and
filtered delay lines—never a sampled impulse response. `npm run track`
regenerates the result.

The checked WAV is **157.067 seconds**, stereo PCM16 at exactly **44,100 Hz**
(6,926,648 frames). It measures **−0.72 dBFS peak** and **−18.94 dBFS RMS**;
both channels are finite, DC is below 1.6e−6, the first 400 ms are silent, and
the first and final samples are zero. All track checks and the file hash are in
`reports/public-domain-track.json`.

## Iteration 8 — strict time-frequency fidelity rebuild

The permissive grid could still award 100/100 while hiding the listening
problems reported for C4. A second evaluator was therefore frozen with much
more aggressive criteria. It analyzes all **480 reference recordings and 480
fresh renders** for 2.55 seconds, applies one robust global level offset only,
and never normalizes loudness per pitch, register, or velocity. Its feature
cache stores scalar/time-frequency measurements, not PCM.

New measurements include a sixty-point 120 ms attack envelope; 10/50/90%
attack-energy times; five transient and seven sustain spectra in fourteen
auditory bands; up to sixteen resolved partial levels and stiff-string
locations; per-partial, per-band, and broadband decay; harmonic-to-residual
energy; detrended fundamental modulation; all 30 velocity curves; and separate
bass, middle, and treble tail distributions. Median and p90 tolerances both
contribute to the score. A report passes only if its aggregate is at least 85
and every category gate passes, so a favorable global median cannot hide a
bad register.

The analysis itself was audited during development. Bass sustain FFTs now use
at least 65,536 points and every partial search spans at least ±1.5 bins; this
removed a quantization artifact that had incorrectly penalized low-note
partial locations. Stereo reference power is averaged by channel, onset
alignment remains causal, inactive bands are excluded using measured source
noise floors, and only reliably strong partials contribute to late decay.

| Strict full-grid state | Score | Important change |
|---|---:|---|
| Frozen pre-rebuild baseline | **56.13** | Exposed large sustain, decay, and texture errors |
| First broadly retuned model | **83.84** | Measured stiffness, modal radiation, bridge admittance, two-stage body |
| Velocity/tail refinement | **84.24** | Cross-register level curve and removal of an ineffective residual path |
| Current model | **86.77** | Low-mid body/plate diffusion, restored bass low orders, measured C4 upper tail |

The final soundboard change was motivated directly by signed residual maps and
the “buzzing” listening report. From roughly D♯5 through C6 the old output kept
strong string lines while reference energy remained diffusely distributed
between them. A deterministic 55–630 Hz board-grain tail now decays over a
register-dependent 1.15–2.6 seconds. A much quieter 1.6–8 kHz plate-grain path
rises over 60 ms and decays in 450 ms, with smooth extra coupling around the
upper bridge transition. Both are filtered PRNG excitation—no recording,
impulse response, wavetable, or reference waveform is stored or replayed.

A final guardrail pass restored the deepest-bass first/second-mode radiation
and lengthened wound-string mode T60 by at most 15%, reducing the A0 hard-layer
local pitch error from **10.05 to below 1 cent**. Around middle C, only modes
four and five receive a smooth longer horizontal tail; this restores the
measured decay reversal in which the fast fundamental falls before the upper
body. Those changes returned the focused validation from 96 to **100/100**
without reducing the strict score.

| Strict metric, median / p90 | Baseline | Current |
|---|---:|---:|
| Global level residual | 1.94 / 5.11 dB | **1.30 / 3.50 dB** |
| Attack-envelope error | 1.39 / 3.53 dB | **1.33 / 3.37 dB** |
| Transient spectrum | 8.00 / 14.02 dB | **6.34 / 9.23 dB** |
| Sustain spectrum | 14.40 / 24.91 dB | **7.26 / 11.38 dB** |
| Resolved partial balance | 6.31 / 14.99 dB | **4.86 / 7.17 dB** |
| Partial decay | 6.03 / 12.99 dB | **5.55 / 8.47 dB** |
| Multiband decay | 13.73 / 31.43 dB | **5.93 / 8.68 dB** |
| Harmonic/residual balance | 1.36 / 14.15 dB | **0.32 / 5.31 dB** |
| Partial-location error | 3.22 / 6.80 cents | **0.54 / 3.70 cents** |

The current quick tuning subset improved from **82.14 to 84.83** during the
final body/low-order pass, and the exhaustive result improved from **84.24 to
86.77**. The focused score is **100/100**, the wide grid is **90/100 PASS**, and
all fourteen runtime/behavior tests pass. The strict report
continues to say `FAIL`: transient color, sustained auditory color, resolved
partial balance, three decay criteria, and the worst-register/velocity surface
remain outside their stretch gates. In particular, upper-treble reference
tails and some middle-register decay irregularities are still more complex
than this compact independent-note model. That failure is retained as an
honest target rather than relaxed after tuning.
