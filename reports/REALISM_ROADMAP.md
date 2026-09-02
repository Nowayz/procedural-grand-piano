# Procedural grand-piano realism goal

## Goal

Implement the remaining piano-simulation improvements in measured priority
order. Keep a change only when it improves the dry direct-reference benchmark
or produces a clearly documented listening improvement without regressing the
benchmark, runtime correctness, determinism, or stability. Record rejected
experiments so they are not accidentally repeated.

## Acceptance protocol

1. Establish the current dry baseline with the focused, wide-grid, and strict
   reference suites. Room impulse responses are excluded from model scoring.
2. Use the quick strict subset to screen parameter and model experiments.
3. Verify promising changes with the exhaustive 480-recording strict suite,
   the focused suite, the wide-grid suite, and runtime tests.
4. Keep benchmark improvements. A benchmark-neutral change may be kept only
   with an A/B listening render and a documented physical or musical benefit.
5. Revert regressions and record their measured result under Rejected
   experiments.

## Checklist

- [x] 1. Time-varying sustain color—currently the largest error.
- [x] 2. Treble decay/aftersound, especially A7–C8.
- [x] 3. Hammer and soundboard transient spectrum.
- [x] 4. Partial balance and frequency-dependent decay.
- [x] 5. More irregular, note-specific bridge/soundboard modes.
- [x] 6. True inter-note sympathetic resonance and duplex-scale coupling.
- [x] 7. Continuous half-pedal, una-corda, key motion, and repetition mechanics.
- [x] 8. Stereo radiation/microphone modelling; keyboard panning and room IR
      remain separate presentation layers.

## Baseline

The starting reports recorded 97/100 focused, 90/100 wide-grid, and 88.15/100
strict fidelity. The completed implementation records 97/100 focused,
90/100 wide-grid, and 88.66/100 strict fidelity. The strict suite still fails
seven category gates, so the checklist is complete but fidelity work can
continue beyond this scoped pass.

## Experiment log

### Accepted

- Item 1: removed the unsupported middle-register partial-4/5 slow-tail boost.
  A sweep of 1.5, 1.2, 0.9, 0.6, 0.3, 0, -0.3, and -0.6 selected zero as
  the best cross-suite value. Exhaustive strict fidelity improved from 88.15
  to 88.43 while focused validation stayed 97/100. Sustain-spectrum
  median/p90 improved from 7.2916/9.5631 to 7.2716/9.5394 dB,
  partial-timbre median/p90 from 5.0326/7.9361 to 5.0016/7.5120 dB, and
  multiband-decay median/p90 from 5.6829/9.0152 to 5.6656/9.0020 dB.
- Item 2: reduced the extreme-treble high-partial slow-mode loss coefficient
  from 0.80 to 0.35 after exhaustive sweeps at 0.65, 0.50, 0.35, and 0.20.
  Strict fidelity improved from the item-1 baseline of 88.43 to 88.44.
  A7 partial-decay median improved from 9.41 to 8.93 dB. C8 sustain-spectrum
  median improved from 8.60 to 8.54 dB, partial-timbre median from 8.83 to
  8.69 dB, and multiband-decay median from 9.99 to 9.91 dB.
- Item 3: increased the treble impact-board observation rise from 5 to 8 ms.
  Exhaustive strict fidelity improved from 88.44 to 88.45, while transient
  spectrum median/p90 improved from 6.2238/8.5836 to 6.2168/8.5709 dB.
  The change affects the timing of the existing short impact modes, not their
  modal gain or the sustained string bank.
- Item 4: increased the partial-number exponent in the baseline string-loss
  law from 0.70 to 0.75. Exhaustive strict fidelity improved from 88.45 to
  88.53 while focused validation stayed 97/100. Partial-timbre p90 improved
  from 7.5120 to 7.4461 dB, partial-decay p90 from about 8.90 to 8.7850 dB,
  and multiband-decay p90 from 9.00 to 8.9698 dB. This makes upper partials
  lose energy slightly faster while preserving the fitted note/velocity loss
  surface and the two-stage decay topology.
