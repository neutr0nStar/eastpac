"""Run state, persisted as JSON so the server can restart without losing a demo."""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

from . import config

STAGES = ["discover", "design", "build", "verify"]
_runs: dict[str, "Run"] = {}


class Run:
    def __init__(self, data: dict):
        self.data = data

    # ----- identity / paths -----
    @property
    def id(self) -> str:
        return self.data["id"]

    @property
    def dir(self) -> Path:
        return config.RUNS_DIR / self.id

    @property
    def repo_dir(self) -> Path:
        return self.dir / "repo"

    @property
    def out_dir(self) -> Path:
        return self.dir / "out"

    # ----- mutation helpers -----
    def save(self) -> None:
        self.data["updated"] = time.time()
        (self.dir / "run.json").write_text(json.dumps(self.data, indent=1))

    def log(self, agent: str, msg: str, level: str = "info") -> None:
        self.data["events"].append({"ts": time.time(), "agent": agent, "msg": msg, "level": level})
        self.data["events"] = self.data["events"][-400:]
        self.save()

    def record_call(self, entry: dict) -> None:
        self.data["ledger"].append(entry)
        r = entry.get("route", {})
        tag = " · replay" if entry["replayed"] else ""
        self.log(entry["agent"],
                 f"{entry['task']} → {config.MODELS.get(entry['model'], {}).get('label', entry['model'])} "
                 f"(T{entry['tier']}) · {entry['tokens_in'] + entry['tokens_out']:,} tok · "
                 f"${entry['cost']:.4f}{tag}" + (f" · {r['reason']}" if r.get("reason") else ""),
                 "call")

    def set_stage(self, stage: str, status: str, error: str | None = None) -> None:
        self.data["stages"][stage] = {"status": status, "error": error, "ts": time.time()}
        self.save()

    def status(self, stage: str) -> str:
        return self.data["stages"][stage]["status"]


def create(name: str) -> Run:
    rid = time.strftime("%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
    data = {
        "id": rid, "name": name, "created": time.time(), "updated": time.time(),
        "stages": {s: {"status": "idle", "error": None, "ts": None} for s in STAGES},
        "files": {}, "analysis": None, "overview": "", "docs": {}, "diagrams": [],
        "notes": "", "design": None, "tasks": [], "build": {}, "verify": None,
        "ledger": [], "events": [],
    }
    run = Run(data)
    run.dir.mkdir(parents=True, exist_ok=True)
    run.save()
    _runs[rid] = run
    return run


def get(rid: str) -> Run | None:
    if rid in _runs:
        return _runs[rid]
    f = config.RUNS_DIR / rid / "run.json"
    if f.exists():
        run = Run(json.loads(f.read_text()))
        # A server restart kills in-flight work; surface that instead of spinning forever.
        for s, st in run.data["stages"].items():
            if st["status"] == "running":
                st.update(status="error", error="Interrupted by server restart. Run it again.")
        _runs[rid] = run
        return run
    return None


def all_runs() -> list[dict]:
    out = []
    for f in sorted(config.RUNS_DIR.glob("*/run.json"), reverse=True):
        try:
            d = json.loads(f.read_text())
        except json.JSONDecodeError:
            continue
        out.append({
            "id": d["id"], "name": d["name"], "created": d["created"],
            "stages": {k: v["status"] for k, v in d["stages"].items()},
            "cost": sum(e["cost"] for e in d["ledger"]),
            "tokens": sum(e["tokens_in"] + e["tokens_out"] for e in d["ledger"]),
        })
    return out
