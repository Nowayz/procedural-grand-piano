#!/usr/bin/env python3
"""Fit one smooth string-drive surface to all direct reference recordings.

The fit uses only relative partial levels, so note loudness is a nuisance
variable rather than a per-note calibration.  Every runtime term contains
log2(partial), keeping the correction continuous and anchored at the
fundamental.
"""

import json
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
REFERENCE = json.loads((ROOT / "reports/reference-fidelity-features.json").read_text())
SYNTHESIZED = json.loads((ROOT / "reports/synth-fidelity-features.json").read_text())
REFERENCE_BY_FILE = {entry["file"]: entry["features"] for entry in REFERENCE["entries"]}


def active_frames(features):
    noise = features["noiseRms"]
    if noise <= 0:
        return [True] * len(features["sustainRawRms"])
    return [20 * np.log10(max(value, np.finfo(float).tiny) / noise) >= 8
            for value in features["sustainRawRms"]]


def basis(midi, velocity, partial):
    x = (midi - 64.5) / 43.5
    y = 2 * velocity - 1
    z = np.log2(partial) / 4
    # Low total degree limits the surface to broad, physical trends.  Since
    # k starts at one, the drive correction is exactly zero at partial one.
    return np.array([
        x ** i * y ** j * z ** k
        for k in range(1, 5)
        for i in range(5)
        for j in range(4)
        if i + j + k <= 5
    ])


observations = []
row_ids = []
metadata = []
row_id = 0
for entry in SYNTHESIZED["entries"]:
    reference = REFERENCE_BY_FILE.get(entry["file"])
    if reference is None:
        continue
    synthesized = entry["features"]
    reliable = max(1, min(
        len(reference["partialPowers"][0]),
        reference.get("inharmonicMaximumStrongPartial",
                      reference.get("inharmonicStrongPartials", 1)),
    ))
    for frame, is_active in enumerate(active_frames(reference)):
        if not is_active:
            continue
        row_start = len(observations)
        for column in range(reliable):
            reference_db = reference["partialProfiles"][frame][column]
            synthesized_db = synthesized["partialProfiles"][frame][column]
            if max(reference_db, synthesized_db) < -60:
                continue
            partial = column + 1
            observations.append((
                basis(entry["midi"], entry["velocity"], partial),
                reference_db - synthesized_db,
            ))
            row_ids.append(row_id)
            metadata.append((entry, reference, synthesized, frame, column))
        if len(observations) > row_start:
            row_id += 1


design = np.vstack([value[0] for value in observations])
target = np.array([value[1] for value in observations])
row_ids = np.array(row_ids)

# Eliminate the arbitrary normalization offset independently in every spectral
# frame.  That prevents the fit from becoming a disguised loudness surface.
for current_row in range(row_id):
    indices = row_ids == current_row
    design[indices] -= design[indices].mean(axis=0)
    target[indices] -= target[indices].mean()

# Robust iteratively reweighted ridge regression.  Large local resonances remain
# residuals instead of pulling a continuous surface toward a sampled key.
weights = np.ones(len(target))
coefficients = np.zeros(design.shape[1])
regularization = 1e-3
for _ in range(12):
    weighted_design = design * np.sqrt(weights[:, None])
    weighted_target = target * np.sqrt(weights)
    coefficients = np.linalg.solve(
        weighted_design.T @ weighted_design + regularization * np.eye(design.shape[1]),
        weighted_design.T @ weighted_target,
    )
    residual = design @ coefficients - target
    scale = max(1, 1.4826 * np.median(np.abs(residual - np.median(residual))))
    weights = np.minimum(1, 2.5 * scale / np.maximum(np.abs(residual), 1e-12))


def profile_mae(reference, synthesized, threshold=-60):
    mask = np.maximum(reference, synthesized) >= threshold
    return np.mean(np.abs(reference[mask] - synthesized[mask])) if mask.any() else 0


baseline = []
corrected = []
quick_baseline = []
quick_corrected = []
for entry in SYNTHESIZED["entries"]:
    reference = REFERENCE_BY_FILE.get(entry["file"])
    if reference is None:
        continue
    synthesized = entry["features"]
    reliable = max(1, min(
        len(reference["partialPowers"][0]),
        reference.get("inharmonicMaximumStrongPartial",
                      reference.get("inharmonicStrongPartials", 1)),
    ))
    sample_baseline = []
    sample_corrected = []
    for frame, is_active in enumerate(active_frames(reference)):
        if not is_active:
            continue
        reference_profile = np.array(reference["partialProfiles"][frame][:reliable])
        synthesized_powers = np.array(synthesized["partialPowers"][frame][:reliable])
        corrections = np.array([
            basis(entry["midi"], entry["velocity"], partial) @ coefficients
            for partial in range(1, reliable + 1)
        ])
        corrected_powers = synthesized_powers * 10 ** (corrections / 10)
        corrected_profile = np.maximum(
            -72,
            10 * np.log10(np.maximum(corrected_powers, np.finfo(float).tiny) /
                          max(corrected_powers.sum(), np.finfo(float).tiny)),
        )
        synthesized_profile = np.array(synthesized["partialProfiles"][frame][:reliable])
        sample_baseline.append(profile_mae(reference_profile, synthesized_profile))
        sample_corrected.append(profile_mae(reference_profile, corrected_profile))
    baseline.append(np.mean(sample_baseline))
    corrected.append(np.mean(sample_corrected))
    if entry["layer"] in (1, 6, 11, 16):
        quick_baseline.append(np.mean(sample_baseline))
        quick_corrected.append(np.mean(sample_corrected))


def distribution(label, values):
    print(f"{label:18} median={np.median(values):6.3f} p90={np.percentile(values, 90):6.3f}")


print(f"Observations: {len(target)}, normalized frames: {row_id}, coefficients: {len(coefficients)}")
distribution("full baseline", baseline)
distribution("full corrected", corrected)
distribution("quick baseline", quick_baseline)
distribution("quick corrected", quick_corrected)
print("\nTerms are ordered by k=1..4, i=0..4, j=0..3 with i+j+k<=5:")
for coefficient in coefficients:
    print(f"{coefficient:.12g},")
