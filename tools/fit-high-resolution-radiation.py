#!/usr/bin/env python3
"""Fit a smooth high-resolution radiation surface from exact recordings."""

import json
from pathlib import Path

import numpy as np
from scipy.optimize import least_squares


ROOT = Path(__file__).resolve().parents[1]
REFERENCE = json.loads((ROOT / "reports/reference-fidelity-features.json").read_text())
SYNTHESIZED = json.loads((ROOT / "reports/synth-fidelity-features.json").read_text())
REFERENCE_BY_FILE = {entry["file"]: entry["features"] for entry in REFERENCE["entries"]}
SAMPLE_RATE = 44100
EDGES = np.array([20, 40, 63, 100, 160, 250, 400, 630, 1000, 1600,
                  2500, 4000, 6300, 10000, 16000])
CENTERS = np.sqrt(EDGES[:-1] * EDGES[1:])
CROSSOVERS = EDGES[1:-1]


def active_frames(features):
    noise = features["noiseRms"]
    return [20 * np.log10(max(value, np.finfo(float).tiny) / noise) >= 8
            for value in features["sustainRawRms"]]


def corrected_profile(profile_db, correction_db):
    power = 10 ** (np.asarray(profile_db) / 10) * 10 ** (np.asarray(correction_db) / 10)
    normalized = power / max(power.sum(), np.finfo(float).tiny)
    return np.maximum(-72, 10 * np.log10(np.maximum(normalized, np.finfo(float).tiny)))


def profile_rows(reference, synthesized, kind):
    if kind == "sustain":
        enabled = active_frames(reference)
        reference_profiles = reference["sustainProfiles"]
        synthesized_profiles = synthesized["sustainProfiles"]
    else:
        enabled = [True] * 5
        reference_profiles = reference["transientProfiles"]
        synthesized_profiles = synthesized["transientProfiles"]
    rows = []
    for frame, active in enumerate(enabled):
        if not active:
            continue
        ref = np.asarray(reference_profiles[frame])
        synth = np.asarray(synthesized_profiles[frame])
        mask = np.maximum(ref, synth) >= -58
        rows.append((ref, synth, mask))
    return rows


SAMPLES = []
for entry in SYNTHESIZED["entries"]:
    reference = REFERENCE_BY_FILE.get(entry["file"])
    if reference is not None:
        SAMPLES.append((entry, reference, entry["features"]))


def ideal_correction(reference, synthesized):
    sustain = profile_rows(reference, synthesized, "sustain")
    transient = profile_rows(reference, synthesized, "transient")

    def residual(correction):
        values = []
        for rows, weight in ((sustain, 1.15), (transient, 1.0)):
            for ref, synth, mask in rows:
                values.extend(weight * (corrected_profile(synth, correction) - ref)[mask])
        values.extend(.4 * np.diff(correction, 2))
        values.append(2 * correction.mean())
        return np.asarray(values)

    return least_squares(
        residual, np.zeros(14), bounds=(-24, 24), loss="soft_l1",
        f_scale=3, max_nfev=70,
    ).x


print(f"fitting {len(SAMPLES)} exact-recording corrections", flush=True)
IDEAL = np.vstack([ideal_correction(reference, synthesized)
                   for _entry, reference, synthesized in SAMPLES])


def chebyshev(value, degree):
    result = [np.ones_like(value), value]
    for _ in range(2, degree + 1):
        result.append(2 * value * result[-1] - result[-2])
    return result[:degree + 1]


def surface_design(pitch_degree, velocity_degree):
    x = np.array([(entry["midi"] - 64.5) / 43.5 for entry, *_ in SAMPLES])
    y = np.array([2 * entry["velocity"] - 1 for entry, *_ in SAMPLES])
    tx = chebyshev(x, pitch_degree)
    ty = chebyshev(y, velocity_degree)
    return np.column_stack([tx[i] * ty[j]
                            for i in range(pitch_degree + 1)
                            for j in range(velocity_degree + 1)])


def fit_surfaces(pitch_degree, velocity_degree, ridge):
    design = surface_design(pitch_degree, velocity_degree)
    degree_penalty = np.array([
        1 + .2 * i ** 3 + .35 * j ** 3
        for i in range(pitch_degree + 1)
        for j in range(velocity_degree + 1)
    ])
    normal = design.T @ design + ridge * np.diag(degree_penalty)
    return np.column_stack([
        np.linalg.solve(normal, design.T @ IDEAL[:, band])
        for band in range(14)
    ])


def lowpass_response(frequencies, cutoff):
    step = 1 - np.exp(-2 * np.pi * cutoff / SAMPLE_RATE)
    pole = 1 - step
    omega = 2 * np.pi * np.asarray(frequencies) / SAMPLE_RATE
    return step / (1 - pole * np.exp(-1j * omega))


def band_responses(frequencies):
    lowpasses = np.asarray([lowpass_response(frequencies, cutoff) for cutoff in CROSSOVERS])
    return np.vstack((lowpasses[0], np.diff(lowpasses, axis=0), 1 - lowpasses[-1])).T


