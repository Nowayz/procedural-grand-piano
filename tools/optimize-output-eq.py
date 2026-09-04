#!/usr/bin/env python3
"""Coordinate-fit the causal output-radiation surface on fresh quick renders."""

import json
import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "reports/strict-fidelity-quick.json"
NAMES = [
    "PIANO_OUTPUT_001", "PIANO_OUTPUT_011", "PIANO_OUTPUT_021",
    "PIANO_OUTPUT_101", "PIANO_OUTPUT_111", "PIANO_OUTPUT_201",
    "PIANO_OUTPUT_002", "PIANO_OUTPUT_012", "PIANO_OUTPUT_102",
    "PIANO_OUTPUT_003",
]
BASE = {
    "PIANO_DRIVE_BOUND": 10,
    "PIANO_SOUNDBOARD_GAIN": 3,
    "PIANO_STRING_MIX_BASE": .95,
    "PIANO_DIFFUSE_BODY_GAIN": .03,
    "PIANO_LOSS_BOUND": 6,
    "PIANO_BRIDGE_PARTICIPATION_BOUND": 6,
    "PIANO_RADIATION_FLOOR": .14,
    "PIANO_HIGH_LOSS_DB": 6,
    "PIANO_HIGH_LOSS_CORNER": 4000,
    "PIANO_RADIATION_LOSS_SCALE": .25,
    "PIANO_OUTPUT_EQ_SCALE": .3,
    "PIANO_IMPACT_SPECTRAL_SCALE": .1,
    "PIANO_RADIATION_001": -.865773809851,
    "PIANO_RADIATION_011": 2.220563442064,
    "PIANO_RADIATION_021": 2.08059548476,
    "PIANO_RADIATION_101": -6.70962491042,
    "PIANO_RADIATION_111": -2.425709313649,
    "PIANO_RADIATION_201": 6.9945502927,
    "PIANO_RADIATION_002": 1.293606491247,
    "PIANO_RADIATION_012": -1.450529544093,
    "PIANO_RADIATION_102": 5.22609071367,
    "PIANO_RADIATION_003": -1.79719518807,
}
values = [0.] * len(NAMES)
cache = {}
evaluation = 0


def definitions(candidate):
    return {**BASE, **dict(zip(NAMES, candidate))}


def run(candidate, force=False):
    global evaluation
    key = tuple(round(value, 8) for value in candidate)
    if not force and key in cache:
        return cache[key]
    environment = dict(os.environ)
    environment["PIANO_WASM_DEFINES"] = json.dumps(definitions(candidate), separators=(",", ":"))
    subprocess.run(
        ["node", "tools/build-wasm.mjs"], cwd=ROOT, env=environment,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True,
    )
    subprocess.run(
        ["node", "tools/compare-reference-fidelity.mjs", "--quick", "--write-report", "--no-fail"],
        cwd=ROOT, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True,
    )
    report = json.loads(REPORT.read_text())
    checks = {check["name"]: check for check in report["checks"]}
    result = {
        "score": report["score"],
        "transient": checks["hammer/board spectrum converges through 110 ms"]["actual"]["median"],
        "sustain": checks["auditory-band color converges over 2.05 seconds"]["actual"]["median"],
        "partial": checks["resolved partial balance converges over time"]["actual"]["median"],
    }
    cache[key] = result
    evaluation += 1
    print(
        f"{evaluation:03} score={result['score']:.2f} transient={result['transient']:.3f} "
        f"sustain={result['sustain']:.3f} partial={result['partial']:.3f}",
        flush=True,
    )
    return result


best = run(values)
for step in (2, 1, .5, .25):
    print(f"coordinate step {step}", flush=True)
    for _pass in range(2):
        improved = False
        for index, name in enumerate(NAMES):
            candidates = []
            for direction in (-1, 1):
                candidate = list(values)
                candidate[index] += direction * step
                candidates.append((run(candidate), candidate))
            candidate_result, candidate_values = max(candidates, key=lambda item: item[0]["score"])
            if candidate_result["score"] > best["score"]:
                values = candidate_values
                best = candidate_result
                improved = True
                print(f"accepted {name}={values[index]:.9g}; best={best['score']:.2f}", flush=True)
        if not improved:
            break

print("best result:", json.dumps(best, indent=2), flush=True)
print("best definitions:", json.dumps(definitions(values), indent=2), flush=True)
run(values, force=True)
