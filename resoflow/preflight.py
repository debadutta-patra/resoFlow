from __future__ import annotations
import argparse
import contextlib
import json
import sys
from collections import defaultdict
from pathlib import Path

from chemex.configuration.methods import Selection
from chemex.configuration.parameters import read_defaults
from chemex.experiments.builder import build_experiments
from chemex.runtime import AnalysisSession, ensure_plugins_registered

_CONDITION_KEYS = ("temperature", "h_larmor_frq", "p_total", "l_total", "d2o")

def _conditions(param_name) -> dict[str, float]:
    cond = param_name.conditions
    return {k: getattr(cond, k) for k in _CONDITION_KEYS if getattr(cond, k, None) is not None}

def build_sharing_map(exp_files: list[Path], param_files: list[Path] | None = None, model: str = "2st") -> dict:
    ensure_plugins_registered()
    session = AnalysisSession.create()
    session.set_model(model)
    with contextlib.redirect_stdout(sys.stderr):
        experiments = build_experiments(exp_files, Selection(None, None), session=session)
    if param_files:
        defaults = read_defaults(param_files)
        store = session.parameters
        setter = getattr(store, "set_param_defaults", None) or store.set_defaults
        with contextlib.redirect_stdout(sys.stderr):
            setter(defaults)

    used_by: dict[str, set[str]] = defaultdict(set)
    for experiment in experiments:
        label = Path(experiment.filename).name
        for profile in experiment.profiles:
            for pid in profile.param_ids:
                used_by[pid].add(label)

    frontier = list(used_by)
    while frontier:
        pid = frontier.pop()
        setting = session.parameters.get_parameters([pid]).get(pid)
        for dep in getattr(setting, "dependencies", None) or ():
            before = len(used_by[dep])
            used_by[dep] |= used_by[pid]
            if len(used_by[dep]) != before:
                frontier.append(dep)

    params = session.parameters.get_parameters(used_by)
    rows = []
    for pid, setting in params.items():
        if getattr(setting, "expr", ""):
            continue
        pname = setting.param_name
        rows.append({
            "id": pid,
            "selector": pname.section_res,
            "name": pname.name,
            "spin": str(pname.spin_system) if pname.spin_system else "",
            "conditions": _conditions(pname),
            "vary": bool(getattr(setting, "vary", False)),
            "value": getattr(setting, "value", None),
            "experiments": sorted(used_by[pid]),
        })
    rows.sort(key=lambda r: r["selector"])

    warnings = []
    by_family: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in rows:
        by_family[(row["name"], row["spin"])].append(row)

    for (name, spin), family in by_family.items():
        key_sets = {tuple(sorted(r["conditions"])) for r in family}
        if len(key_sets) > 1:
            warnings.append({
                "code": "CONDITION_MISMATCH",
                "parameter": f"{name}{', ' + spin if spin else ''}",
                "variants": [r["selector"] for r in family],
                "message": "Same parameter under different condition qualifiers; these copies are fitted independently, not shared.",
            })
        fields = sorted({r["conditions"]["h_larmor_frq"] for r in family if "h_larmor_frq" in r["conditions"]})
        for lo, hi in zip(fields, fields[1:]):
            if hi - lo < 1.0:
                warnings.append({
                    "code": "NEAR_FIELD",
                    "parameter": f"{name}{', ' + spin if spin else ''}",
                    "fields_mhz": [lo, hi],
                    "message": "Fields differ by < 1 MHz, so field-dependent rates are split. Snap both to one spectrometer value if they are the same magnet.",
                })

    all_files = sorted({Path(e.filename).name for e in experiments})
    for label in all_files:
        shares = any(r["vary"] and label in r["experiments"] and len(r["experiments"]) > 1 for r in rows)
        if not shares and len(all_files) > 1:
            warnings.append({
                "code": "ISOLATED",
                "experiment": label,
                "message": "Shares no fitted parameter with any other experiment file.",
            })

    return {"experiments": all_files, "parameters": rows, "warnings": warnings}

def _print_table(result: dict) -> None:
    for row in result["parameters"]:
        tag = "SHARED" if len(row["experiments"]) > 1 else "single"
        role = "fit" if row["vary"] else "fix"
        print(f"{tag:<7}{role}  {row['selector']:<46} {', '.join(row['experiments'])}")
    if result["warnings"]:
        print()
    for w in result["warnings"]:
        target = w.get("parameter") or w.get("experiment")
        print(f"[{w['code']}] {target}: {w['message']}")

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("-e", "--experiments", nargs="+", type=Path, required=True)
    parser.add_argument("-p", "--parameters", nargs="*", type=Path, default=None)
    parser.add_argument("-d", "--model", default="2st")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    result = build_sharing_map(args.experiments, args.parameters, args.model)
    if args.json:
        json.dump(result, sys.stdout, indent=2, default=str)
        print()
    else:
        _print_table(result)
    return 1 if any(w["code"] == "CONDITION_MISMATCH" for w in result["warnings"]) else 0

if __name__ == "__main__":
    raise SystemExit(main())
