# Bricasti M7 Boston Hall A impulse response

Captured by **Samplicity**, free Bricasti M7 IR archive, version 2023-10.
[Publisher and download](https://samplicity.com/downloads/).

This is the M7 hardware preset capture, not a measurement of Boston Symphony Hall.
The publisher supplies the archive free of charge, as-is, for convolution reverbs.
The captures remain third-party material; the repository's code license does not
grant additional rights to them. No MIT or Creative Commons license is asserted.

The bundled stereo float32 WAV averages corresponding output channels from the
original left-input and right-input captures. For a mono piano sent equally to
both inputs, it retains all four captured paths up to one common gain factor.
For stereo sources, it provides the same two-channel response through the
existing independent-channel convolver. It is not a four-channel true-stereo
convolver for independently positioned stereo inputs.

Native sample rate: 44,100 Hz. Full duration: approximately 3.896 seconds.
No EQ, resampling, added predelay, normalization, or tail trimming is baked in.
The runtime applies its usual convolution normalization and a 0.28 parallel send.

Original archive paths, source hashes, and the prepared asset hash are recorded
in `bricasti-m7-boston-hall-a.json`. To reproduce from the downloaded source pair:

```sh
npm run reverb:prepare -- "path/to/1 Halls 18 Boston Hall A, 44K L.wav" "path/to/1 Halls 18 Boston Hall A, 44K R.wav"
```