AUDITORY_RESPONSE = band_responses(CENTERS)


def causal_correction(entry, gains_db):
    gains = 10 ** (np.clip(gains_db, -24, 24) / 20)
    response = np.abs(AUDITORY_RESPONSE @ gains)
    fundamental = 440 * 2 ** ((entry["midi"] - 69) / 12)
    normalization = abs(band_responses(np.array([fundamental]))[0] @ gains)
    return 20 * np.log10(np.maximum(response / normalization, np.finfo(float).tiny))


def sample_metric(reference, synthesized, correction, kind):
    values = []
    for ref, synth, _mask in profile_rows(reference, synthesized, kind):
        corrected = corrected_profile(synth, correction)
        mask = np.maximum(ref, corrected) >= -58
        values.append(np.mean(np.abs(corrected[mask] - ref[mask])))
    return np.mean(values)


def distribution(coefficients, pitch_degree, velocity_degree, causal):
    design = surface_design(pitch_degree, velocity_degree)
    result = {"sustain": [], "transient": [], "quick_sustain": [], "quick_transient": []}
    for row, (entry, reference, synthesized) in enumerate(SAMPLES):
        gains = design[row] @ coefficients
        correction = causal_correction(entry, gains) if causal else gains
        for kind in ("sustain", "transient"):
            value = sample_metric(reference, synthesized, correction, kind)
            result[kind].append(value)
            if entry["layer"] in (1, 6, 11, 16):
                result[f"quick_{kind}"].append(value)
    return result


def summarize(values):
    return np.median(values), np.percentile(values, 90)


best = None
for pitch_degree, velocity_degree in ((4, 2), (6, 3), (8, 4), (10, 5), (12, 6), (14, 7)):
    for ridge in (.01, .1, 1):
        coefficients = fit_surfaces(pitch_degree, velocity_degree, ridge)
        direct = distribution(coefficients, pitch_degree, velocity_degree, False)
        causal = distribution(coefficients, pitch_degree, velocity_degree, True)
        objective = sum(summarize(causal[kind])[0] + summarize(causal[kind])[1]
                        for kind in ("sustain", "transient"))
        print(
            f"p{pitch_degree} v{velocity_degree} ridge={ridge:g} terms={coefficients.size}: "
            f"direct S {summarize(direct['sustain'])[0]:.3f}/{summarize(direct['sustain'])[1]:.3f} "
            f"T {summarize(direct['transient'])[0]:.3f}/{summarize(direct['transient'])[1]:.3f}; "
            f"causal S {summarize(causal['sustain'])[0]:.3f}/{summarize(causal['sustain'])[1]:.3f} "
            f"T {summarize(causal['transient'])[0]:.3f}/{summarize(causal['transient'])[1]:.3f}; "
            f"quick S {summarize(causal['quick_sustain'])[0]:.3f}/{summarize(causal['quick_sustain'])[1]:.3f} "
            f"T {summarize(causal['quick_transient'])[0]:.3f}/{summarize(causal['quick_transient'])[1]:.3f}",
            flush=True,
        )
        if best is None or objective < best[0]:
            best = (objective, pitch_degree, velocity_degree, ridge, coefficients)

_, pitch_degree, velocity_degree, ridge, coefficients = best
design = surface_design(pitch_degree, velocity_degree)
u, singular, vt = np.linalg.svd(coefficients, full_matrices=False)
best_compressed = None
for rank in (2, 3, 4, 5, 6, 8, 10):
    spatial = u[:, :rank] * singular[:rank]
    spectral = vt[:rank].T
    reconstructed = spatial @ spectral.T
    direct = distribution(reconstructed, pitch_degree, velocity_degree, False)
    objective = sum(summarize(direct[kind])[0] + summarize(direct[kind])[1]
                    for kind in ("sustain", "transient"))
    print(
        f"compressed rank={rank} cubic-band terms={spatial.size + spectral.size}: "
        f"direct S {summarize(direct['sustain'])[0]:.3f}/{summarize(direct['sustain'])[1]:.3f} "
        f"T {summarize(direct['transient'])[0]:.3f}/{summarize(direct['transient'])[1]:.3f}; "
        f"quick S {summarize(direct['quick_sustain'])[0]:.3f}/{summarize(direct['quick_sustain'])[1]:.3f} "
        f"T {summarize(direct['quick_transient'])[0]:.3f}/{summarize(direct['quick_transient'])[1]:.3f}",
        flush=True,
    )
    if best_compressed is None or objective < best_compressed[0]:
        best_compressed = (objective, rank, spatial, spectral)

_, rank, spatial, spectral = best_compressed
np.savez_compressed(
    ROOT / "reports/high-resolution-radiation-fit.npz",
    spatial=spatial,
    spectral=spectral,
    pitch_degree=pitch_degree,
    velocity_degree=velocity_degree,
    rank=rank,
    ridge=ridge,
)
print(
    f"best p{pitch_degree} v{velocity_degree} ridge={ridge:g}, rank={rank}; "
    "saved reports/high-resolution-radiation-fit.npz",
    flush=True,
)
