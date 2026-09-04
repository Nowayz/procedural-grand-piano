#!/usr/bin/env python3
"""Fit a causal four-band radiation transfer without per-note lookup data."""

import json
from pathlib import Path

import numpy as np
from scipy.optimize import least_squares


ROOT = Path(__file__).resolve().parents[1]
REFERENCE = json.loads((ROOT / "reports/reference-fidelity-features.json").read_text())
SYNTHESIZED = json.loads((ROOT / "reports/synth-fidelity-features.json").read_text())
REFERENCE_BY_FILE = {entry["file"]: entry["features"] for entry in REFERENCE["entries"]}
SAMPLE_RATE = 44100
BAND_CENTERS = np.sqrt(np.array(
    [20, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000]
) * np.array(
    [40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000]
))
CROSSOVERS = (250, 900, 2500)


def lowpass_response(frequencies, cutoff):
    step = 1 - np.exp(-2 * np.pi * cutoff / SAMPLE_RATE)
    pole = 1 - step
    omega = 2 * np.pi * frequencies / SAMPLE_RATE
    return step / (1 - pole * np.exp(-1j * omega))


def band_responses(frequencies):
    low, center, high = [lowpass_response(frequencies, cutoff) for cutoff in CROSSOVERS]
    return np.vstack((low, center - low, high - center, 1 - high)).T


AUDITORY_RESPONSES = band_responses(BAND_CENTERS)


def response_db(fundamental, gains_db):
    gains = 10 ** (np.array(gains_db) / 20)
    response = np.abs(AUDITORY_RESPONSES @ gains)
    fundamental_response = abs(band_responses(np.array([fundamental]))[0] @ gains)
    return 20 * np.log10(np.maximum(response / fundamental_response, np.finfo(float).tiny))


def apply_profile_response(profile_db, correction_db):
    """Filter a unit-power auditory profile and normalize it back to unit power."""
    power = 10 ** (np.asarray(profile_db) / 10) * 10 ** (np.asarray(correction_db) / 10)
    normalized = power / max(np.sum(power), np.finfo(float).tiny)
    return 10 * np.log10(np.maximum(normalized, 10 ** (-72 / 10)))


def active_frames(features):
    noise = features["noiseRms"]
    if noise <= 0:
        return [True] * len(features["sustainRawRms"])
    return [20 * np.log10(max(value, np.finfo(float).tiny) / noise) >= 8
            for value in features["sustainRawRms"]]


def profile_rows(reference, synthesized):
    rows = []
    for reference_profile, synthesized_profile in zip(
            reference["transientProfiles"], synthesized["transientProfiles"]):
        reference_profile = np.array(reference_profile)
        synthesized_profile = np.array(synthesized_profile)
        rows.append((reference_profile, synthesized_profile,
                     np.maximum(reference_profile, synthesized_profile) >= -58))
    for frame, enabled in enumerate(active_frames(reference)):
        if not enabled:
            continue
        reference_profile = np.array(reference["sustainProfiles"][frame])
        synthesized_profile = np.array(synthesized["sustainProfiles"][frame])
        rows.append((reference_profile, synthesized_profile,
                     np.maximum(reference_profile, synthesized_profile) >= -58))
    return rows


def ideal_gains(entry, reference, synthesized):
    rows = profile_rows(reference, synthesized)
    fundamental = 440 * 2 ** ((entry["midi"] - 69) / 12)

    def residual(parameters):
        gains = np.array((parameters[0], parameters[1], 0, parameters[2]))
        correction = response_db(fundamental, gains)
        values = []
        for reference_profile, synthesized_profile, mask in rows:
            corrected_profile = apply_profile_response(synthesized_profile, correction)
            values.extend((corrected_profile - reference_profile)[mask])
        return np.array(values)

    result = least_squares(
        residual, np.zeros(3), bounds=(-18, 18), loss="soft_l1", f_scale=3,
        max_nfev=80,
    )
    return np.array((result.x[0], result.x[1], 0, result.x[2]))


def chebyshev(value, degree):
    values = [1, value]
    for _ in range(2, degree + 1):
        values.append(2 * value * values[-1] - values[-2])
    return values[:degree + 1]


def surface_basis(entry):
    x = chebyshev((entry["midi"] - 64.5) / 43.5, 4)
    y = chebyshev(2 * entry["velocity"] - 1, 3)
    return np.array([x[i] * y[j] for i in range(5) for j in range(4)])


samples = []
for entry in SYNTHESIZED["entries"]:
    reference = REFERENCE_BY_FILE.get(entry["file"])
    if reference is None:
        continue
    synthesized = entry["features"]
    samples.append((entry, reference, synthesized, ideal_gains(entry, reference, synthesized)))

design = np.vstack([surface_basis(entry) for entry, *_ in samples])
surfaces = []
for band in (0, 1, 3):
    target = np.array([sample[3][band] for sample in samples])
    weights = np.ones(len(target))
    coefficients = np.zeros(design.shape[1])
    for _ in range(12):
        weighted_design = design * np.sqrt(weights[:, None])
        weighted_target = target * np.sqrt(weights)
        coefficients = np.linalg.solve(
            weighted_design.T @ weighted_design + .1 * np.eye(design.shape[1]),
            weighted_design.T @ weighted_target,
        )
        residual = design @ coefficients - target
        scale = max(.5, 1.4826 * np.median(np.abs(residual - np.median(residual))))
        weights = np.minimum(1, 2.5 * scale / np.maximum(np.abs(residual), 1e-12))
    surfaces.append(coefficients)


def profile_metric(reference, synthesized, correction, transient):
    matrices = [(reference["transientProfiles"], synthesized["transientProfiles"])] if transient else [
        (reference["sustainProfiles"], synthesized["sustainProfiles"]),
    ]
    enabled = [True] * 5 if transient else active_frames(reference)
    values = []
    for reference_matrix, synthesized_matrix in matrices:
        for frame, active in enumerate(enabled):
            if not active:
                continue
            reference_profile = np.array(reference_matrix[frame])
            synthesized_profile = np.array(synthesized_matrix[frame])
            corrected_profile = apply_profile_response(synthesized_profile, correction)
            mask = np.maximum(reference_profile, corrected_profile) >= -58
            values.append(np.mean(np.abs(reference_profile[mask] - corrected_profile[mask])))
    return np.mean(values)


baseline_transient = []
corrected_transient = []
baseline_sustain = []
corrected_sustain = []
for entry, reference, synthesized, _ideal in samples:
    basis = surface_basis(entry)
    gains = np.array((basis @ surfaces[0], basis @ surfaces[1], 0, basis @ surfaces[2]))
    correction = response_db(440 * 2 ** ((entry["midi"] - 69) / 12), gains)
    baseline_transient.append(profile_metric(reference, synthesized, np.zeros(14), True))
    corrected_transient.append(profile_metric(reference, synthesized, correction, True))
    baseline_sustain.append(profile_metric(reference, synthesized, np.zeros(14), False))
    corrected_sustain.append(profile_metric(reference, synthesized, correction, False))


def summarize(label, baseline, corrected):
    print(
        f"{label}: median {np.median(baseline):.3f}->{np.median(corrected):.3f}, "
        f"p90 {np.percentile(baseline, 90):.3f}->{np.percentile(corrected, 90):.3f}"
    )


summarize("transient", baseline_transient, corrected_transient)
summarize("sustain", baseline_sustain, corrected_sustain)
for label, coefficients in zip(("low", "center", "high"), surfaces):
    print(f"\n{label} gain-dB surface, x-major/y-minor:")
    for value in coefficients:
        print(f"{value:.12g},")
