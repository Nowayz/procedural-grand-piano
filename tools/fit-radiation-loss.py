#!/usr/bin/env python3
"""Fit smooth four-band excess radiation loss from direct recordings only."""

import json
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
REFERENCE = json.loads((ROOT / "reports/reference-fidelity-features.json").read_text())
SYNTHESIZED = json.loads((ROOT / "reports/synth-fidelity-features.json").read_text())
REFERENCE_BY_FILE = {entry["file"]: entry["features"] for entry in REFERENCE["entries"]}
TIMES = np.array([.025, .08, .18, .4, .8, 1.35, 2.05])
ANCHOR = 1
SAMPLE_RATE = 44100
BAND_EDGES = np.array(
    [20, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000]
)
BAND_CENTERS = np.sqrt(BAND_EDGES[:-1] * BAND_EDGES[1:])
CROSSOVERS = (250, 900, 2500)


def lowpass_response(frequencies, cutoff):
    step = 1 - np.exp(-2 * np.pi * cutoff / SAMPLE_RATE)
    pole = 1 - step
    omega = 2 * np.pi * np.asarray(frequencies) / SAMPLE_RATE
    return step / (1 - pole * np.exp(-1j * omega))


def band_responses(frequencies):
    low, center, high = [lowpass_response(frequencies, cutoff) for cutoff in CROSSOVERS]
    return np.vstack((low, center - low, high - center, 1 - high)).T


def loss_weights(frequencies):
    # The four causal bands sum to one.  This is the first-order dB response
    # to a slowly changing gain on each band at unity static gain.
    return np.real(band_responses(np.asarray(frequencies)))


def clipped_db_power(value, floor=-90):
    return max(floor, 10 * np.log10(max(value, np.finfo(float).tiny)))


def clipped_db_amplitude(value, floor=-90):
    return max(floor, 20 * np.log10(max(value, np.finfo(float).tiny)))


def chebyshev(value, degree):
    result = [1, value]
    for _ in range(2, degree + 1):
        result.append(2 * value * result[-1] - result[-2])
    return result[:degree + 1]


def surface_basis(entry, degree):
    x = chebyshev((entry["midi"] - 64.5) / 43.5, degree)
    y = chebyshev(2 * entry["velocity"] - 1, degree)
    return np.array([
        x[i] * y[j]
        for i in range(degree + 1)
        for j in range(degree + 1 - i)
    ])


def reliable_partial_count(features):
    return max(1, min(
        len(features["partialPowers"][0]),
        features.get("inharmonicMaximumStrongPartial",
                     features.get("inharmonicStrongPartials", 1)),
    ))


def partial_frequencies(features, count):
    fundamental = features.get("fundamentalHz") or features.get("expectedHz")
    stiffness = max(0, features.get("inharmonicity") or 0)
    partials = np.arange(1, count + 1)
    return fundamental * partials * np.sqrt(
        (1 + stiffness * partials * partials) / (1 + stiffness)
    )


