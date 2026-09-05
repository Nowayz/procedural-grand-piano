# River Flows in You — replacement convolution IR

The render loads the shared **Boston Hall A** asset from
`src/impulse-responses/bricasti-m7-boston-hall-a.wav`, prepared from Samplicity's Bricasti M7 impulse-response
archive, version 2023-10, downloaded from the
[publisher's downloads page](https://samplicity.com/downloads/).
This is a capture of the M7 hardware preset, not a recording of Boston Symphony Hall.

The original left-input and right-input stereo files are 44.1 kHz, float32 WAVs.
For a centered mono source, the preparation script averages the corresponding output
channels from the two input responses. This preserves the four-path capture's
response to equal input signals. It then uses the existing stereo convolution
engine with a 0.28 parallel wet send and retains the complete 3.896-second IR.
The approximate decay extrapolated from the −5 to −25 dB energy interval of
the left-input mono sum is 2.10 seconds (a numerical T20 estimate).

All original timing, velocities, and articulation remain unchanged. Mastering
uses constant gain to a −1.5 dBFS sample peak. Source paths and hashes are saved
in `source.json` and `../render-report.json`.

Samplicity's page offers this standalone archive free for use in convolution
reverbs. The audio captures remain Samplicity's material; no open-source license
is claimed for them. The prepared response is now the project's bundled default;
see `src/impulse-responses/bricasti-m7-boston-hall-a.NOTICE.md` for attribution.
The existing Small Hall versions are preserved as
`../river-flows-in-you-small-hall.wav` and `.mp3`.

The prepared IR is included in the repository. With the performance MIDI at
`scores/river-flows-in-you/river-flows-in-you.mid` (its source is recorded in
`../render-report.json`), run from the project root:

```sh
node demos/river-flows-in-you/render.mjs
ffmpeg -y -i demos/river-flows-in-you/river-flows-in-you.wav -codec:a libmp3lame -b:a 256k demos/river-flows-in-you/river-flows-in-you.mp3
```
