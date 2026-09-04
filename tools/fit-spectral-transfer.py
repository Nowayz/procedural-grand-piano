#!/usr/bin/env python3
"""Estimate the attainable benefit of a smooth, global radiation transfer."""

import json
from pathlib import Path

import numpy as np
from scipy.optimize import least_squares


ROOT = Path(__file__).resolve().parents[1]
REFERENCE = json.loads((ROOT / "reports/reference-fidelity-features.json").read_text())
SYNTHESIZED = json.loads((ROOT / "reports/synth-fidelity-features.json").read_text())
REFERENCE_BY_FILE = {entry["file"]: entry["features"] for entry in REFERENCE["entries"]}
BAND_CENTERS = np.sqrt(np.array(
    [20, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000]
) * np.array(
    [40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000]
))


def active_frames(features):
    noise = features["noiseRms"]
    if noise <= 0:
        return [True] * len(features["sustainRawRms"])
    return [20 * np.log10(max(value, np.finfo(float).tiny) / noise) >= 8
            for value in features["sustainRawRms"]]


def collect(kind):
    rows = []
    sample_ids = []
    quick_ids = set()
    sample_id = 0
    for entry in SYNTHESIZED["entries"]:
        reference = REFERENCE_BY_FILE.get(entry["file"])
        if reference is None:
            continue
        synthesized = entry["features"]
        if entry["layer"] in (1, 6, 11, 16):
            quick_ids.add(sample_id)
        if kind == "sustain":
            frame_mask = active_frames(reference)
            reference_profiles = reference["sustainProfiles"]
            synthesized_powers = synthesized["sustainBandPowers"]
        else:
            frame_mask = [True] * len(reference["transientProfiles"])
            reference_profiles = reference["transientProfiles"]
            # Profiles retain enough precision to reconstruct normalized power.
            synthesized_powers = [[10 ** (value / 10) for value in profile]
                                  for profile in synthesized["transientProfiles"]]
        for frame, enabled in enumerate(frame_mask):
            if not enabled:
                continue
            reference_profile = np.array(reference_profiles[frame])
            powers = np.array(synthesized_powers[frame])
            baseline = np.maximum(-72, 10 * np.log10(
                np.maximum(powers, np.finfo(float).tiny) /
                max(powers.sum(), np.finfo(float).tiny)
            ))
            mask = np.maximum(reference_profile, baseline) >= -58
            rows.append((reference_profile, powers, mask, entry["midi"], entry["velocity"]))
            sample_ids.append(sample_id)
        sample_id += 1
    return rows, np.array(sample_ids), quick_ids


def corrected_profile(powers, correction):
    corrected = powers * 10 ** (correction / 10)
    return np.maximum(-72, 10 * np.log10(
        np.maximum(corrected, np.finfo(float).tiny) /
        max(corrected.sum(), np.finfo(float).tiny)
    ))


def fit(rows):
    # A cubic B-spline-like smoothness prior is represented by penalizing the
    # second difference between adjacent log-frequency bands.
    def residual(correction):
        values = []
        for reference, powers, mask, _midi, _velocity in rows:
            values.extend((corrected_profile(powers, correction) - reference)[mask])
        values.extend(2 * np.diff(correction, 2))
        values.append(4 * correction.mean())
        return np.array(values)

    result = least_squares(
        residual,
        np.zeros(14),
        bounds=(-18, 18),
        loss="soft_l1",
        f_scale=3,
        max_nfev=80,
    )
    return result.x


def distribution(rows, sample_ids, quick_ids, correction):
    by_sample = {}
    for (reference, powers, mask, _midi, _velocity), sample_id in zip(rows, sample_ids):
        error = np.mean(np.abs(corrected_profile(powers, correction)[mask] - reference[mask]))
        by_sample.setdefault(sample_id, []).append(error)
    full = np.array([np.mean(values) for values in by_sample.values()])
    quick = np.array([np.mean(by_sample[index]) for index in sorted(quick_ids)])
    return np.median(full), np.percentile(full, 90), np.median(quick), np.percentile(quick, 90)


