#!/usr/bin/env python3
"""Fit the one continuous pitch/velocity output-radiation surface."""

import json
import argparse
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
REFERENCE = json.loads((ROOT / "reports/reference-fidelity-features.json").read_text())
SYNTHESIZED = json.loads((ROOT / "reports/synth-fidelity-features.json").read_text())
REFERENCE_BY_FILE = {entry["file"]: entry["features"] for entry in REFERENCE["entries"]}

parser = argparse.ArgumentParser()
parser.add_argument("--pitch-degree", type=int, default=4)
parser.add_argument("--velocity-degree", type=int, default=3)
parser.add_argument("--regularization", type=float, default=.01)
args = parser.parse_args()


def chebyshev(value, degree):
    terms = [1, value]
    for _ in range(2, degree + 1):
        terms.append(2 * value * terms[-1] - terms[-2])
    return terms[:degree + 1]


def basis(midi, velocity):
    x_terms = chebyshev((midi - 64.5) / 43.5, args.pitch_degree)
    y_terms = chebyshev(2 * velocity - 1, args.velocity_degree)
    return np.array([
        x_terms[i] * y_terms[j]
        for i in range(args.pitch_degree + 1)
        for j in range(args.velocity_degree + 1)
    ])


rows = []
for entry in SYNTHESIZED["entries"]:
    reference = REFERENCE_BY_FILE.get(entry["file"])
    if reference is None:
        continue
    synthesized = entry["features"]
    rows.append((
        entry,
        basis(entry["midi"], entry["velocity"]),
        20 * np.log10(reference["earlyRms"] / synthesized["earlyRms"]),
    ))


def fit(selected):
    design = np.vstack([row[1] for row in selected])
    target = np.array([row[2] for row in selected])
    coefficients = np.zeros(design.shape[1])
    weights = np.ones(len(target))
    for _ in range(12):
        weighted_design = design * np.sqrt(weights[:, None])
        weighted_target = target * np.sqrt(weights)
        coefficients = np.linalg.solve(
            weighted_design.T @ weighted_design
            + args.regularization * np.eye(design.shape[1]),
            weighted_design.T @ weighted_target,
        )
        residual = design @ coefficients - target
        scale = max(.25, 1.4826 * np.median(np.abs(residual - np.median(residual))))
        weights = np.minimum(1, 2.5 * scale / np.maximum(np.abs(residual), 1e-12))
    return coefficients


def summarize(label, selected, coefficients):
    before = np.array([row[2] for row in selected])
    after = np.array([row[2] - row[1] @ coefficients for row in selected])
    before -= np.median(before)
    after -= np.median(after)
    print(
        f"{label}: median |residual| {np.median(np.abs(before)):.3f} -> "
        f"{np.median(np.abs(after)):.3f} dB; p90 "
        f"{np.percentile(np.abs(before), 90):.3f} -> "
        f"{np.percentile(np.abs(after), 90):.3f} dB"
    )


training = [row for row in rows if round((row[0]["midi"] - 21) / 3) % 2 == 0]
held_out = [row for row in rows if row not in training]
held_out_coefficients = fit(training)
coefficients = fit(rows)
summarize("held-out pitches", held_out, held_out_coefficients)
summarize("all direct recordings", rows, coefficients)
for file in ("A0v1.flac", "A0v16.flac", "C8v1.flac", "C8v16.flac"):
    entry, row_basis, target = next(row for row in rows if row[0]["file"] == file)
    print(f"{file}: requested {target:.3f} dB, smooth correction {row_basis @ coefficients:.3f} dB")
print("additive Chebyshev coefficients (x-major, y-minor):")
for value in coefficients:
    print(f"{value:.12g},")
