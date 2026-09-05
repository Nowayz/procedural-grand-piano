#!/usr/bin/env python3
"""Audit the shipped global radiation fit against the legacy calibration.

Requires development-only NumPy/SciPy. npm test separately exercises the actual
C evaluators, string mass, felt curve, endpoint derivatives, and contact physics.
"""
import argparse
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
from numpy.polynomial.chebyshev import chebval, chebvander

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("radiation_export", ROOT / "tools/export-high-resolution-radiation.py")
fit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fit)


def smooth_limit(x, low, high, width):
    return low + width * (np.logaddexp(0, (x - low) / width) - np.logaddexp(0, (x - high) / width))


def audit():
    assert (ROOT / "tools/high-resolution-radiation-fit.h").read_text() == fit.header_text(), "Regenerate the radiation header"
    spatial, spectral, scales = fit.fitted_calibration()
    _, legacy = fit.legacy_calibration()
    midi = np.linspace(21, 108, 175)  # includes every key and half-semitones
    velocity = np.linspace(0, 1, 65)  # includes the unsounded mathematical endpoint
    # The whole audible range at every supported sample rate, including where
    # the old function clamped. Include each old knot and actual fundamentals.
    log_frequency = np.unique(np.r_[np.linspace(np.log2(20 / 27.5), np.log2(45600 / 27.5), 4097), fit.POSITIONS, (midi - 21) / 12])
    anchor = (midi - 21) / 12
    latent = np.einsum('pi,vj->pvij', chebvander((midi - 64.5) / 43.5, 14),
                       chebvander(2 * velocity - 1, 7)).reshape(len(midi), len(velocity), -1) @ spatial

    def basis_error(octave):
        x = (smooth_limit(octave, fit.POSITIONS[0], fit.POSITIONS[-1], fit.LIMIT_WIDTH) - fit.MID) / fit.HALF
        return chebval(x, spectral * scales).T - legacy(np.clip(octave, fit.POSITIONS[0], fit.POSITIONS[-1]))

    error = basis_error(log_frequency)
    anchor_error = basis_error(anchor)
    maximum = 0
    squared_sum = 0
    count = 0
    worst = None
    for pitch in range(len(midi)):
        # Radiation is applied after subtracting the same curve at the
        # fundamental; this anchored error is what actually changes the sound.
        actual = latent[pitch] @ error.T - (latent[pitch] @ anchor_error[pitch])[:, None]
        squared_sum += float(np.sum(actual ** 2))
        count += actual.size
        index = np.unravel_index(np.argmax(np.abs(actual)), actual.shape)
        peak = float(abs(actual[index]))
        if peak > maximum:
            maximum = peak
            worst = {"midi": float(midi[pitch]), "velocity": float(velocity[index[0]]),
                     "frequencyHz": float(27.5 * 2 ** log_frequency[index[1]])}
    rms = float(np.sqrt(squared_sum / count))
    assert maximum < .25, f"Radiation maximum error {maximum:g} dB exceeds .25 dB"
    assert rms < .025, f"Radiation RMS error {rms:g} dB exceeds .025 dB"
    return {
        "model": "global degree-64 Chebyshev polynomial in smoothly bounded log frequency",
        "baseline": "legacy quantized 14-band Hermite radiation model, reconstructed from the development NPZ",
        "calibrationPolicy": "4096 fit observations per latent component; legacy samples and interpolation are development-only",
        "frequencyRangeHz": [20, 45600], "pitchCount": len(midi), "velocityCount": len(velocity),
        "frequencyCount": len(log_frequency), "comparisons": count,
        "anchoredErrorDb": {"rms": rms, "maximum": maximum}, "worstCase": worst,
        "limitsDb": {"rms": .025, "maximum": .25},
        "quantizationIncluded": True, "endpointSmoothingIncluded": True, "passed": True,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write-report', action='store_true')
    args = parser.parse_args()
    report = audit()
    print(json.dumps(report, indent=2))
    if args.write_report:
        (ROOT / 'reports/continuous-radiation-fit.json').write_text(json.dumps(report, indent=2) + '\n')