- Item 5: fitted six spatial bridge harmonics, each with a modal-frequency
  slope, to signed transient-spectrum residuals and applied the result as a
  bounded per-key/per-mode impact-participation correction. Held-out velocity
  layers improved from 4.437 to 4.231 dB MAE. A ±1.25 dB runtime bound raised
  exhaustive strict fidelity from 88.53 to 88.66 while focused validation
  stayed 97/100. Transient median/p90 improved from 6.2089/8.5679 to
  6.1885/8.5123 dB and sustain median/p90 from 7.2621/9.4982 to
  7.2413/9.4333 dB. The compact fitter is reproducible in
  `tools/fit-bridge-participation.mjs`.
- Item 6: added a causal shared-bridge bus to the realtime engine. Every open
  string bank receives only the previous-sample bridge motion from the other
  active voices, so chords exchange resonant energy without self-feedback.
  Two independently decaying, slightly offset third- and fourth-aliquot
  duplex resonators per voice are driven from the same bus. A C4/G4 chord
  differs from the linear sum of isolated notes by 2.8% RMS, while all
  offline single-note waveforms remain bit-identical. Strict fidelity stayed
  88.53, focused validation stayed 97/100, and 73/73 runtime tests pass.
- Item 7: retained the existing continuous half-pedal/felt-separation model
  and added sample-scheduled continuous una-corda and key-position controls.
  Una-corda shifts the hammer contact across one-, two-, and three-string
  unisons and lowers the hammer/string brightness continuously. Explicit key
  motion controls per-note damper lift; the amount of action return scales a
  rapid repetition strike, while legacy note-on/off remains compatible. C5
  una-corda RMS moves monotonically 0.0951/0.0799/0.0661 at positions
  0/0.5/1. Key positions 0/0.4/0.8 after damper contact yield tail RMS
  0.00023/0.00104/0.01786. Strict/focused remain 88.53/97 and 75/75 tests
  pass.
- Item 8: added a native two-channel realtime radiation path while preserving
  the existing mono API and dry benchmark waveform. Each voice derives side
  energy from its bridge coordinate, a frequency-dependent soundboard lobe,
  and high/low radiation split; the left and right virtual microphones have
  distinct high-frequency responses. A1 is left-weighted at 0.1485/0.1298
  RMS, C4 is nearly centered at 0.0745/0.0736, and C7 is right-weighted at
  0.0448/0.0474. The AudioWorklet now emits two channels and the direct API
  provides allocation-free `processStereo`. Strict/focused/wide remain
  88.53/97/90 and 76/76 tests pass.

### Rejected

Earlier experiments are documented in `PROGRESS.md`.

- Item 1, late slow-mode loss surface (±2 dB/s): quick strict fidelity fell
  from 86.94 to 86.43. Sustain-spectrum median/p90 worsened from
  7.3770/9.6149 to 7.4124/9.8277 dB; partial timbre, partial decay, and
  multiband decay also worsened. The fitted residual slope is not equivalent
  to the physical slow-pole loss after the fast/slow modes are mixed.
- Item 1, upper-treble slow-tail damping sweep: reducing the coefficient from
  0.80 to 0.65 scored 86.93 and worsened sustain color; increasing it to 0.95
  remained 86.94 and changed the sustain median by only 0.0014 dB. Neither
  produced a meaningful improvement, so 0.80 was restored.
- Item 1, fitted slow-mode bridge participation: a ±1.5 dB correction scored
  86.89; reducing it to ±0.5 dB scored 86.93 versus the 86.94 baseline.
  Although some partial and decay medians improved, sustain and transient
  color worsened enough to lower the aggregate, so the surface was removed.
- Item 1, seven-frame modal-drive refit: despite improving held-out regression
  error, the direct quick benchmark fell from 86.94 to 86.82 and every scored
  spectrum median worsened. The previous bounded coefficients were restored.
