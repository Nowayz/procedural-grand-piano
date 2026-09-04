#!/usr/bin/env python3
"""Merge successive smooth radiation residual fits into one low-rank surface."""

import argparse
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--residual-scale", type=float, required=True)
parser.add_argument("--rank", type=int, default=10)
args = parser.parse_args()


def expanded_coefficients(path, pitch_degree=14, velocity_degree=7):
    data = np.load(path)
    source_pitch = int(data["pitch_degree"])
    source_velocity = int(data["velocity_degree"])
    source = data["spatial"] @ data["spectral"].T
    expanded = np.zeros(((pitch_degree + 1) * (velocity_degree + 1), source.shape[1]))
    for pitch in range(source_pitch + 1):
        for velocity in range(source_velocity + 1):
            source_index = pitch * (source_velocity + 1) + velocity
            target_index = pitch * (velocity_degree + 1) + velocity
            expanded[target_index] = source[source_index]
    return expanded


first = expanded_coefficients(ROOT / "reports/high-resolution-radiation-fit-pass1.npz")
second = expanded_coefficients(ROOT / "reports/high-resolution-radiation-fit-pass2.npz")
combined = first + args.residual_scale * second
u, singular, vt = np.linalg.svd(combined, full_matrices=False)
rank = min(args.rank, len(singular))
spatial = u[:, :rank] * singular[:rank]
spectral = vt[:rank].T
np.savez_compressed(
    ROOT / "reports/high-resolution-radiation-fit.npz",
    spatial=spatial,
    spectral=spectral,
    pitch_degree=14,
    velocity_degree=7,
    rank=rank,
    residual_scale=args.residual_scale,
)
relative_error = np.linalg.norm(combined - spatial @ spectral.T) / np.linalg.norm(combined)
print(
    f"combined residual scale={args.residual_scale:g}, rank={rank}, "
    f"coefficient relative error={relative_error:.5f}"
)