def ideal_per_sample_distribution(rows, sample_ids, quick_ids):
    by_sample_rows = {}
    for row, sample_id in zip(rows, sample_ids):
        by_sample_rows.setdefault(sample_id, []).append(row)
    results = {}
    for sample_id, sample_rows in by_sample_rows.items():
        def residual(correction):
            values = []
            for reference, powers, mask, _midi, _velocity in sample_rows:
                values.extend((corrected_profile(powers, correction) - reference)[mask])
            values.extend(.5 * np.diff(correction, 2))
            values.append(2 * correction.mean())
            return np.asarray(values)
        correction = least_squares(
            residual, np.zeros(14), bounds=(-24, 24), loss="soft_l1",
            f_scale=3, max_nfev=60,
        ).x
        errors = []
        for reference, powers, mask, _midi, _velocity in sample_rows:
            errors.append(np.mean(np.abs(corrected_profile(powers, correction)[mask] - reference[mask])))
        results[sample_id] = np.mean(errors)
    full = np.array(list(results.values()))
    quick = np.array([results[index] for index in sorted(quick_ids)])
    return np.median(full), np.percentile(full, 90), np.median(quick), np.percentile(quick, 90)


def chebyshev_values(value, degree):
    values = [np.ones_like(value), value]
    for _ in range(2, degree + 1):
        values.append(2 * value * values[-1] - values[-2])
    return values[:degree + 1]


SURFACE_TERMS = [
    (midi_degree, velocity_degree, frequency_degree)
    for frequency_degree in range(1, 7)
    for midi_degree in range(5)
    for velocity_degree in range(3)
    if midi_degree + velocity_degree + frequency_degree <= 6
]


def surface_basis(midi, velocity):
    x = (midi - 64.5) / 43.5
    y = 2 * velocity - 1
    # This is the same log-frequency coordinate used by bridge_mobility_db().
    frequency_x = .3141612258263221 * np.log(BAND_CENTERS / 27.5) - 1
    midi_terms = chebyshev_values(x, 4)
    velocity_terms = chebyshev_values(y, 2)
    frequency_terms = chebyshev_values(frequency_x, 6)
    return np.column_stack([
        midi_terms[i] * velocity_terms[j] * frequency_terms[k]
        for i, j, k in SURFACE_TERMS
    ])


def fit_surface(rows):
    design_rows = []
    targets = []
    for reference, powers, mask, midi, velocity in rows:
        synthesized = corrected_profile(powers, np.zeros(14))
        row_design = surface_basis(midi, velocity)[mask]
        row_target = (reference - synthesized)[mask]
        # Profile normalization makes a common dB offset unobservable.
        design_rows.append(row_design - row_design.mean(axis=0))
        targets.append(row_target - row_target.mean())
    design = np.vstack(design_rows)
    target = np.concatenate(targets)
    weights = np.ones(len(target))
    coefficients = np.zeros(len(SURFACE_TERMS))
    for _ in range(12):
        weighted_design = design * np.sqrt(weights[:, None])
        weighted_target = target * np.sqrt(weights)
        coefficients = np.linalg.solve(
            weighted_design.T @ weighted_design + .02 * np.eye(design.shape[1]),
            weighted_design.T @ weighted_target,
        )
        residual = design @ coefficients - target
        scale = max(1, 1.4826 * np.median(np.abs(residual - np.median(residual))))
        weights = np.minimum(1, 2.5 * scale / np.maximum(np.abs(residual), 1e-12))
    return coefficients


def surface_distribution(rows, sample_ids, quick_ids, coefficients):
    by_sample = {}
    for (reference, powers, mask, midi, velocity), sample_id in zip(rows, sample_ids):
        correction = surface_basis(midi, velocity) @ coefficients
        error = np.mean(np.abs(corrected_profile(powers, correction)[mask] - reference[mask]))
        by_sample.setdefault(sample_id, []).append(error)
    full = np.array([np.mean(values) for values in by_sample.values()])
    quick = np.array([np.mean(by_sample[index]) for index in sorted(quick_ids)])
    return np.median(full), np.percentile(full, 90), np.median(quick), np.percentile(quick, 90)


def causal_band_responses(frequencies):
    responses = []
    for cutoff in (63, 160, 400, 1000, 2500, 6300):
        step = 1 - np.exp(-2 * np.pi * cutoff / 44100)
        pole = 1 - step
        omega = 2 * np.pi * np.asarray(frequencies) / 44100
        responses.append(step / (1 - pole * np.exp(-1j * omega)))
    lowpasses = np.asarray(responses)
    return np.vstack((lowpasses[0], np.diff(lowpasses, axis=0), 1 - lowpasses[-1])).T


