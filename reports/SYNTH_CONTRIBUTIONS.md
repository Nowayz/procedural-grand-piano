# C synth equation contribution audit

The audit identified and removed two terms from `tools/grand-piano-wasm.c`:

1. **Soundboard bandpass b1 term.** Its coefficient was assigned zero in every
   filter. Multiplication by the delayed input therefore always produced zero.
   Removed that multiplication, addition, coefficient initialization, and one
   ten-double coefficient row (80 bytes).
2. **Radiation polynomial constant.** Every runtime use subtracts the response
   at the fundamental from the response at another frequency. The degree-zero
   term cancels algebraically. Initialization now starts at degree one, avoiding
   ten products and accumulations per strike. The full calibration header stays
   available to the independent calibration-fit checks; the synth no longer
   reconstructs its constant term.

The embedded release Wasm was rebuilt: 60,142 → 60,109 bytes. This is a small,
evidence-based simplification; most of the model really does affect the output.

## Evidence

The [original audit](synth-contributions-before-pruning/summary.md) used 763
logging probes and 378 independently disabled terms, including every coefficient
in the named fitted arrays, all 65 reconstructed spectral coefficients, and
all ten radiation latent components. It found 376 terms with an output witness
above the conservative threshold, one cancelling constant, and one exactly zero
filter term. See [machine-readable measurements](synth-contributions-before-pruning/audit.json)
and [internal logs](synth-contributions-before-pruning/trace.jsonl).

With all switches enabled, the debug build matched the original build **exactly**
across 400 scenarios. Removing the radiation constant alone produced at most
1.49e-8 peak PCM difference (−156.54 dBFS). Removing b1 produced zero difference.

After removing both, an independent comparison of the saved original Wasm and
the newly embedded release covered **709 scenarios and 91,659,372 channel
samples**. Peak difference was **2.98e-8 (−150.51 dBFS)**; the largest 20 ms
difference RMS was **−180.34 dBFS**. These are floating-point rounding changes,
consistent with removing an algebraically cancelling term. The aggregate
deterministic waveform hash was updated only after this comparison; its
representative individual waveform hashes did not change. Full measurements
and source/binary hashes are in [synth-pruning.json](synth-pruning.json).

The [current audit](synth-contributions/summary.md) is generated from the pruned
source. Its degree-zero probe is expected to be unexercised because that work
has been removed. An unexercised switch is not evidence for deleting a branch.

## What the measurements mean

Each experiment starts from reset state, changes one term to its additive zero
or multiplicative identity, and compares final float PCM at the same gain. A
peak difference of at least 1e-5 (−100 dBFS) retains a component immediately.
This matches the amplitude threshold already used by the synth. Quiet
candidates must finish the complete scenario sweep, followed by source-level
dependency review. The tool never deletes code automatically.

This establishes causal output contribution, not a human listening verdict.
Playback volume and masking can make a nonzero difference inaudible. We retain
uncertain terms and remove only the two with an algebraic reason for silence,
supported by output measurements. Do not interpret the witness table as a
ranking: testing stops at the first significant witness for retained terms.
For quiet candidates, it records the largest peak difference across the sweep.

The 400-case suite covers all 88 keys at 1/127, .125, .5, and 1 velocity;
additional register/string-count/damper boundaries; sparse and dense chords;
same-key restrikes; full, half, and repedaling; una corda; key motion; a 12-second
tail; and 32, 44.1, 48, and 96 kHz realtime output. Offline audio is compared in
mono; realtime comparisons inspect mono, left, and right. The removal check adds
the 264 waveform-oracle cases, 44 eight-second register/rate cases, and a
30-second held bass note.

For example, duplex resonance contributes in a sparse chord even though it is
silent in isolated offline notes. Its first witness is −63.32 dBFS. Removing it
based only on solo-note logs would have discarded a functioning interaction.

## Running and extending the debug copy

```sh
npm run synth:debug
npm run synth:audit
# Shorter development sweep (never sufficient by itself for pruning):
npm run synth:audit -- --quick
# Reuse an existing build; fails if any source hash changed:
npm run synth:audit -- --reuse-build
```

Emscripten must be available on PATH, or set `EMSDK` to its installation root.
With `EMSDK`, the builder invokes `emcc.py` using `PYTHON` or `python`.

`build/synth-debug/` contains the generated C and copied instrumented headers,
DWARF-enabled `debug.wasm`, uninstrumented `baseline.wasm`, and `manifest.json`.
The release source has no debug branches, callbacks, or logging allocations.
Generation instruments scalar initializers and double-return values; explicit
probes cover coefficient banks, the principal mixing stages, and the original
SIMD zero term. Vector arithmetic is also exercised through final-output
comparisons. This is component-level instrumentation, not an enumeration of
every individual arithmetic operator or a proof over continuous inputs.

The manifest maps each probe to a named component, source file, original
expression, and neutral value. Automatically scanned probes also have line
numbers. `reports/synth-contributions/trace.jsonl` contains per-scenario count,
minimum, maximum, RMS, last value, mean, and nonfinite count. Logging aggregates
inside C and is exported after rendering, avoiding millions of console lines.
Initializers that are later accumulated have their final values exposed by
return or coefficient probes; an initializer's zero value alone proves nothing.

The debug Wasm exports `debug_logging(enabled)`, `debug_stats_ptr()`,
`debug_disable(id)`, `debug_clear()`, and `debug_hits(id)`. Logging reset clears
statistics; clear resets all ablations and hit counts. Multiple disable calls
allow combined experiments. Scalar statistics occupy seven doubles per probe
in the order listed above, with sum-of-squares in place of RMS and sum in place
of mean; the JS writer computes RMS and mean. A switch with zero hits is
reported as `not-exercised`. Nonfinite output fails validation.

For selected terms, the audit writes float WAV baseline, disabled, and residual
files at their original gain. Realtime WAVs contain the actual stereo channels.
The residual is not boosted or peak-normalized. The audit JSON contains source
hashes, each neutral choice, scenarios tested, and final-output differences.

To verify a future removal, preserve the original `baseline.wasm`, rebuild the
release with `npm run wasm:build`, then run:

```sh
node tools/verify-synth-pruning.mjs path/to/saved-original.wasm
```

The verifier requires a maximum 1e-7 final-sample difference, substantially
stricter than the screening threshold. Both report commands overwrite their
current reports; this change's original evidence is archived separately under
`synth-contributions-before-pruning/`.
