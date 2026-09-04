# Realtime rendering performance

Measured 2026-09-04 on an AMD Ryzen 9 9950X3D with Node.js 25.9.0. Piece timings are uncontended, single-process synthesis measurements at 44.1 kHz. The baseline is the pulled `7d37351` implementation before the optimizations in this worktree.

## Results

| Piece | Audio | Peak voices | Baseline | Optimized | Synthesis reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| Bach BWV 846 | 157.07 s | 11 | 17.86 s / 8.8x | 7.58 s / 20.7x | 58% |
| Moonlight I | 279.00 s | 10 | 34.42 s / 8.1x | 21.73 s / 12.8x | 37% |
| Moonlight II | 182.00 s | 10 | 13.72 s / 13.3x | 8.30 s / 21.9x | 40% |
| Moonlight III | 804.71 s | 14 | 109.54 s / 7.3x | 57.46 s / 14.0x | 48% |
| Liszt Hungarian Rhapsody No. 2 | 543.65 s | 60 | 352.62 s / 1.5x | 54.15 s / 10.04x | 85% |

The six short demos produced 24.08 seconds of audio in 1.14 seconds of total wall time. Bumblebee produced 71.51 seconds in 5.81 seconds total, and the three-piece Lemmings set produced 264.97 seconds in 25.07 seconds total. Those totals include file generation and post-processing, so they are not directly comparable with the synthesis-only piece timings above.

Liszt is the deliberate pathological case: rapid same-pitch restrikes under sustain saturated all 256 configured event voices in the baseline even though a grand piano has only one physical resonator per key. Successive strikes now inject fresh hammer energy into the existing key's modal state and transfer note-event ownership without duplicating its strings. The corrected render peaks at 60 physical-key voices, does not truncate a voice, and now clears 10x realtime. All ordinary test pieces also exceed 10x realtime.

## Profile findings

The separated baseline profile attributes about 13.9 seconds, or 73% of synthesis time, to the free-running string-mode bank. Impact modes account for about 0.82 seconds, soundboard filters 0.63 seconds, and stochastic filter chains 0.33 seconds. Convolution is outside the synthesizer and costs about 1.08 seconds for Bach.

In the comparable Bach CPU profiles, the main per-voice Wasm frame fell from 16.75 seconds to 11.46 seconds. Total profiled runtime fell from 20.32 seconds to 13.42 seconds. The retained profile artifacts are:

- `bach-cpu-profile.cpuprofile`: pulled-revision baseline
- `bach-components-separated.cpuprofile`: instrumented component attribution
- `bach-final.cpuprofile`: final optimized implementation

## Optimizations

- Added common fast paths for undamped string modes with unity gains, including a settled-bridge path that omits work after the physical attack ramp has converged.
- Kept every modeled string partial, while limiting shared bridge feedback to the 4.3 kHz bandwidth represented by the soundboard model.
- Replaced near-linear `tanh` calls with a ninth-order series whose branch error is below 1.1e-12.
- Precomputed per-voice hammer gains, acoustic retirement thresholds, and fixed sample counts.
- Iterated only the prefix of the voice pool that has actually been claimed. This preserves the configured 256-voice capacity without scanning 241–246 never-used slots on ordinary music.
- Retired every acoustically inaudible voice, regardless of key or pedal state, and trimmed inactive trailing slots from the realtime scan range.
- Reused the existing physical-key voice on restrike, retaining its string, soundboard, and bridge state while injecting the new hammer excitation; stale note-off events for prior strikes cannot damp the newly owned voice.
- Corrected modal retirement to use each fast, slow, and polarization component's own amplitude and decay pole. Impact-plate components now retire independently at the same -120 dB model floor instead of being advanced throughout an unrelated long string tail.
- Transposed the ten soundboard quadrature filters for two-lane SIMD and vectorized the radiation and output-EQ filter banks without reducing their order.
- Rendered dense polyphony voice-major so each modal bank stays cache-resident. Sparse passages retain the sample-accurate shared bridge; dense passages omit individually inaudible bridge feedback and trim only modes already near the masked hearing floor.
- Forced the small modal update kernels inline under the size-optimized compiler, restoring hot-loop performance without exceeding the package budget.
- Enabled Binaryen code folding and similar-function merging.

## Verification

- Full test suite: 82/82 passing.
- Rebuilt Wasm exactly matches the embedded module: 57,232 bytes.
- Runtime source remains within the 101,000-byte raw and 45,000-byte gzip budgets.
- The final reference rerun produced 96/100 core validation, 100/100 full reference grid, 95.10/100 strict quick fidelity, and 95.03/100 strict full fidelity across all 480 directly recorded cells. No pitch-shifted reference audio is used.
