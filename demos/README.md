# Procedural demonstrations

Run `npm run demos` to deterministically regenerate the WAV files in this
directory. Every sound is rendered by `synthesizeGrandPiano`; no reference
recording is copied, decoded, resampled, convolved, or mixed into these files.

Run `npm run track` to render the complete 35-measure **Prelude in C major,
BWV 846** by J. S. Bach as `bach-bwv846-prelude-procedural.wav`. This is a
stereo performance assembled entirely from procedural notes, deterministic
performance instructions, and delay-line room ambience. It contains no
recorded piano, sampled impulse response, or source-performance audio.

The notes were transcribed from the [Mutopia public-domain LilyPond edition
hosted by Wikisource](https://wikisource.org/wiki/Prelude_in_C_major,_BWV_846).
That page identifies the 1742 work as public domain worldwide, and its score
source marks the typesetting itself Public Domain. The score was cross-checked
against Wikimedia's [Open Well-Tempered Clavier CC0
edition](https://commons.wikimedia.org/wiki/File:Bach-_Well-Tempered_Clavier,_Book_1_-_01_Prelude_No._1_in_C_major,_BWV_846.pdf).

- `A1-soft.wav`: bass register, velocity 0.28
- `C4-medium.wav`: middle register, velocity 0.62
- `A6-hard.wav`: treble register, velocity 0.94
- `A6v16-procedural.wav`: A6 at the supplied SFZ layer-16 midpoint velocity
  (0.976378), rendered to the reference file's 6.833583-second duration for
  convenient A/B listening
- `C-major-chord.wav`: four overlapping synthesized voices
- `short-phrase.wav`: nine synthesized note events with overlap
