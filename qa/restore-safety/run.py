#!/usr/bin/env python3
"""Run only the isolated synthetic restore harness; normalize test failure to 1.

--mutant NAME intentionally breaks generated test build inputs, never production.
--verify-mutations requires real assertion failures for every selected mutation.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
MUTANTS = ("no-node-lock", "move-original-first", "drop-previous", "move-always-success", "plain-rename")
parser = argparse.ArgumentParser()
parser.add_argument("--offline", action="store_true")
parser.add_argument("--mutant", choices=MUTANTS)
parser.add_argument("--verify-mutations", action="store_true")
args = parser.parse_args()

def run(mutant=None):
    env = dict(os.environ)
    env.pop("RESTORE_SAFETY_MUTANT", None)
    if mutant:
        env["RESTORE_SAFETY_MUTANT"] = mutant
    command = ["cargo", "test", "--locked", "--manifest-path", str(ROOT / "Cargo.toml")]
    if args.offline:
        command.append("--offline")
    command += ["--", "--test-threads=1"]
    result = subprocess.run(command, cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    label = mutant or "normal"
    (ROOT / "results").mkdir(exist_ok=True)
    (ROOT / "results" / f"{label}.log").write_text(result.stdout)
    passed = result.returncode == 0
    assertion_failure = "test result: FAILED" in result.stdout and ("panicked at" in result.stdout or "assertion" in result.stdout)
    print(f"{label}: exit {0 if passed else 1}; assertion_failure={assertion_failure}")
    if not args.verify_mutations or (mutant and not assertion_failure):
        print(result.stdout)
    return {"case": label, "exit": 0 if passed else 1, "assertion_failure": assertion_failure}

if args.verify_mutations:
    results = [run()] + [run(mutant) for mutant in MUTANTS] + [run()]
    success = results[0]["exit"] == 0 and results[-1]["exit"] == 0 and all(row["exit"] == 1 and row["assertion_failure"] for row in results[1:-1])
    (ROOT / "results" / "mutation-summary.json").write_text(json.dumps({"passed": success, "results": results}, indent=2) + "\n")
    sys.exit(0 if success else 1)
sys.exit(run(args.mutant)["exit"])
