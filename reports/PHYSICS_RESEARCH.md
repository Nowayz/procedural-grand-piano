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
  modal soundboard plus a smooth absolute-frequency bridge-mobility envelope.
  [Mechanical mobility](https://arxiv.org/abs/1210.5688),
  [soundboard regimes](https://arxiv.org/abs/1305.3057),
  [modal measurements](https://arxiv.org/abs/1212.3068)
- Fletcher's stiff-string result gives the normalized partial locations used
  directly by the synthesizer:

  ```text
  f_n = n f_1 sqrt((1 + B n^2) / (1 + B))
  ```

  `B` follows the analytic whole-compass scale law described below. The
  normalization by `sqrt(1+B)` keeps the requested fundamental at `f_1`.
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

## Key return, damper contact, and acoustic note length

A notation or MIDI gate is not the acoustic duration of a piano tone. KTH
high-speed measurements of a forte C4 staccato show about 2 ms of hammer–string
contact and the damper returning about 80 ms after impact; the resulting tone
lasts about 100 ms even under deliberately short articulation.
[KTH piano-action measurements](https://www.speech.kth.se/music/5_lectures/askenflt/measure.html)

Taguti et al. report individual tones down to roughly 50 ms in extremely rapid
passages, but not instantaneous silencing. Their measured C4–C5 fast-return
attenuation is about 220–470 dB/s, and their reduced fast-return model uses
200 dB/s. A slowly regulated return loses about 20 dB in 0.10–0.15 s and is
approximated by about 100 dB/s for its first 0.1 s before the faster stage.
[Taguti et al., 2002](https://www.jstage.jst.go.jp/article/ast/23/5/23_5_244/_pdf)

Damper loss is mode-selective. Bank notes that low-order one-pole dampers work
reasonably in the middle and high register but miss bass roughness and partials
whose nodes lie beneath the felt. Lehtonen, Askenfelt, and Välimäki describe
free vibration, damper interaction, and a quieter residual phase: the damper
suppresses vertical motion more strongly than horizontal polarization. Their
C1 measurement places the felt over normalized string positions 0.122–0.184.
[Bank thesis](https://home.mit.bme.hu/~bank/thesis/pianomod.pdf),
[Lehtonen et al.](https://aaltodoc.aalto.fi/bitstreams/b4811040-596e-4e1c-87f1-3e67f528eaa9/download)

Acoustic grands leave the top register undamped; the retained model uses the
upper 18 keys, G6–C8.
[Kawai explanation](https://www.kawai-global.com/support/faq/why-do-the-upper-18-notes-of-my-kawai-digital-piano-sustain-without-using-the-damper-pedal/)

That absence of dampers does not imply an arbitrarily long treble tail: short
top strings lose energy quickly enough that manufacturers omit the dampers.
The impact-body bank is a free structural response after the hammer pulse, so
its 58–880 Hz slow branch must not determine the lifetime of a C8 strike. The
model tapers slow low-body participation by `1 - 0.98 E_top`. At velocity 0.8,
the resulting C8 response is about −46 dB at 1 s, −65 dB at 2 s, and reaches
complete peak-relative −80 dB retirement near 5.5 s instead of 17.9 s. This
also restores the physical trend of faster decay toward the top rather than
letting the lowest soundboard mode lengthen toward C8.

The implementation therefore does not clamp short gates to an invented minimum
duration. For normalized release speed `v`, key-return travel is

```text
t_travel = 0.085 - 0.040 v^0.65 seconds,
```

with first contact no earlier than 50 ms after strike and a 30-to-4 ms contact
ramp. For damped keys, partial `n` starts from a 170-to-220 dB/s register slope
multiplied by `1 + 0.035(n - 1)` and by a bass node-overlap factor derived from
the C1 felt span. During the first 100 ms the target slope is
`(0.5 + 0.5v)` of that free-return value; afterward it reaches the full value.
Horizontal-polarization loss is 45% of vertical loss. Long coupled-body
resonators are damped through their stored state at 100–180 dB/s, while the
broad soundboard response decays from its existing energy. Release noise begins
at contact, not at key-up.

Normalized pedal lift `p` maps to felt contact through the narrow interaction
interval `0.2 < p < 0.8`:

```text
c(p) = 1 - smoothstep((p - 0.2) / 0.6).
```

Within that interval the amplitude-dependent overlap falls to zero when the
peak-relative vibration drops below `0.2 smoothstep(...)^3`. This produces the
measured initial free vibration, finite nonlinear damper interaction, and
quieter final free-vibration stage without restoring energy. The normalized
pedal thresholds are a reduced control mapping, not dimensions measured on a
specific pedal linkage. Fully raised pedal cancels pending contact or catches
an already damped voice without restoring lost modal gain. MIDI 91–108 bypass
damper attenuation and retire through natural modal loss. Other voices retire
only after the expected −80 dB damping span and a peak-relative envelope below
−80 dB for 20 ms.

## Runtime mapping

The retained implementation has five interacting reduced subsystems:

1. Up to 192 stiff-string partials, with one, two, or three slightly detuned
   strings according to register.
2. Independent fast vertical, slow horizontal, and weak polarization poles per
   partial. This creates frequency-dependent and two-stage decay rather than a
   shared envelope.
3. A nonlinear finite hammer-force pulse and independent deterministic felt,
   action, and diffuse-board noise.
4. Ten quadrature sections sampled from a continuous mean-mobility profile and
   22 short impact/plate modes generated from continuous modal-density, loss,
   and bridge-participation functions.
5. Analytic bridge mobility, radiation, and loss terms derived from the reduced
   physical model.

The former packed correction surface was removed because its optimization used
manufactured missing-key references. The runtime now contains no such payload
or interpolation path.

## Equation audit and smooth whole-compass reduction

The remaining per-key, per-frequency, and soundboard-modal anchor tables have
also been removed. The replacement functions are continuous over their
supported domains; the exponential inharmonicity law is analytic, the bridge
and register envelopes are finite Chebyshev polynomials, and the compact
soundboard uses analytic frequency, Q, loss, radiation, and participation
profiles. No neighboring-key interpolation occurs at runtime.

| Subsystem | Physical equation supported by research | Runtime reduction and status |
|---|---|---|
| String scale | `F0=(1/2L)sqrt(T/mu)`, `B=pi^3 E d^4/(64 T L^2)`, and `f_n=n F0 sqrt(1+B n^2)` | The synthesizer divides by `sqrt(1+B)` because its input is the actual first partial. Following Rigaud et al., whole-compass `B(m)` is the sum of bass- and treble-bridge exponential asymptotes: `exp(-0.0764347m-6.68229)+exp(0.0796515m-12.91564)`. This is a literature-backed smooth scale model, not key interpolation. |
| String loss | `y_tt=c^2 y_xx-kappa^2 y_xxxx-2b1 y_t+2b3 y_txx`; modal damping therefore contains a constant and a frequency-squared term | The modal pole uses an analytic base T60 and quadratic high-frequency reduction. A held-out, bounded smooth correction of at most 3 dB/s adjusts the loss surface over register, velocity, and partial number; it changes the profile without replacing the physical positive-loss baseline. |
| Hammer contact | Classical felt laws use one-sided nonlinear contact `F=K delta^p H(delta)` and improve it with hysteresis | The finite asymmetric force pulse is a causal, efficient surrogate, not an exact solution of the hammer mass/contact ODE. Velocity-dependent duration and bandwidth are physically motivated but phenomenological. |
| Strike point | Pinned-string mode shape is `sin(n pi x/L)` | Modal drive uses that sine factor directly. This part is analytic and physically derived. |
| Unison coupling | Bridge admittance couples doublets/triplets; symmetric and antisymmetric modes have different loss and produce beats/aftersound | Slightly unequal strings plus independent fast, slow, and polarization poles are a reduced modal realization. It reproduces the mechanism but does not solve the full admittance matrix. |
| Bridge/soundboard mobility | Mechanical mobility is `Y(omega)=V(omega)/F(omega)`; mean mobility depends on structural mass, modal density, and loss factor. Rib confinement changes the regime near 1.1 kHz | Ten log-frequency quadrature sections approximate the mean response. Their gain is a low-frequency radiation-efficiency term times a smooth log-mobility loss, while Q rises continuously toward local inter-rib motion. The short impact bank uses a power-warped retained modal density, `tau(f)` loss, alternating bridge participation, and a smooth 2.35 kHz mobility lobe. These are calibrated reduced profiles, not identified eigenmodes of a particular board. |
| Acoustic radiation | Soundboard radiation follows plate/waveguide dispersion and coincidence; ribbing extends subsonic behavior and changes the treble regime | The smooth register envelope is a sixth-order polynomial (1.59 dB RMS error to the former anchors). Literature validates a smooth mean trend plus a regime transition, but not these instrument-specific coefficients. |
| Damper | Felt contact preferentially suppresses vertical polarization; part pedal has initial free vibration, an interaction stage, and a quieter final free stage | Separate vertical/horizontal poles, staged contact, continuous pedal lift, and amplitude-dependent felt separation implement these measured behaviors. Contact remains a reduced modal model rather than a finite-element felt/string solution. |
| Mechanical and felt noise | Hammer/action contact and soundboard vibration contain non-periodic, broadband energy | Seeded noise passed through causal filters is a phenomenological texture model. Its existence and timing are physical; its filter cutoffs and gains are fitted synthesis parameters, not derived material constants. |
| Output nonlinearity | A real soundboard, air path, microphone, and playback chain are weakly nonlinear and bandwidth limited | The final `tanh` limiter and DC blocker provide numerical/output conditioning. They are not claimed as an acoustic equation for a particular piano or microphone. |

Only the fitted envelopes were made continuous and piecewise smooth. The complete
instrument intentionally retains discrete structural transitions where a real
scale changes from one to two to three strings and where dampers end. Treating
those physical construction changes as one globally smooth string would be less
faithful, not more.

The removed 48-value partial-color surface had no independent physical state:
it duplicated hammer strike position, bridge mobility, soundboard modes, and
radiation. Removing it and replacing the stiffness anchors with the physical
scale law reduced strict direct-recording fidelity by 2.11 points, but avoids
encoding note-specific residuals as imaginary physics.

Primary validation sources: [Rigaud et al., *A parametric model and estimation
techniques for the inharmonicity and tuning of the piano*](https://doi.org/10.1121/1.4799806)
(JASA 2013); [Ege and Boutillon, *Synthetic description of the piano soundboard
mechanical mobility*](https://arxiv.org/abs/1210.5688); [Ege, Boutillon, and
collaborators, *Vibroacoustics of the piano soundboard*](https://arxiv.org/abs/1305.3057);
[Borin and De Poli, *A Hysteretic Hammer-String Interaction Model*](https://www.research.unipd.it/handle/11577/3311009)
(1996); [Weinreich, *Coupled piano strings*](https://doi.org/10.1121/1.381677)
(JASA 1977); and [Lehtonen, Askenfelt, and Valimaki, *Analysis of the
part-pedaling effect in the piano*](https://doi.org/10.1121/1.3162438)
(JASA 2009).

## Evidence-driven iterations

Reference evidence is now restricted to the 30 physically recorded keys and
their 16 actual velocity layers. Sample-rate conversion preserves physical
pitch and duration; tuning metadata and neighboring-key transposition are not
used. Scores from the invalidated missing-key evaluation are intentionally not
retained here.

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

The current residual audit narrows the next research target. Static gain on
upper-treble partials failed experimentally, while measured string end
conditions are governed by bridge input admittance and coupled treble unisons
produce multiple decay rates. This motivated a treble extension that changes
string/termination bridge participation over time rather than adding another
fixed spectral lobe. The 58 Hz impact-mode correction is
the complementary low-frequency lesson: reducing a continuous plate to a
small retained modal bank requires coupling weights as well as plausible modal
frequencies and decay times.

## Reduced string–bridge termination coupling

Ege and Chaigne show that a piano string's end condition can be represented by
the bridge input admittance. Weinreich's coupled-string result, summarized and
implemented in resonator form by Bank, predicts a strongly radiating symmetric
mode and a more weakly coupled antisymmetric mode with different decay rates.
The real and imaginary parts of bridge admittance can change both modal loss
and modal frequency; their superposition produces beating and two-stage decay.

The runtime already had independent fast and slow poles, so it already covered
the resistive part of this reduced normal-mode model. The added termination
state models the initially weak bridge participation of the slow mode:

```text
c(n,m,v) = 0.9 E_top(m) (1-v)^2 (1-exp(-(n-1)/2.5))
g_slow(t) = 1 - c exp(-t/0.7 s)
y_bridge(t) = y_fast(t) + g_slow(t) y_slow(t) + y_horizontal(t)
```

`E_top` is the existing smooth extreme-treble transition. Since
`0 <= c < 0.9`, the observation gain remains in `(0.1, 1]`; the state cannot
inject feedback energy or destabilize a modal pole. Velocity changes only the
excitation/participation of the coupled normal modes, not the linear bridge
eigenfrequencies. This is a compact aftersound surrogate, not a solved bridge
admittance matrix.

A direct reactive frequency split was also tested. A 1.5-cent upper-treble
split reduced quick strict fidelity from 87.15 to 86.62; a 0.25-cent split
reduced the exhaustive score from 88.24 to 87.97. Both were rejected. The
bounded participation state raises the exhaustive score to 88.25, improves
resolved-partial median error from 5.0468 to 5.0326 dB, and improves
multiband-decay p90 from 8.6779 to 8.6663 dB without moving partial locations.

Primary sources: [Ege and Chaigne, *End conditions of piano strings*](https://arxiv.org/abs/1101.4511),
[Bank, *Physics-Based Sound Synthesis of the Piano*, Sections 2.2.1 and 5.3](https://home.mit.bme.hu/~bank/thesis/pianomod.pdf),
and [Weinreich, *Coupled piano strings*](https://doi.org/10.1121/1.381677).

The release model is an evidence-constrained reduction, not a finite-element
action simulation. It does not solve continuous key displacement, a measured
pedal-linkage trajectory, per-key damper geometry, or inter-string energy
exchange. Its release-velocity input and normalized continuous pedal lift are
compact control proxies; the literature ranges constrain their timing and
attenuation rather than proving instrument-specific equivalence.
