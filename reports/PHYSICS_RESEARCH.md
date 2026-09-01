# Physics research and model reduction

This note records the physical hypotheses used to tune the procedural model.
The reference recordings informed scalar targets only. No reference waveform,
impulse response, or resampled PCM is present in the runtime.

## Primary sources and reduced equations

- Bank's *Physics-Based Sound Synthesis of the Piano* derives an efficient
  digital-waveguide/resonator-bank piano and, importantly, begins and ends the
  model design with measurements of a real instrument. It also shows that
  bridge-coupled unisons and orthogonal string polarizations produce beating
  and two-stage decay. The runtime uses the mathematically equivalent parallel
  resonator form. [Thesis PDF](https://home.mit.bme.hu/~bank/thesis/pianomod.pdf)
- Bank's later thesis develops low-order loss filters and efficient nonlinear
  string models. It is the basis for treating measured decay as a constraint on
  modal pole radii rather than as a shared amplitude envelope.
  [Thesis page](https://home.mit.bme.hu/~bank/phd/)
- Ege and Boutillon describe piano soundboard driving-point mobility as
  `Y(omega) = V(omega) / F(omega)`. Their reduced description needs modal
  density `n(f)`, mean loss factor `eta(f)`, and mass `M`, rather than a full
  finite-element mesh. Measurements show a mobility transition around 1.1 kHz
  as waves become localized between ribs. This supports the runtime's compact
  modal soundboard plus absolute-frequency bridge-mobility surface.
  [Mechanical mobility](https://arxiv.org/abs/1210.5688),
  [soundboard regimes](https://arxiv.org/abs/1305.3057),
  [modal measurements](https://arxiv.org/abs/1212.3068)
- Fletcher's stiff-string result gives the normalized partial locations used
  directly by the synthesizer:

  ```text
  f_n = n f_1 sqrt((1 + B n^2) / (1 + B))
  ```

  `B` is measured/interpolated over the piano scale. The normalization by
  `sqrt(1+B)` keeps the requested fundamental at `f_1`.
  [Measured grand-piano inharmonicity](https://doi.org/10.2307/40285331)
- A damped stiff-string PDE can be written in the reduced form

  ```text
  y_tt = c^2 y_xx - kappa^2 y_xxxx - 2 b1 y_t + 2 b3 y_txx
  ```

  so modal loss grows approximately as `b1 + b3 omega^2`. The retained model
  implements the corresponding quadratic high-frequency T60 reduction
  `T60(f) ~ T60_base / (1 + (f / 9500)^2)`, followed by the measured bridge
  radiation loss. Each resonator pole is

  ```text
  r = exp(-ln(1000) / (T60 * 44100)).
  ```

  This is an amplitude T60: after `T60` seconds its amplitude is `-60 dB`.
- Felt hammers are nonlinear contacts commonly approximated by
  `F = K delta^p`, with velocity-dependent contact duration and hysteresis.
  The runtime reduces this to a finite, asymmetric compression pulse whose
  exponent, duration, and bandwidth vary with register and hammer velocity.
  The model remains causal and avoids solving a nonlinear collision at every
  output sample. [Physics-informed piano model](https://www.frontiersin.org/journals/signal-processing/articles/10.3389/frsip.2023.1276748/full)

## Runtime mapping

The retained implementation has five interacting reduced subsystems:

1. Up to 192 stiff-string partials, with one, two, or three slightly detuned
   strings according to register.
2. Independent fast vertical, slow horizontal, and weak polarization poles per
   partial. This creates frequency-dependent and two-stage decay rather than a
   shared envelope.
3. A nonlinear finite hammer-force pulse and independent deterministic felt,
   action, and diffuse-board noise.
4. Ten broad soundboard resonances and 22 short impact/plate modes.
5. Bridge mobility, radiation, and loss surfaces interpolated smoothly over 15
   pitch anchors and three measured velocity anchors.

The packed calibration payload is 1,845 bytes of signed scalar coefficients:
quarter-dB mobility/loss values and half-dB modal colors. It contains no audio
frames, phase, waveform segments, impulse response, sample decoder, or playback
path. Packing changes representation only; interpolation supplies every key
and intermediate velocity.

## Evidence-driven iterations

All scores below use the strict chromatic suite: 88 keys times the lowest,
middle, and highest SFZ velocity layers, or 264 fresh procedural renders.

| Retained stage | Strict score |
|---|---:|
| First all-key baseline | 82.71 |
| Broad radiation and velocity surface | 91.59 |
| Quadratic string loss and bridge loss | 92.54 |
| Frequency-dependent radiated-board loss | 93.20 |
| Measured low-order modal color | 94.20 |
| Hammer/impact mobility color | 94.52 |
| Shared absolute-frequency bridge mobility and final reduction | **95.06** |

The final step uses one absolute-frequency mobility law for every mode. A
larger partial-index-specific table improved an intermediate model by only
0.07 and was removed. Three other rejected fits were a six-band impact table
(+0.01), an extra static sustain surface (+0.02), and a quadratic longitudinal
phantom-partial term (at most +0.05). Raising the low-order soundboard Q also
hurt: a sparse reduced modal bank needs broader modes than a dense physical
board. These failures are useful constraints against overfitting.

## What the score does and does not mean

The strict analysis measures level surfaces, attack timing, 14-band transient
and sustain spectra, resolved partial balance and locations, partial and
multiband decay, harmonic/residual balance, and unison modulation. These are
repeatable proxies for recognizably piano-like behavior; they are not a
listener study and do not prove equivalence to a sampled concert grand.

The remaining failures are concentrated in note-specific sustain color and
treble decay tails. A real piano also contains bridge-position variation,
irregular rib spacing, duplex-scale coupling, room/microphone coloration, and
small action/calibration defects. Some residual is therefore recording- and
instrument-specific, but the failed temporal criteria show that it is not
honest to attribute the whole distance from 100 to real-world imperfections.
