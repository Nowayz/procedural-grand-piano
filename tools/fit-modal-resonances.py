#!/usr/bin/env python3
"""Fit smooth soundboard-mobility lobes to direct-recording partial residuals."""

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


def reliable_count(reference):
    return max(1, min(
        len(reference["partialPowers"][0]),
        reference.get("inharmonicMaximumStrongPartial",
                      reference.get("inharmonicStrongPartials", 1)),
    ))


def partial_frequency(entry, features, partial):
    fundamental = features.get("expectedHz") or 440 * 2 ** ((entry["midi"] - 69) / 12)
    stiffness = (np.exp(-.07643470205 * entry["midi"] - 6.682289773) +
                 np.exp(.07965147182 * entry["midi"] - 12.91563584))
    return partial * fundamental * np.sqrt(
        (1 + stiffness * partial * partial) / (1 + stiffness)
    )


def make_basis(count, interactions):
    centers = np.linspace(0, np.log2(16000 / 27.5), count)
    spacing = centers[1] - centers[0]
    width = .8 * spacing

    def evaluate(entry, features, partial):
        coordinate = np.log2(partial_frequency(entry, features, partial) / 27.5)
        lobes = np.exp(-.5 * ((coordinate - centers) / width) ** 2)
        values = [lobes]
        x = (entry["midi"] - 64.5) / 43.5
        y = 2 * entry["velocity"] - 1
        if interactions >= 1:
            values.append(x * lobes)
        if interactions >= 2:
            values.append(y * lobes)
        if interactions >= 3:
            values.append(x * y * lobes)
        return np.concatenate(values)

    return evaluate, centers, width


def fit_and_measure(count, interactions):
    evaluate, centers, width = make_basis(count, interactions)
    design_rows = []
    target_rows = []
    sample_rows = []
    for sample_id, entry in enumerate(SYNTHESIZED["entries"]):
        reference = REFERENCE_BY_FILE.get(entry["file"])
        if reference is None:
            continue
        synthesized = entry["features"]
        reliable = reliable_count(reference)
        for frame, enabled in enumerate(active_frames(reference)):
            if not enabled:
                continue
            row_design = []
            row_target = []
            for column in range(reliable):
                reference_db = reference["partialProfiles"][frame][column]
                synthesized_db = synthesized["partialProfiles"][frame][column]
                if max(reference_db, synthesized_db) < -60:
                    continue
                row_design.append(evaluate(entry, synthesized, column + 1))
                row_target.append(reference_db - synthesized_db)
            if not row_design:
                continue
            row_design = np.vstack(row_design)
            row_target = np.array(row_target)
            design_rows.append(row_design - row_design.mean(axis=0))
            target_rows.append(row_target - row_target.mean())
            sample_rows.append(sample_id)
    design = np.vstack(design_rows)
    target = np.concatenate(target_rows)
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
        scale = max(1, 1.4826 * np.median(np.abs(residual - np.median(residual))))
        weights = np.minimum(1, 2.5 * scale / np.maximum(np.abs(residual), 1e-12))

    baseline = []
    corrected = []
    quick_corrected = []
    for entry in SYNTHESIZED["entries"]:
        reference = REFERENCE_BY_FILE.get(entry["file"])
        if reference is None:
            continue
        synthesized = entry["features"]
        reliable = reliable_count(reference)
        before_frames = []
        after_frames = []
        for frame, enabled in enumerate(active_frames(reference)):
            if not enabled:
                continue
            reference_profile = np.array(reference["partialProfiles"][frame][:reliable])
            synthesized_profile = np.array(synthesized["partialProfiles"][frame][:reliable])
            powers = np.array(synthesized["partialPowers"][frame][:reliable])
            correction = np.array([
                evaluate(entry, synthesized, partial) @ coefficients
                for partial in range(1, reliable + 1)
            ])
            corrected_powers = powers * 10 ** (correction / 10)
            corrected_profile = np.maximum(-72, 10 * np.log10(
                np.maximum(corrected_powers, np.finfo(float).tiny) /
                max(corrected_powers.sum(), np.finfo(float).tiny)
            ))
            baseline_mask = np.maximum(reference_profile, synthesized_profile) >= -60
            corrected_mask = np.maximum(reference_profile, corrected_profile) >= -60
            before_frames.append(np.mean(np.abs(
                reference_profile[baseline_mask] - synthesized_profile[baseline_mask]
            )))
            after_frames.append(np.mean(np.abs(
                reference_profile[corrected_mask] - corrected_profile[corrected_mask]
            )))
        baseline.append(np.mean(before_frames))
        corrected.append(np.mean(after_frames))
        if entry["layer"] in (1, 6, 11, 16):
            quick_corrected.append(np.mean(after_frames))
    return (
        np.median(baseline), np.percentile(baseline, 90),
        np.median(corrected), np.percentile(corrected, 90),
        np.median(quick_corrected), np.percentile(quick_corrected, 90),
        coefficients, centers, width,
    )


for count, interactions in ((8, 0), (12, 0), (18, 0), (24, 0), (12, 1), (18, 1), (12, 2), (12, 3)):
    result = fit_and_measure(count, interactions)
    print(
        f"{count:2} lobes, interactions {interactions}, {len(result[6]):2} terms: "
        "baseline %.3f / %.3f, corrected %.3f / %.3f, quick %.3f / %.3f" % result[:6]
    )
    if (count, interactions) == (18, 1):
        print(f"centers={result[7].tolist()}")
        print(f"width={result[8]}")
        print(f"coefficients={result[6].tolist()}")
