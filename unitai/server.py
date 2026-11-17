"""Eastpac UNITE web server. Run: uv run uvicorn unitai.server:app --reload"""
from __future__ import annotations

import asyncio
import csv
import io
import shutil
import zipfile
from pathlib import Path, PurePosixPath

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import config, forge, gateway, pipeline, store

app = FastAPI(title="Eastpac UNITE")
_tasks: set[asyncio.Task] = set()


def _spawn(coro):
    t = asyncio.create_task(coro)
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)


def _run(rid: str) -> store.Run:
    run = store.get(rid)
    if not run:
        raise HTTPException(404, "Run not found")
    return run


def _safe_rel(name: str) -> Path | None:
    p = PurePosixPath(name.replace("\\", "/"))
    if p.is_absolute() or ".." in p.parts or not p.parts:
        return None
    return Path(*p.parts)


def _strip_common_root(repo: Path) -> None:
    """If the upload is a single top-level folder, flatten it."""
    entries = [e for e in repo.iterdir() if not e.name.startswith((".", "__MACOSX"))]
    if len(entries) == 1 and entries[0].is_dir():
        inner = entries[0]
        for child in inner.iterdir():
            shutil.move(str(child), repo / child.name)
        inner.rmdir()


# ------------------------------ config / forge ------------------------------

@app.get("/api/config")
def get_config():
    return {
        "models": config.MODELS, "tiers": config.TIER_MODELS, "tier_names": config.TIER_NAMES,
        "baseline": config.BASELINE_MODEL, "personas": forge.personas(),
        "has_key": bool(config.api_key()), "cache": config.CACHE_ENABLED,
        "standard": forge.UNITE_JS_STANDARD, "roles": forge.ROLES,
    }


@app.get("/api/live")
def live_agents():
    """Agents with an LLM call in flight right now (across all runs)."""
    import time as _t
    now = _t.time()
    calls = sorted(gateway.LIVE.values(), key=lambda c: c["started"])
    return {
        "max_parallel": config.MAX_PARALLEL,
        "calls": [{**c, "elapsed": round(now - c["started"], 1), "label": config.MODELS.get(c["model"], {}).get("label", c["model"])}
                  for c in calls],
    }


@app.put("/api/config/tiers")
async def set_tiers(req: Request):
    body = await req.json()
    for k, v in body.items():
        if int(k) in (1, 2, 3) and v in config.MODELS:
            config.TIER_MODELS[int(k)] = v
    forge.save()
    return config.TIER_MODELS


def _persona_or_404(pid: str) -> dict:
    try:
        return forge.persona(pid)
    except StopIteration:
        raise HTTPException(404, "Persona not found")


@app.put("/api/personas/{pid}")
async def update_persona(pid: str, req: Request):
    _persona_or_404(pid)
    forge.set_override(pid, await req.json())
    return forge.persona(pid)


@app.post("/api/personas")
async def create_persona(req: Request):
    body = await req.json()
    _persona_or_404(body.get("base", ""))
    try:
        return forge.create(body["base"], (body.get("name") or "New persona").strip()[:40])
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/personas/{pid}")
def delete_persona(pid: str):
    if not _persona_or_404(pid)["custom"]:
        raise HTTPException(400, "Built-in personas can be reset, not deleted")
    forge.delete(pid)
    return {"ok": True}


@app.post("/api/personas/{pid}/reset")
def reset_persona(pid: str):
    _persona_or_404(pid)
    forge.reset(pid)
    return forge.persona(pid)


@app.post("/api/personas/{pid}/activate")
def activate_persona(pid: str):
    p = _persona_or_404(pid)
    try:
        forge.bind(p["acts_as"], pid)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return forge.persona(pid)


class _Scratch:
    """A throwaway 'run' so playground calls are metered the same way as pipeline calls."""
    def __init__(self):
        self.calls = []

    def record_call(self, entry):
        self.calls.append(entry)


@app.post("/api/personas/{pid}/try")
async def try_persona(pid: str, req: Request):
    p = _persona_or_404(pid)
    if not p["llm"]:
        raise HTTPException(400, "This persona doesn't call an LLM")
    body = await req.json()
    tier = int(body.get("tier") or p["min_tier"])
    model = body.get("model") or p.get("model_override") or config.TIER_MODELS[max(1, min(3, tier))]
    if model not in config.MODELS:
        raise HTTPException(400, "Unknown model")
    scratch = _Scratch()
    try:
        text = await gateway.complete(scratch, stage="playground", agent=p["name"], task="playground", model=model,
                                      tier=config.MODELS.get(model, {}).get("tier", tier),
                                      system=str(body.get("system") or p["system"])[:20000],
                                      user=str(body.get("prompt", ""))[:20000], max_tokens=1500,
                                      temperature=float(body.get("temperature", p.get("temperature", 0.2))))
    except (gateway.LLMError, gateway.MissingKey) as e:
        raise HTTPException(502, str(e))
    return {"text": text, **scratch.calls[0]}


# ------------------------------ runs ------------------------------

@app.get("/api/runs")
def list_runs():
    return store.all_runs()


