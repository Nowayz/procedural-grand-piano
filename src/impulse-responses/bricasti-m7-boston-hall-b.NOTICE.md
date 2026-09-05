# Bricasti M7 Boston Hall B impulse response

Captured by **Samplicity**, free Bricasti M7 IR archive, version 2023-10.
[Publisher and download](https://samplicity.com/downloads/).

This is the M7 hardware preset capture, not a measurement of Boston Symphony Hall.
The publisher supplies the archive free of charge, as-is, for convolution reverbs.
The captures remain third-party material; the repository's code license does not
grant additional rights to them. No MIT or Creative Commons license is asserted.

The bundled stereo float32 WAV averages corresponding output channels from the
native 44.1 kHz left-input and right-input captures, exactly as for Boston Hall A.
It preserves the full recorded tail, without resampling, EQ, normalization,
added predelay, or trimming. For mono sources sent equally to both inputs this
retains all four captured paths up to a common gain factor. The two-channel
convolver does not implement four-channel true-stereo routing for independently
positioned stereo inputs.

The asset is optional; Boston Hall A remains the default. Source paths, hashes,
frame count, and duration are in `bricasti-m7-boston-hall-b.json`.

To reproduce from the original source pair:

```sh
npm run reverb:prepare -- --preset B "path/to/1 Halls 19 Boston Hall B, 44K L.wav" "path/to/1 Halls 19 Boston Hall B, 44K R.wav"
```