def causal_surface_distribution(rows, sample_ids, quick_ids, coefficients, scale):
    representatives = np.array([35, 100, 250, 630, 1600, 4000, 10000])
    auditory_responses = causal_band_responses(BAND_CENTERS)
    by_sample = {}
    for (reference, powers, mask, midi, velocity), sample_id in zip(rows, sample_ids):
        representative_basis = np.column_stack([
            chebyshev_values((midi - 64.5) / 43.5, 4)[i]
            * chebyshev_values(2 * velocity - 1, 2)[j]
            * chebyshev_values(.3141612258263221 * np.log(representatives / 27.5) - 1, 6)[k]
            for i, j, k in SURFACE_TERMS
        ])
        fundamental = 440 * 2 ** ((midi - 69) / 12)
        fundamental_basis = np.array([
            chebyshev_values((midi - 64.5) / 43.5, 4)[i]
            * chebyshev_values(2 * velocity - 1, 2)[j]
            * chebyshev_values(.3141612258263221 * np.log(fundamental / 27.5) - 1, 6)[k]
            for i, j, k in SURFACE_TERMS
        ])
        anchor = fundamental_basis @ coefficients
        gains = 10 ** (np.clip(scale * (representative_basis @ coefficients - anchor), -18, 18) / 20)
        response = np.abs(auditory_responses @ gains)
        fundamental_response = abs(causal_band_responses(np.array([fundamental]))[0] @ gains)
        correction = 20 * np.log10(np.maximum(response / fundamental_response, np.finfo(float).tiny))
        error = np.mean(np.abs(corrected_profile(powers, correction)[mask] - reference[mask]))
        by_sample.setdefault(sample_id, []).append(error)
    full = np.array([np.mean(values) for values in by_sample.values()])
    quick = np.array([np.mean(by_sample[index]) for index in sorted(quick_ids)])
    return np.median(full), np.percentile(full, 90), np.median(quick), np.percentile(quick, 90)


for kind in ("sustain", "transient"):
    rows, sample_ids, quick_ids = collect(kind)
    correction = fit(rows)
    baseline = distribution(rows, sample_ids, quick_ids, np.zeros(14))
    corrected = distribution(rows, sample_ids, quick_ids, correction)
    print(f"\n{kind}")
    print("baseline  full %.3f / %.3f, quick %.3f / %.3f" % baseline)
    print("corrected full %.3f / %.3f, quick %.3f / %.3f" % corrected)
    print("ideal per-sample static full %.3f / %.3f, quick %.3f / %.3f" %
          ideal_per_sample_distribution(rows, sample_ids, quick_ids))
    for frequency, value in zip(BAND_CENTERS, correction):
        print(f"{frequency:8.1f} Hz {value:8.3f} dB")
    candidates = []
    for maximum_total_degree in (3, 4, 5, 6):
        SURFACE_TERMS = [
            (midi_degree, velocity_degree, frequency_degree)
            for frequency_degree in range(1, 7)
            for midi_degree in range(5)
            for velocity_degree in range(3)
            if midi_degree + velocity_degree + frequency_degree <= maximum_total_degree
        ]
        candidate_coefficients = fit_surface(rows)
        candidate_result = surface_distribution(
            rows, sample_ids, quick_ids, candidate_coefficients,
        )
        candidates.append((candidate_result, list(SURFACE_TERMS), candidate_coefficients))
        print(
            f"surface d{maximum_total_degree} ({len(SURFACE_TERMS):2} terms) "
            "full %.3f / %.3f, quick %.3f / %.3f" % candidate_result
        )
    surfaced, SURFACE_TERMS, coefficients = candidates[2]
    relative_values = []
    for _entry in SYNTHESIZED["entries"]:
        _surface = surface_basis(_entry["midi"], _entry["velocity"]) @ coefficients
        _fundamental_x = .3141612258263221 * np.log(
            440 * 2 ** ((_entry["midi"] - 69) / 12) / 27.5
        ) - 1
        _midi_terms = chebyshev_values((_entry["midi"] - 64.5) / 43.5, 4)
        _velocity_terms = chebyshev_values(2 * _entry["velocity"] - 1, 2)
        _frequency_terms = chebyshev_values(_fundamental_x, 6)
        _anchor = sum(
            coefficient * _midi_terms[i] * _velocity_terms[j] * _frequency_terms[k]
            for (i, j, k), coefficient in zip(SURFACE_TERMS, coefficients)
        )
        relative_values.extend(_surface - _anchor)
    print(
        f"surface d5 relative correction range: "
        f"{np.percentile(relative_values, 1):.2f}..{np.percentile(relative_values, 99):.2f} dB "
        f"(absolute {min(relative_values):.2f}..{max(relative_values):.2f})"
    )
    print(f"surface d5 coefficients:")
    for term, value in zip(SURFACE_TERMS, coefficients):
        print(f"{term}: {value:.12g}")
    for scale in (.1, .3, .65, 1):
        print(
            f"causal 7-band scale {scale:g}: full %.3f / %.3f, quick %.3f / %.3f"
            % causal_surface_distribution(rows, sample_ids, quick_ids, coefficients, scale)
        )