@app.post("/api/runs")
async def create_run(req: Request):
    form = await req.form()
    sample = form.get("sample")
    uploads: list[UploadFile] = [f for f in form.getlist("files") if hasattr(f, "filename")]
    name = form.get("name") or (sample or (uploads[0].filename.split("/")[0] if uploads else "project"))
    name = Path(str(name)).stem
    run = store.create(str(name))
    run.repo_dir.mkdir(parents=True, exist_ok=True)

    if sample:
        src = config.SAMPLES_DIR / Path(str(sample)).name
        if not src.is_dir():
            raise HTTPException(400, "Unknown sample")
        shutil.copytree(src, run.repo_dir, dirs_exist_ok=True)
    elif len(uploads) == 1 and uploads[0].filename.lower().endswith(".zip"):
        data = await uploads[0].read()
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for info in z.infolist():
                rel = _safe_rel(info.filename)
                if rel is None or info.is_dir() or info.file_size > 2_000_000:
                    continue
                dest = run.repo_dir / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(z.read(info))
        _strip_common_root(run.repo_dir)
    elif uploads:
        for f in uploads:
            rel = _safe_rel(f.filename)
            if rel is None:
                continue
            dest = run.repo_dir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(await f.read())
        _strip_common_root(run.repo_dir)
    else:
        raise HTTPException(400, "Provide a zip, a folder, or a sample")

    if not any(run.repo_dir.rglob("*.py")):
        raise HTTPException(400, "No Python files found in upload")
    run.log("Orchestrator", f"Project '{run.data['name']}' ingested")
    return {"id": run.id}


@app.get("/api/runs/{rid}")
def get_run(rid: str):
    return _run(rid).data


def _require(run, stage, *ok):
    st = run.status(stage)
    if st not in ok:
        raise HTTPException(409, f"Stage '{stage}' is {st}")


@app.post("/api/runs/{rid}/discover")
async def start_discover(rid: str):
    run = _run(rid)
    _require(run, "discover", "idle", "error", "review", "approved")
    run.data["docs"] = {}
    run.data["diagrams"] = []
    _spawn(pipeline.discover(run))
    return {"ok": True}


@app.put("/api/runs/{rid}/docs")
async def save_docs(rid: str, req: Request):
    run = _run(rid)
    body = await req.json()
    for k in ("docs", "overview", "diagrams", "notes"):
        if k in body:
            run.data[k] = body[k]
    run.save()
    return {"ok": True}


@app.post("/api/runs/{rid}/approve/{stage}")
def approve(rid: str, stage: str):
    run = _run(rid)
    _require(run, stage, "review", "done")
    run.set_stage(stage, "approved")
    run.log("Human", f"Approved {stage} ✓", "gate")
    return {"ok": True}


@app.post("/api/runs/{rid}/design")
async def start_design(rid: str):
    run = _run(rid)
    _require(run, "discover", "approved")
    _require(run, "design", "idle", "error", "review", "approved")
    _spawn(pipeline.design(run))
    return {"ok": True}


@app.put("/api/runs/{rid}/design")
async def save_design(rid: str, req: Request):
    run = _run(rid)
    body = await req.json()
    if "summary" in body and run.data["design"]:
        run.data["design"]["summary"] = body["summary"]
    if "tasks" in body:
        by_id = {t["id"]: t for t in body["tasks"]}
        for t in run.data["tasks"]:
            if t["id"] in by_id:
                t["enabled"] = bool(by_id[t["id"]].get("enabled", True))
                t["notes"] = by_id[t["id"]].get("notes", t["notes"])
    run.save()
    return {"ok": True}


@app.post("/api/runs/{rid}/build")
async def start_build(rid: str):
    run = _run(rid)
    _require(run, "design", "approved")
    _require(run, "build", "idle", "error", "done")
    _spawn(pipeline.build(run))
    return {"ok": True}


@app.post("/api/runs/{rid}/verify")
async def start_verify(rid: str):
    run = _run(rid)
    _require(run, "build", "done")
    _require(run, "verify", "idle", "error", "review", "done")
    _spawn(pipeline.verify(run))
    return {"ok": True}


@app.post("/api/runs/{rid}/fix")
async def start_fix(rid: str):
    run = _run(rid)
    _require(run, "verify", "review")
    _spawn(pipeline.fix(run))
    return {"ok": True}


@app.get("/api/runs/{rid}/download")
def download(rid: str):
    run = _run(rid)
    if not run.out_dir.exists():
        raise HTTPException(404, "Nothing built yet")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in run.out_dir.rglob("*"):
            if f.is_file():
                z.write(f, f.relative_to(run.out_dir))
        for p, d in run.data["docs"].items():
            z.writestr(f"docs/{Path(p).stem}.md", d)
        if run.data["overview"]:
            z.writestr("docs/OVERVIEW.md", run.data["overview"])
        for d in run.data["diagrams"]:
            z.writestr(f"docs/diagrams/{d['id']}.mmd", d["code"])
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/zip",
                             headers={"Content-Disposition": f'attachment; filename="{run.data["name"]}-eastpac-unite.zip"'})


@app.get("/api/runs/{rid}/ledger.csv")
def ledger_csv(rid: str):
    run = _run(rid)
    buf = io.StringIO()
    cols = ["ts", "stage", "agent", "task", "model", "tier", "tokens_in", "tokens_out", "cached_tokens",
            "cost", "baseline_cost", "latency_ms", "attempt", "escalated", "replayed"]
    w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    w.writeheader()
    for e in run.data["ledger"]:
        w.writerow(e)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{rid}-ledger.csv"'})


# ------------------------------ web ------------------------------

app.mount("/static", StaticFiles(directory=config.WEB_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(config.WEB_DIR / "index.html")
