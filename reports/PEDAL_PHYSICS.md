# Pedal mechanics and acoustic reduction

The pedal controls now model finite movement. Soft-pedal excitation uses
nonlinear-contact scaling and passive coupling between strings of a note.
These changes improve the physical consistency of the existing calibrated
synth; they do not establish a complete first-principles concert-grand model.

## Pedal position is a state, not an instantaneous command

For both `sustain()` and `unaCorda()`, the event value is a target `u` for
normalized physical position `s`:

```text
s'' + 2 ω s' + ω²(s − u) = 0
ω = 4.743864518390579 / T95
```

This is a critically damped mass–spring–damper reduction. Position and velocity
are continuous when a target changes. With a constant target and `e = s − u`,
the exact update over one sample is

```text
c = s' + ωe
s_next  = u + (e + c Δt) exp(−ωΔt)
s'_next = (s' − ωc Δt) exp(−ωΔt)
```

The full-step response from rest is `s(t) = 1 − (1 + ωt)exp(−ωt)`.
Defaults are **120 ms to 95% for sustain** and **160 ms for una corda**.
These are explicit response calibration choices, not experimentally proved
human minimum press times. Pedal geometry, regulation, footwear, technique,
and controller sampling differ. The named `PIANO_SUSTAIN_RESPONSE_SECONDS`
and `PIANO_UNA_CORDA_RESPONSE_SECONDS` defaults in `tools/piano-mechanics.h`
can be changed at build time. A controller already sending measured continuous
travel may warrant shorter response times to avoid adding excessive latency.

Movement advances once per audio sample, including silence. Events at the same
sample retain their order; setting a target and striking immediately uses the
current position. To hear the fully shifted attack, start the pedal movement
before the note. Moving una corda during an existing tone does not alter that
tone until a subsequent strike. Reversals preserve momentum. Reset clears
positions, velocities, targets, and queued events.

## Damper contact follows actual lift

Key return starts on key-up even while sustain holds the dampers clear. The
existing 45–85 ms key-return model and contact ramp remain. A later sustain
release does not restart the key-return clock. Actual pedal lift gates felt
interaction; a re-pedal only catches vibration once the moving mechanism has
lifted far enough. Accumulated attenuation is never undone.

The inter-note excitation gate also follows actual continuous contact strength,
so key-up does not prematurely remove coupling during free return travel.