- Item 1, middle partial-4/5 slow-tail negative sweep: -0.3 improved strict
  fidelity to 88.34 but reduced focused validation from 97 to 93; -0.6 also
  reversed the quick-score trend. Both were rejected in favor of zero.
- Item 2, hard-strike termination floor: adding 15% minimum slow-mode
  emergence left exhaustive fidelity at 88.43 and improved A7 metrics only by
  hundredths of a decibel while slightly worsening C8. It was removed.
- Item 3, middle felt-noise radiation trim: a 15% smooth trim reduced quick
  strict fidelity from about 87.49 to 87.43 and worsened transient-spectrum
  median from 6.2879 to 6.3124 dB. This identified early string-mode balance,
  rather than broadband felt noise, as the more credible target.
- Item 3, middle fast/slow partial redistribution: increasing the slow share
  reduced quick fidelity to 87.42 without improving transient-spectrum median,
  so the original fast/slow mixture was restored.
- Item 3, middle hammer-radiation low-pass: both a register-dependent cutoff
  and a true dry/filtered blend improved one transient median but reduced the
  quick or exhaustive aggregate and worsened other transient/sustain tails.
  The added filter state was removed.
- Item 3, impact-board gain increase: raising the output mix from 1.35 to 1.50
  reduced quick fidelity from about 87.49 to 87.22 and worsened transient
  spectrum, sustain color, and loudness. The increase was rejected.
- Item 3, impact-board gain decrease: lowering the output mix to 1.20 scored
  87.42 quick and worsened transient-spectrum median to 6.3537 dB. The
  original 1.35 mix was restored.
- Item 3, short treble attack-mode increase: raising its gain from 2.5 to 3.0
  reduced quick fidelity to 87.41 and worsened transient p90 and level
  residuals, so the increase was rejected.
- Item 3, short treble attack-mode decrease: lowering its gain to 2.0 scored
  87.39 quick and worsened transient median and sustain color; 2.5 was
  restored.
- Item 3, 12 ms treble impact rise: quick fidelity improved, but exhaustive
  fidelity fell from the 8 ms candidate's 88.45 to 88.39 and transient
  median/p90 worsened to 6.2312/8.6243 dB. The 8 ms value was restored.
- Item 4, refreshed smooth modal-loss fit: held-out slope error improved, but
  direct quick fidelity fell from about 87.49 to 87.20 and partial-decay p90
  worsened. The previous bounded coefficients were restored.
- Item 4, partial-loss exponent brackets: reducing the exponent from 0.70 to
  0.65 lowered quick fidelity to 87.30. Raising the accepted 0.75 candidate
  to 0.80 improved the quick subset to 87.65, but exhaustive fidelity fell
  from 88.53 to 88.51 and partial-decay p90 worsened from 8.7850 to 8.8897
  dB. The exhaustive winner, 0.75, was retained.
- Item 5, arbitrary per-key impact participation: deterministic modal gain
  variation at ±1.04 dB improved the quick subset but reduced exhaustive
  fidelity from 88.53 to 88.29. A separate ±0.43 dB phase also passed quick
  but fell to 88.44 exhaustive. Both were removed.
- Item 5, key-dependent modal-frequency loading: fixed ±0.3% shifts scored
  87.59 and 87.60 quick versus 87.62. A spatial bridge-coordinate
  participation model at both polarities scored 87.61 and 87.59. These
  generic irregularity models were removed; item 5 requires measured
  per-key participation rather than decorative randomness.
- Item 5, measured-participation upper bounds: ±1.50 dB raised strict fidelity
  to 88.71 but reduced focused validation to 93/100 by exaggerating A6's
  100–150 ms rebound. ±1.375 dB similarly scored 88.69/93. The strongest
  cross-suite-safe bound, ±1.25 dB, was retained at 88.66/97.