def decay_observations(entry, reference, synthesized, degree):
    basis = surface_basis(entry, degree)
    observations = []

    reference_anchor = np.asarray(reference["sustainBandPowers"][ANCHOR])
    synthesized_anchor = np.asarray(synthesized["sustainBandPowers"][ANCHOR])
    strongest = max(reference_anchor.max(), np.finfo(float).tiny)
    weights = loss_weights(BAND_CENTERS)
    active_bands = []
    for band in range(len(BAND_CENTERS)):
        if clipped_db_power(reference_anchor[band] / strongest) < -50:
            continue
        active_bands.append(band)
        for frame in range(ANCHOR + 1, len(TIMES)):
            elapsed = TIMES[frame] - TIMES[ANCHOR]
            reference_change = clipped_db_power(
                reference["sustainBandPowers"][frame][band] / reference_anchor[band]
            )
            synthesized_change = clipped_db_power(
                synthesized["sustainBandPowers"][frame][band] /
                max(synthesized_anchor[band], np.finfo(float).tiny)
            )
            observations.append((np.kron(weights[band], basis) * elapsed,
                                 synthesized_change - reference_change, 1.0))

    count = reliable_partial_count(reference)
    reference_anchor = np.asarray(reference["partialPowers"][ANCHOR])[:count]
    synthesized_anchor = np.asarray(synthesized["partialPowers"][ANCHOR])[:count]
    strongest = max(reference_anchor.max(), np.finfo(float).tiny)
    frequencies = partial_frequencies(synthesized, count)
    weights = loss_weights(frequencies)
    for partial in range(count):
        if clipped_db_power(reference_anchor[partial] / strongest) < -50:
            continue
        for frame in range(ANCHOR + 1, len(TIMES)):
            elapsed = TIMES[frame] - TIMES[ANCHOR]
            reference_change = clipped_db_power(
                reference["partialPowers"][frame][partial] / reference_anchor[partial]
            )
            synthesized_change = clipped_db_power(
                synthesized["partialPowers"][frame][partial] /
                max(synthesized_anchor[partial], np.finfo(float).tiny)
            )
            observations.append((np.kron(weights[partial], basis) * elapsed,
                                 synthesized_change - reference_change, .7))

    # An energy-weighted first-order response approximates broadband loss.
    anchor_power = np.asarray(synthesized["sustainBandPowers"][ANCHOR])
    anchor_power /= max(anchor_power.sum(), np.finfo(float).tiny)
    broadband_weights = anchor_power @ loss_weights(BAND_CENTERS)
    for frame in range(ANCHOR + 1, len(TIMES)):
        elapsed = TIMES[frame] - TIMES[ANCHOR]
        reference_change = clipped_db_amplitude(
            reference["sustainRms"][frame] / reference["sustainRms"][ANCHOR]
        )
        synthesized_change = clipped_db_amplitude(
            synthesized["sustainRms"][frame] / synthesized["sustainRms"][ANCHOR]
        )
        observations.append((np.kron(broadband_weights, basis) * elapsed,
                             synthesized_change - reference_change, .6))
    return observations


SAMPLES = [
    (entry, REFERENCE_BY_FILE[entry["file"]], entry["features"])
    for entry in SYNTHESIZED["entries"]
    if entry["file"] in REFERENCE_BY_FILE
]


def fit(degree, ridge):
    observations = [item for sample in SAMPLES for item in decay_observations(*sample, degree)]
    design = np.vstack([item[0] for item in observations])
    target = np.array([item[1] for item in observations])
    base_weights = np.array([item[2] for item in observations])
    weights = base_weights.copy()
    coefficients = np.zeros(design.shape[1])
    penalty = ridge * np.eye(design.shape[1])
    for _ in range(12):
        weighted_design = design * np.sqrt(weights[:, None])
        weighted_target = target * np.sqrt(weights)
        coefficients = np.linalg.solve(
            weighted_design.T @ weighted_design + penalty,
            weighted_design.T @ weighted_target,
        )
        residual = design @ coefficients - target
        scale = max(.5, 1.4826 * np.median(np.abs(residual - np.median(residual))))
        weights = base_weights * np.minimum(1, 2.5 * scale / np.maximum(np.abs(residual), 1e-12))
    return coefficients


def loss_at(entry, frequencies, degree, coefficients):
    terms = len(surface_basis(entry, degree))
    surfaces = coefficients.reshape(4, terms)
    values = surfaces @ surface_basis(entry, degree)
    return loss_weights(np.asarray(frequencies)) @ values


def decay_metric(reference_powers, synthesized_powers, losses, threshold=-50, maximum=None):
    reference_anchor = np.asarray(reference_powers[ANCHOR])
    synthesized_anchor = np.asarray(synthesized_powers[ANCHOR])
    columns = len(reference_anchor) if maximum is None else min(len(reference_anchor), maximum)
    strongest = max(reference_anchor.max(), np.finfo(float).tiny)
    values = []
    for column in range(columns):
        if clipped_db_power(reference_anchor[column] / strongest) < threshold:
            continue
        for frame in range(ANCHOR + 1, len(TIMES)):
            reference_change = clipped_db_power(
                reference_powers[frame][column] / reference_anchor[column]
            )
            synthesized_change = clipped_db_power(
                synthesized_powers[frame][column] /
                max(synthesized_anchor[column], np.finfo(float).tiny)
            )
            corrected = synthesized_change - losses[column] * (TIMES[frame] - TIMES[ANCHOR])
            values.append(abs(reference_change - corrected))
    return np.mean(values)


