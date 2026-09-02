#!/usr/bin/env python3
"""Conservative blind dereverberation for BiVib binaural piano samples.

Uses multichannel Weighted Prediction Error (WPE).  The guard interval keeps
the direct attack out of the prediction filter; --mix permits partial removal
when full WPE sounds too dry or shortens the piano's physical decay.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import soundfile as sf
from nara_wpe.utils import istft, stft
from nara_wpe.wpe import wpe_v8
from scipy.signal import correlate, correlation_lags


def rms(signal: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(signal), dtype=np.float64)))


def db(value: float) -> float:
    return 20.0 * np.log10(max(value, 1e-12))


def window_rms(signal: np.ndarray, sample_rate: int, start: float, end: float) -> float:
    lo = min(signal.shape[0], max(0, round(start * sample_rate)))
    hi = min(signal.shape[0], max(lo + 1, round(end * sample_rate)))
    return rms(signal[lo:hi])


def align_reference(
    reference: np.ndarray,
    target: np.ndarray,
    sample_rate: int,
    max_lag_ms: float = 100.0,
) -> tuple[np.ndarray, int]:
    """Align a separately recorded strike using its smoothed attack envelope."""
    analysis_samples = min(reference.shape[0], target.shape[0], round(0.6 * sample_rate))
    smoothing = max(1, round(0.005 * sample_rate))
    decimation = max(1, sample_rate // 2000)

    def envelope(signal: np.ndarray) -> np.ndarray:
        mono = np.mean(signal[:analysis_samples], axis=1)
        power = np.convolve(mono * mono, np.ones(smoothing) / smoothing, mode="same")
        return np.sqrt(np.maximum(power, 0.0))[::decimation]

    reference_envelope = envelope(reference)
    target_envelope = envelope(target)
    values = correlate(reference_envelope, target_envelope, mode="full", method="fft")
    lags = correlation_lags(len(reference_envelope), len(target_envelope), mode="full")
    max_lag = round(max_lag_ms * sample_rate / (1000.0 * decimation))
    valid = np.abs(lags) <= max_lag
    lag = int(lags[valid][np.argmax(values[valid])] * decimation)

    aligned = np.zeros((target.shape[0], reference.shape[1]), dtype=reference.dtype)
    if lag >= 0:
        count = min(target.shape[0], reference.shape[0] - lag)
        if count > 0:
            aligned[:count] = reference[lag : lag + count]
    else:
        offset = -lag
        count = min(target.shape[0] - offset, reference.shape[0])
        if count > 0:
            aligned[offset : offset + count] = reference[:count]
    return aligned, lag


def dereverb(
    audio: np.ndarray,
    sample_rate: int,
    fft_size: int,
    hop: int,
    delay_ms: float,
    taps: int,
    iterations: int,
    mix: float,
    training_audio: list[np.ndarray] | None = None,
    training_seconds: float = 3.0,
    output_channels: int | None = None,
) -> tuple[np.ndarray, int]:
    if audio.ndim != 2 or audio.shape[1] < 2:
        raise ValueError("WPE requires a stereo or multichannel input")

    delay_frames = max(1, round(delay_ms * sample_rate / (1000.0 * hop)))
    # nara_wpe STFT layout is channels x frames x frequencies.
    target_spectrum = stft(audio.T, size=fft_size, shift=hop, axis=-1)
    target_frames = target_spectrum.shape[1]
    spectra: list[np.ndarray] = []
    guard_frames = delay_frames + taps
    if training_audio:
        max_samples = round(training_seconds * sample_rate)
        for training in training_audio:
            training = training[:max_samples]
            training_spectrum = stft(training.T, size=fft_size, shift=hop, axis=-1)
            spectra.append(training_spectrum)
            spectra.append(
                np.zeros(
                    (audio.shape[1], guard_frames, training_spectrum.shape[2]),
                    dtype=training_spectrum.dtype,
                )
            )
    target_start = sum(part.shape[1] for part in spectra)
    spectra.append(target_spectrum)
    combined_spectrum = np.concatenate(spectra, axis=1)
    wpe_input = combined_spectrum.transpose(2, 0, 1)
    estimated = wpe_v8(
        wpe_input,
        taps=taps,
        delay=delay_frames,
        iterations=iterations,
        statistics_mode="full",
    )
    restored_spectrum = estimated.transpose(1, 2, 0)[
        :, target_start : target_start + target_frames, :
    ]
    dry = istft(restored_spectrum, size=fft_size, shift=hop).T
    dry = dry[: audio.shape[0]]
    if dry.shape[0] < audio.shape[0]:
        dry = np.pad(dry, ((0, audio.shape[0] - dry.shape[0]), (0, 0)))

    output_channels = output_channels or audio.shape[1]
    original_output = audio[:, :output_channels]
    dry = dry[:, :output_channels]
    output = original_output + mix * (dry - original_output)
    peak = float(np.max(np.abs(output)))
    if peak > 0.999:
        output *= 0.999 / peak
    return output, delay_frames


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--fft-size", type=int, default=4096)
    parser.add_argument("--hop", type=int, default=1024)
    parser.add_argument("--delay-ms", type=float, default=85.0)
    parser.add_argument("--taps", type=int, default=24)
    parser.add_argument("--iterations", type=int, default=3)
    parser.add_argument("--mix", type=float, default=0.7)
    parser.add_argument(
        "--reverb-output",
        type=Path,
        help="Optional WAV containing the component removed from the target",
    )
    parser.add_argument(
        "--train-glob",
        help="Glob of additional recordings used to estimate one shared predictor",
    )
    parser.add_argument("--max-training-files", type=int, default=8)
    parser.add_argument("--training-seconds", type=float, default=3.0)
    parser.add_argument(
        "--reference",
        action="append",
        type=Path,
        default=[],
        help="Additional separately recorded channels of the same note; may be repeated",
    )
    args = parser.parse_args()

    audio, sample_rate = sf.read(args.input, always_2d=True, dtype="float64")
    training_audio: list[np.ndarray] = []
    training_paths: list[Path] = []
    if args.train_glob:
        import glob

        candidates = [Path(path) for path in sorted(glob.glob(args.train_glob))]
        candidates = [path for path in candidates if path.resolve() != args.input.resolve()]
        if len(candidates) > args.max_training_files:
            indexes = np.linspace(
                0, len(candidates) - 1, args.max_training_files, dtype=int
            )
            candidates = [candidates[index] for index in indexes]
        for path in candidates:
            training, training_rate = sf.read(path, always_2d=True, dtype="float64")
            if training_rate != sample_rate or training.shape[1] != audio.shape[1]:
                raise ValueError(f"Incompatible training file: {path}")
            training_audio.append(training)
            training_paths.append(path)

    reference_audio: list[np.ndarray] = []
    reference_lags: list[tuple[Path, int]] = []
    for path in args.reference:
        reference, reference_rate = sf.read(path, always_2d=True, dtype="float64")
        if reference_rate != sample_rate:
            raise ValueError(f"Incompatible reference sample rate: {path}")
        aligned, lag = align_reference(reference, audio, sample_rate)
        reference_audio.append(aligned)
        reference_lags.append((path, lag))
    wpe_audio = np.concatenate([audio, *reference_audio], axis=1)

    if training_audio and wpe_audio.shape[1] != training_audio[0].shape[1]:
        raise ValueError("--train-glob cannot currently be combined with --reference")

    output, delay_frames = dereverb(
        wpe_audio,
        sample_rate,
        args.fft_size,
        args.hop,
        args.delay_ms,
        args.taps,
        args.iterations,
        args.mix,
        training_audio,
        args.training_seconds,
        output_channels=audio.shape[1],
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(args.output, output, sample_rate, subtype="PCM_24")
    if args.reverb_output:
        args.reverb_output.parent.mkdir(parents=True, exist_ok=True)
        residual = audio - output
        sf.write(args.reverb_output, residual, sample_rate, subtype="PCM_24")

    duration = audio.shape[0] / sample_rate
    late_start = min(4.0, duration * 0.4)
    late_end = min(8.0, duration * 0.8)
    early_in = window_rms(audio, sample_rate, 0.0, min(0.5, duration))
    early_out = window_rms(output, sample_rate, 0.0, min(0.5, duration))
    late_in = window_rms(audio, sample_rate, late_start, late_end)
    late_out = window_rms(output, sample_rate, late_start, late_end)
    print(f"input:  {args.input}")
    print(f"output: {args.output}")
    if args.reverb_output:
        print(f"removed component: {args.reverb_output}")
    print(f"WPE delay: {delay_frames} frames ({delay_frames * args.hop / sample_rate * 1000:.1f} ms)")
    print(f"shared training recordings: {len(training_paths)}")
    for path, lag in reference_lags:
        print(f"aligned reference: {path.name}, shift {-lag / sample_rate * 1000:+.1f} ms")
    print(f"early RMS change: {db(early_out / early_in):+.2f} dB")
    print(f"late RMS change:  {db(late_out / late_in):+.2f} dB")
    print(f"output peak: {db(float(np.max(np.abs(output)))):.2f} dBFS")


if __name__ == "__main__":
    main()
