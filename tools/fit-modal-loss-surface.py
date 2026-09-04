#!/usr/bin/env python3
"""Fit a continuous excess-loss surface from direct-recording partial decays."""

import json
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
REFERENCE = json.loads((ROOT / "reports/reference-fidelity-features.json").read_text())
SYNTHESIZED = json.loads((ROOT / "reports/synth-fidelity-features.json").read_text())
REFERENCE_BY_FILE = {entry["file"]: entry["features"] for entry in REFERENCE["entries"]}
TIMES = np.array([.025, .08, .18, .4, .8, 1.35, 2.05])


def clipped_db_power(value, floor=-90):
    return max(floor, 10 * np.log10(max(value, np.finfo(float).tiny)))


def basis(midi, velocity, partial, total_degree):
    x = (midi - 64.5) / 43.5
    y = 2 * velocity - 1
    z = np.log2(partial) / 4
    return np.array([
        x ** i * y ** j * z ** k
        for k in range(4)
        for i in range(5)
        for j in range(3)
        if i + j + k <= total_degree
    ])


def reliable_count(reference):
    return max(1, min(
        len(reference["partialPowers"][0]),
        reference.get("inharmonicMaximumStrongPartial",
                      reference.get("inharmonicStrongPartials", 1)),
    ))


def fit(total_degree):
    design = []
    target = []
    for entry in SYNTHESIZED["entries"]:
        reference = REFERENCE_BY_FILE.get(entry["file"])
        if reference is None:
            continue
        synthesized = entry["features"]
        reference_anchor = np.array(reference["partialPowers"][1])
        synthesized_anchor = np.array(synthesized["partialPowers"][1])
        strongest_reference = max(reference_anchor.max(), np.finfo(float).tiny)
        for column in range(reliable_count(reference)):
            if clipped_db_power(reference_anchor[column] / strongest_reference, -72) < -45:
                continue
            partial_basis = basis(entry["midi"], entry["velocity"], column + 1, total_degree)
            for frame in range(2, len(TIMES)):
                reference_change = clipped_db_power(
                    reference["partialPowers"][frame][column] /
                    max(reference_anchor[column], np.finfo(float).tiny)
                )
                synthesized_change = clipped_db_power(
                    synthesized["partialPowers"][frame][column] /
                    max(synthesized_anchor[column], np.finfo(float).tiny)
                )
                elapsed = TIMES[frame] - TIMES[1]
                # corrected residual = current residual - added_loss * elapsed
                design.append(partial_basis * elapsed)
                target.append(synthesized_change - reference_change)
    design = np.vstack(design)
    target = np.array(target)
    weights = np.ones(len(target))
    coefficients = np.zeros(design.shape[1])
    for _ in range(12):
        weighted_design = design * np.sqrt(weights[:, None])
        weighted_target = target * np.sqrt(weights)
        coefficients = np.linalg.solve(
            weighted_design.T @ weighted_design + .02 * np.eye(design.shape[1]),
            weighted_design.T @ weighted_target,
        )
        residual = design @ coefficients - target
        scale = max(.5, 1.4826 * np.median(np.abs(residual - np.median(residual))))
        weights = np.minimum(1, 2.5 * scale / np.maximum(np.abs(residual), 1e-12))
    return coefficients


def sample_metric(reference, synthesized, correction, entry):
    reference_anchor = np.array(reference["partialPowers"][1])
    synthesized_anchor = np.array(synthesized["partialPowers"][1])
    strongest_reference = max(reference_anchor.max(), np.finfo(float).tiny)
    values = []
    for column in range(reliable_count(reference)):
        if clipped_db_power(reference_anchor[column] / strongest_reference, -72) < -45:
            continue
        loss = correction(entry["midi"], entry["velocity"], column + 1)
        for frame in range(2, len(TIMES)):
            reference_change = clipped_db_power(
                reference["partialPowers"][frame][column] /
                max(reference_anchor[column], np.finfo(float).tiny)
            )
            synthesized_change = clipped_db_power(
                synthesized["partialPowers"][frame][column] /
                max(synthesized_anchor[column], np.finfo(float).tiny)
            )
            corrected_change = synthesized_change - loss * (TIMES[frame] - TIMES[1])
            values.append(abs(corrected_change - reference_change))
    return np.mean(values)


def distribution(total_degree, coefficients):
    baseline = []
    corrected = []
    quick_baseline = []
    quick_corrected = []
    zero = lambda _midi, _velocity, _partial: 0
    fitted = lambda midi, velocity, partial: basis(
        midi, velocity, partial, total_degree,
    ) @ coefficients
    for entry in SYNTHESIZED["entries"]:
        reference = REFERENCE_BY_FILE.get(entry["file"])
        if reference is None:
            continue
        synthesized = entry["features"]
        before = sample_metric(reference, synthesized, zero, entry)
        after = sample_metric(reference, synthesized, fitted, entry)
        baseline.append(before)
        corrected.append(after)
        if entry["layer"] in (1, 6, 11, 16):
            quick_baseline.append(before)
            quick_corrected.append(after)
    return (
        np.median(baseline), np.percentile(baseline, 90),
        np.median(corrected), np.percentile(corrected, 90),
        np.median(quick_corrected), np.percentile(quick_corrected, 90),
    )


for degree in (2, 3, 4):
    fitted_coefficients = fit(degree)
    result = distribution(degree, fitted_coefficients)
    print(
        f"degree {degree}, {len(fitted_coefficients)} terms: "
        "baseline %.3f / %.3f, corrected %.3f / %.3f, quick %.3f / %.3f" % result
    )
    if degree == 3:
        print("degree 3 coefficients:")
        for value in fitted_coefficients:
            print(f"{value:.12g},")
