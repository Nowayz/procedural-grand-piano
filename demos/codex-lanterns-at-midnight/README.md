# Lanterns at Midnight

An original Codex piano rhapsody, composed from scratch. Duration: 3:53 including the natural release and hall tail. No existing melodies or piano recordings were used.

The principal gesture leaps upward and slips down a semitone. It first calls into an empty square, becomes a three-beat lantern song, then a mischievous short-note dance. A quiet B-minor episode opens a new harmonic space before the storm gathers. The song returns transformed, and a D-major carnival accelerates into the final coda.

Eight sections: declamatory introduction; lyrical waltz; scherzando; shadowy 6/8 episode; agitated development; lyrical return; bright fast finale; emphatic coda. Tempo changes range from 43 to 172 quarter notes per minute. The performance uses shaped dynamics, detached dance articulation, rolled chords, octave melody reinforcement, changing registers, and phrase-specific pedal releases.

Reproduce from the repository root:

```powershell
node tools/generate-codex-rhapsody.mjs
node tools/master-codex-rhapsody.mjs
```

Requires Node.js and FFmpeg on PATH. The generator creates the original MIDI and renders it using this repository's procedural grand piano and the shared Boston Hall A reverb (currently a 28% parallel send). The mastering script applies constant gain and creates the final WAV and MP3, then decodes both completely and updates the report. It preserves the large dynamic range without compression.

Deliverables: `codex-lanterns-at-midnight.mp3` (192 kbps), `codex-lanterns-at-midnight.wav` (24-bit stereo PCM, 44.1 kHz), and `codex-lanterns-at-midnight.mid` (format 0, 480 PPQ). The WAV master derives from the renderer's 16-bit intermediate; the 24-bit container does not imply additional source precision.

Validation: 2,145 notes; all MIDI notes released; 28 maximum synthesis voices; zero clipped source frames; zero truncated voices; full reverb tail. Final WAV: -18.00 LUFS integrated, -5.64 dBTP, 9.1 LU loudness range. MP3: -18.27 LUFS, -5.88 dBTP. See `render-report.json` for machine-readable measurements. These are structural and audio-signal checks, not a claim of human listening review.
