#!/usr/bin/env python3
"""Update Sunday project progress. Usage:
  python3 update-progress.py --phase "Fork Build (Full IDE)" --percent 90 --detail "new detail"
  python3 update-progress.py --gates 2 --gate-detail "new detail"
"""
import json, sys, argparse
from datetime import datetime, timezone, timedelta

P = "/home/hatch/workspace/sunday-product/docs/PROGRESS.json"

def load():
    with open(P) as f: return json.load(f)

def save(d):
    d["updated"] = (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).isoformat(timespec="seconds")
    with open(P, "w") as f: json.dump(d, f, indent=2)
    print(f"Updated {P}")

ap = argparse.ArgumentParser()
ap.add_argument("--phase", help="Phase name (exact match)")
ap.add_argument("--percent", type=int, help="New percent 0-100")
ap.add_argument("--detail", help="New detail text")
ap.add_argument("--status", help="done|active|pending")
ap.add_argument("--gates", type=int, help="Gates green count")
ap.add_argument("--gate-detail", help="Gates detail text")
a = ap.parse_args()

d = load()
if a.phase:
    for ph in d["phases"]:
        if ph["name"] == a.phase:
            if a.percent is not None: ph["percent"] = a.percent
            if a.detail: ph["detail"] = a.detail
            if a.status: ph["status"] = a.status
            print(f"Phase '{a.phase}' -> {ph['percent']}% [{ph['status']}]")
            break
    else:
        print(f"Phase '{a.phase}' not found"); sys.exit(1)
if a.gates is not None:
    d["release_gates"]["green"] = a.gates
    print(f"Gates -> {a.gates}/{d['release_gates']['total']}")
if a.gate_detail:
    d["release_gates"]["detail"] = a.gate_detail
save(d)