def broadband_metric(reference, synthesized, effective_loss):
    values = []
    for frame in range(ANCHOR + 1, len(TIMES)):
        reference_change = clipped_db_amplitude(
            reference[frame] / reference[ANCHOR]
        )
        synthesized_change = clipped_db_amplitude(
            synthesized[frame] / synthesized[ANCHOR]
        )
        corrected = synthesized_change - effective_loss * (TIMES[frame] - TIMES[ANCHOR])
        values.append(abs(reference_change - corrected))
    return np.mean(values)


def distribution(degree, coefficients):
    before = [[], [], []]
    after = [[], [], []]
    quick_after = [[], [], []]
    for entry, reference, synthesized in SAMPLES:
        band_losses = loss_at(entry, BAND_CENTERS, degree, coefficients)
        count = reliable_partial_count(reference)
        partial_losses = loss_at(
            entry, partial_frequencies(synthesized, count), degree, coefficients,
        )
        anchor_power = np.asarray(synthesized["sustainBandPowers"][ANCHOR])
        anchor_power /= max(anchor_power.sum(), np.finfo(float).tiny)
        effective_loss = anchor_power @ band_losses
        metrics_before = (
            decay_metric(reference["sustainBandPowers"], synthesized["sustainBandPowers"],
                         np.zeros(len(BAND_CENTERS))),
            decay_metric(reference["partialPowers"], synthesized["partialPowers"],
                         np.zeros(count), maximum=count),
            broadband_metric(reference["sustainRms"], synthesized["sustainRms"], 0),
        )
        metrics_after = (
            decay_metric(reference["sustainBandPowers"], synthesized["sustainBandPowers"],
                         band_losses),
            decay_metric(reference["partialPowers"], synthesized["partialPowers"],
                         partial_losses, maximum=count),
            broadband_metric(reference["sustainRms"], synthesized["sustainRms"], effective_loss),
        )
        for index in range(3):
            before[index].append(metrics_before[index])
            after[index].append(metrics_after[index])
            if entry["layer"] in (1, 6, 11, 16):
                quick_after[index].append(metrics_after[index])
    return before, after, quick_after


best = None
for degree in (1, 2, 3, 4):
    for ridge in (.1, 1, 10):
        coefficients = fit(degree, ridge)
        before, after, quick = distribution(degree, coefficients)
        summary = []
        for values in after:
            summary.extend((np.median(values), np.percentile(values, 90)))
        objective = sum(summary)
        print(f"degree={degree} terms={len(coefficients)} ridge={ridge:g} objective={objective:.3f}")
        for label, baseline, corrected, quick_values in zip(
                ("multiband", "partial", "broadband"), before, after, quick):
            print(
                f"  {label:10s} {np.median(baseline):.3f}/{np.percentile(baseline, 90):.3f}"
                f" -> {np.median(corrected):.3f}/{np.percentile(corrected, 90):.3f}"
                f" quick {np.median(quick_values):.3f}/{np.percentile(quick_values, 90):.3f}"
            )
        if best is None or objective < best[0]:
            best = (objective, degree, ridge, coefficients)

_, degree, ridge, coefficients = best
terms = len(surface_basis(SAMPLES[0][0], degree))
print(f"\nbest degree={degree}, ridge={ridge:g}, {terms} coefficients per band")
for band, values in enumerate(coefficients.reshape(4, terms)):
    print(f"band {band} loss-dB/s surface, total-degree Chebyshev x/y:")
    for value in values:
        print(f"{value:.12g},")