Release-noise onset and the initial regulated damping stage start at actual
felt contact, including contact after a pedal release. The actual normalized
pedal speed determines this stage for a moving pedal; key-return speed applies
to key-driven contact. The existing continuous felt-overlap and quieter
residual phase remain. They are reduced, amplitude-dependent models, rather
than a spatial felt collision solver. The free/contact/residual stages are
supported by [Lehtonen, Askenfelt & Välimäki (2009)](https://aaltodoc.aalto.fi/bitstreams/b4811040-596e-4e1c-87f1-3e67f528eaa9/download).
Key-return timing and attenuation evidence is recorded in
[PHYSICS_RESEARCH.md](PHYSICS_RESEARCH.md).

## Una corda: geometry, impulse, and contact duration

Grand-piano una corda shifts the action so that one string of a duplet or
triplet is not struck. That string can still vibrate through the bridge.
[Miranda Valiente et al., *Modelling the una-corda effect in pianos* (2024)](https://generic.wordpress.soton.ac.uk/isvr-new/wp-content/uploads/sites/422/2024/12/una-corda-effect-in-pianos.pdf)
model this distinction and report longer contact when fewer strings are struck.

Each contact has an overlap `a_i(s)`. The outer contact falls smoothly to zero
between positions 0.65 and 0.95; the remaining contacts stay present. These
normalized geometric thresholds are regulation choices, not measured lateral
dimensions. A one-string bass note keeps its only contact. Unlike the former
8%/32% residual excitation, a cleared string receives **zero direct impulse**.

Let `N_eff = Σa_i`. The contact law is `F = K δ^p` for positive compression.
The exponent follows a smooth analytic fit to the published C2/C4/C7 values
2.3/2.5/3.0. Per-string mass follows an exponential curve with two smooth changes
of slope; estimated hammer mass remains an affine function of register. Their
calibration uses the C1–C8 anchors in
[Wood's piano simulation parameter tables](https://euphonics.org/12-2-1-parameter-values-for-piano-simulations/).
Those describe one Broadwood instrument and literature estimates; fitting
them does not measure this virtual grand's exact geometry. The runtime has no
mass lookup table. The [continuous-curve regression](CONTINUOUS_CURVES.md)
measures the effect of these approximations on contact duration.

For the first string mode, point effective mass at strike ratio `a` is
`M_s / (2 sin²(πa))`. With total participating string mass `M` and hammer mass
`m_h`, the two-body reduction has mass `μ = m_h M / (m_h + M)`.
Integrating the power-law contact energy gives

```text
T ∝ (μ/K_total)^(1/(p+1)) v^((1−p)/(p+1))
J = (1 + restitution) μv
```

Relative to the same note's normal strike, at the same hammer speed:

```text
K_total(s) / K_total(0) = k_felt(s) N_eff / N
T(s)/T(0) = [(μ(s)/μ(0)) N/(N_eff k_felt(s))]^(1/(p+1))
J(s)/J(0) = μ(s)/μ(0)
k_felt(s) = 1 − 0.45 smoothstep(s)
```

The 0.55 fully shifted felt-stiffness ratio is a voicing choice. It represents
softer felt under the shifted contact and is not a measured universal value.
Nonlinear stiffness and the effect of softer felt on contact duration are
supported by [Russell's hammer measurements and discussion](https://www.acs.psu.edu/drussell/Piano/NonlinearHammer.html).
An unchanged restitution coefficient cancels in the impulse ratio. The
diagnostic impulse is an elastic-reference value (`restitution = 1`).

The runtime applies these ratios to the existing calibrated finite source
pulse and distributes impulse in proportion to `a_i/N_eff`. The pulse is still
an analytic reduction. Its nominal duration and asymmetry remain calibrated;
they are not a live integration of felt hysteresis or all string reflections.
No separate 14% brightness reduction or arbitrary string-level soft-pedal
multiplier remains. A longer pulse supplies the change in excitation spectrum.
String admittance and existing vibration remain separate from contact weights.

This reduction was selected after a direct collision prototype produced
unacceptable treble cancellations and slower chord starts in the existing
soundboard model. Keeping the nominal acoustic calibration and changing its
physically derived contact ratios preserves the established tone.

## Passive coupling within a note

For each nearly degenerate unison group, normalize modal coordinates by their
radiation weights. Apply the same common-bridge operation to both recurrence
states:

```text
z_next = [I − (1 − exp(−Nγh))/N · 11ᵀ] z
γ(f) = 0.03 / (1 + f/2000) per second
h = 8 / sample_rate
```

The collective eigenvalue is `exp(−Nγh)` and all differential eigenvalues are
1. Consequently, this coupling operation is contractive: it can transfer
motion to a previously unstruck string without creating modal energy. The
coupling strength is a calibration value. An eight-sample update approximates
the slowly varying unison envelopes while the oscillators run every sample.
This proof applies to the coupling operation in normalized coordinates, not
to every empirically calibrated part of the complete synth.

Whole unison groups retain their modes until the group's existing cutoff.
The operation also runs in dense chords. Voice retirement and selection of
the existing inter-note bridge path now happen per sample; audio and pedal
movement no longer depend on render-block boundaries. The older inter-note
bridge approximation still switches off above four active voices. A full
bridge/soundboard mobility matrix remains outside this reduction.

## MIDI and verification

The importer now preserves continuous **CC67** as `unaCorda` independently of
CC64, including ordering and channel aggregation. Soft-pedal events cannot
change sustain cleanup. The controller assignments are described by the
[MIDI Association Piano Profile](https://midi.org/midi-association-and-amei-release-the-piano-profile-and-implementation-guide).

Reproduce checks with:

```sh
npm test
npm run wasm:check
npm run verify:pedals
node tools/compare-reference-fidelity.mjs --quick --no-fail
node tools/compare-reference-fidelity.mjs --no-fail
```

The numerical reference test uses a C compiler (`cc`) to independently
integrate a power-law collision with RK4. It compares contact duration and
impulse ratios against the production reduction and checks the coupling's
energy inequality. Realtime tests check exact mechanical step responses at
32/44.1/48/96 kHz, reversals, silence, reset, dense chords, block partitioning,
damper contact timing, re-pedaling, unchanged held tones, cleared contacts,
passive-string response, and MIDI routing.

[pedal-validation.json](pedal-validation.json) records the 88-key × five-velocity
normal/soft sweep, sampled motion trajectories, and timing measurements.
All 93 tests and the embedded-Wasm reproducibility check pass. The 440 paired
normal/soft cases remain finite and within the output limit; the largest
20–250 ms soft-pedal level increase is 0.988 dB (MIDI 107, velocity 1). This
is a regression bound, not a measured acoustic target. At 48 kHz on the
development machine, eight-note onset blocks take 2.02 ms median against a
2.67 ms quantum; a simultaneous 32-note onset takes 4.54 ms and exceeds it.
Sustained 32-note rendering takes 0.80 ms median and 1.28 ms p95.

Normal-strike recording fidelity is compared separately. Across all 480
reference cases, the pre-change score is 95.03/100 and the revised score is
95.00/100. Both fail the same strict transient, spectral, decay, and register/
velocity gates, so neither score proves indistinguishability from a real
piano. There are no matched measured una-corda recordings in the current
calibration set. The equations and invariants have been verified;
specific-player feel and instrument-specific pedal regulation remain tunable.
