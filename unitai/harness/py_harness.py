"""Run characterization cases against the legacy Python module and print JSON results.

Usage: python -I py_harness.py <repo_dir> <module_name> <cases.json>
"""
import decimal
import enum
import importlib
import json
import math
import sys


def norm(v, depth=0):
    if depth > 20:
        return "<deep>"
    if v is None or isinstance(v, (bool, str)):
        return v
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        if math.isnan(v):
            return "NaN"
        if math.isinf(v):
            return "Infinity" if v > 0 else "-Infinity"
        return v
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, enum.Enum):
        return norm(v.value, depth + 1)
    if isinstance(v, (list, tuple)):
        return [norm(x, depth + 1) for x in v]
    if isinstance(v, (set, frozenset)):
        return sorted((norm(x, depth + 1) for x in v), key=repr)
    if isinstance(v, dict):
        return {str(k): norm(x, depth + 1) for k, x in v.items()}
    if hasattr(v, "__dict__"):
        return {k: norm(x, depth + 1) for k, x in vars(v).items() if not k.startswith("__")}
    return repr(v)


def err(e):
    return {"error": type(e).__name__, "message": str(e)[:200]}


def call(fn_or_val, args):
    if callable(fn_or_val):
        return {"ok": norm(fn_or_val(*args))}
    return {"ok": norm(fn_or_val)}


def main():
    repo, module, cases_path = sys.argv[1:4]
    sys.path.insert(0, repo)
    mod = importlib.import_module(module)
    cases = json.load(open(cases_path))
    out = []
    for c in cases:
        try:
            if c.get("kind") == "class":
                cls = getattr(mod, c["target"])
                try:
                    inst = cls(*c.get("ctor_args", []))
                except Exception as e:  # noqa: BLE001
                    out.append({"id": c["id"], "result": err(e)})
                    continue
                steps = []
                for s in c.get("calls", []):
                    try:
                        steps.append(call(getattr(inst, s["method"]), s.get("args", [])))
                    except Exception as e:  # noqa: BLE001
                        steps.append(err(e))
                out.append({"id": c["id"], "result": {"ok": steps}})
            else:
                fn = getattr(mod, c["target"])
                out.append({"id": c["id"], "result": call(fn, c.get("args", []))})
        except Exception as e:  # noqa: BLE001
            out.append({"id": c["id"], "result": err(e)})
    print(json.dumps(out))


if __name__ == "__main__":
    main()
