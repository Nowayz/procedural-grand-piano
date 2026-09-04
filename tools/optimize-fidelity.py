#!/usr/bin/env python3
"""Coordinate-fit smooth physical controls against freshly rendered quick scans."""

import json
import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "reports/strict-fidelity-quick.json"
NAMES = [
    "PIANO_RADIATION_001", "PIANO_RADIATION_011", "PIANO_RADIATION_021",
    "PIANO_RADIATION_101", "PIANO_RADIATION_111", "PIANO_RADIATION_201",
    "PIANO_RADIATION_002", "PIANO_RADIATION_012", "PIANO_RADIATION_102",
    "PIANO_RADIATION_003",
]
values = [
    .134226190149, .220563442064, 1.08059548476, -5.70962491042,
    -.675709313649, 5.9945502927, -.706393508753, -.450529544093,
    1.22609071367, -3.79719518807,
]
base = {
    "PIANO_DRIVE_BOUND": 10,
    "PIANO_SOUNDBOARD_GAIN": 3,
    "PIANO_STRING_MIX_BASE": .95,
    "PIANO_DIFFUSE_BODY_GAIN": .03,
    "PIANO_LOSS_BOUND": 6,
}
cache = {}
evaluation = 0


def evaluate(candidate):
    global evaluation
    key = tuple(round(value, 8) for value in candidate)
    if key in cache:
        return cache[key]
    definitions = dict(base)
    definitions.update(zip(NAMES, candidate))
    environment = dict(os.environ)
    environment["PIANO_WASM_DEFINES"] = json.dumps(definitions, separators=(",", ":"))
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


best = evaluate(values)
for step in (2, 1, .5, .25):
    print(f"coordinate step {step}", flush=True)
    improved = True
    passes = 0
    while improved and passes < 2:
        improved = False
        passes += 1
        for index, name in enumerate(NAMES):
            candidates = []
            for direction in (-1, 1):
                candidate = list(values)
                candidate[index] += direction * step
                candidates.append((evaluate(candidate), candidate))
            candidate_result, candidate_values = max(
                candidates, key=lambda item: item[0]["score"],
            )
            if candidate_result["score"] > best["score"]:
                values = candidate_values
                best = candidate_result
                improved = True
                print(f"accepted {name}={values[index]:.9g}; best={best['score']:.2f}", flush=True)

print("best result:", json.dumps(best, indent=2), flush=True)
print("best definitions:", json.dumps({**base, **dict(zip(NAMES, values))}, indent=2), flush=True)
evaluate(values)
sys.exit(0)
