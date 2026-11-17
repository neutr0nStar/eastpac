"""The Eastpac UNITE pipeline: Discover → Design → Build → Verify, with human gates between stages."""
from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path

from . import analysis as an
from . import config, forge
from .gateway import LLMError, complete, extract_code, extract_json, extract_mermaid

HARNESS = Path(__file__).parent / "harness"


def camel(s: str) -> str:
    return re.sub(r"_+([a-z0-9])", lambda m: m.group(1).upper(), s)


async def agent_call(run, pid, *, stage, task, user, prof=None, validate=None,
                     max_tokens=4000, max_attempts=3, start_attempt=0):
    """Call a persona; on validation failure, feed the error back and escalate one tier."""
    p = forge.for_role(pid)  # may be a custom persona the user bound to this role in AgentForge
    feedback = ""
    last_err = None
    for attempt in range(start_attempt, start_attempt + max_attempts):
        r = forge.route(p["id"], prof, attempt)
        try:
            text = await complete(run, stage=stage, agent=p["name"], task=task, model=r["model"],
                                  tier=r["tier"], system=p["system"], user=user + feedback,
                                  max_tokens=p.get("max_tokens") or max_tokens, attempt=attempt, route=r,
                                  temperature=p.get("temperature", 0.2))
            result = await validate(text) if validate else text
            return result, r, attempt
        except (LLMError, ValueError, KeyError, TypeError) as e:
            last_err = str(e)
            run.log(p["name"], f"{task}: attempt {attempt + 1} rejected ({last_err[:160]}). Escalating.", "warn")
            feedback = (f"\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED BY AUTOMATED VALIDATION:\n{last_err[:1500]}\n"
                        "Fix the problem and answer again in the required format.")
            if r["tier"] >= p["max_tier"] and attempt - start_attempt >= 1:
                break
    raise LLMError(f"{p['name']} gave up on {task}: {last_err}")


def _guard(stage):
    def deco(fn):
        async def wrapper(run, *a, **kw):
            run.set_stage(stage, "running")
            try:
                await fn(run, *a, **kw)
            except Exception as e:  # noqa: BLE001
                run.log("Orchestrator", f"{stage} failed: {e}", "error")
                run.set_stage(stage, "error", str(e))
        return wrapper
    return deco


# =============================== DISCOVER ===============================

@_guard("discover")
async def discover(run):
    run.log("Orchestrator", "Discovery started")
    a = an.analyse_repo(run.repo_dir)
    run.data["analysis"] = a
    run.data["files"] = {m["path"]: (run.repo_dir / m["path"]).read_text(errors="replace") for m in a["modules"]}
    t = a["totals"]
    run.log("Cartographer", f"Parsed {t['modules']} modules · {t['loc']} LOC · {t['functions']} functions · "
                            f"{t['classes']} classes. 0 tokens, $0.00 (static analysis)", "done")
    run.data["diagrams"] = [
        {"id": "deps", "title": "Module dependency graph", "code": an.dependency_graph(a), "source": "static"},
        {"id": "classes", "title": "Class & module diagram", "code": an.class_diagram(a), "source": "static"},
    ]
    run.save()
    sigs = an.signatures(a)

    async def scribe(m):
        src = run.data["files"][m["path"]]
        user = (f"Repository outline (for context):\n{sigs}\n\n"
                f"Document the module `{m['path']}`. Source:\n```python\n{src}\n```\n\n"
                "Write Markdown with exactly these sections:\n"
                "## Purpose\n(2-3 sentences, business language)\n"
                "## Public API\n(a table: | Name | Signature | What it does |)\n"
                "## Business rules\n(bullets: the rules encoded in this module)\n"
                "## Edge cases & language quirks\n(bullets: anything a JavaScript port could get wrong)\n"
                "## Dependencies\n(bullets)\nDo not include a top-level title.")
        prof = forge.profile(src, m.get("complexity", 0))

        async def ok(text):
            text = re.sub(r"^```(?:markdown|md)?\s*\n(.*)\n```\s*$", r"\1", text.strip(), flags=re.S)
            # Normalise heading levels: models sometimes emit "# Purpose" or "### Purpose".
            text = re.sub(r"^#{1,6}\s*(Purpose|Public API|Business rules|Edge cases[^\n]*|Dependencies)\s*$",
                          r"## \1", text, flags=re.M | re.I)
            if not re.search(r"^## Purpose", text, re.M | re.I):
                raise ValueError("Missing required '## Purpose' section. Use the exact section headings requested.")
            return text.strip()

        doc, _, _ = await agent_call(run, "scribe", stage="discover", task=f"doc {m['path']}",
                                     user=user, prof=prof, validate=ok, max_tokens=2500)
        run.data["docs"][m["path"]] = doc
        run.save()

    run.log("Scribe", f"Swarm of {len(a['modules'])} Scribes documenting modules in parallel")
    await asyncio.gather(*(scribe(m) for m in a["modules"] if "error" not in m))

    all_docs = "\n\n".join(f"### {p}\n{d}" for p, d in run.data["docs"].items())

    async def overview():
        user = (f"Module documentation:\n{all_docs}\n\nWrite a system overview in Markdown for a "
                "business + engineering audience: ## What this system does, ## Key capabilities "
                "(bullets), ## Data & state, ## Migration watch-outs (top 5). Max 350 words. No title.")
        text, _, _ = await agent_call(run, "scribe", stage="discover", task="system overview", user=user,
                                      max_tokens=1500)
        run.data["overview"] = text.strip()
        run.save()

    async def draftsman():
        user = (f"Code outline:\n{sigs}\n\nModule docs:\n{all_docs}\n\n"
                "Produce two diagrams, each under its own markdown heading followed by a ```mermaid block:\n"
                "### Component view\n(a `flowchart TB` of components, external actors and data flows)\n"
                "### Key business flow\n(a `sequenceDiagram` of the single most important end-to-end flow)\n"
                "Output nothing else.")

        async def ok(text):
            ds = extract_mermaid(text)
            if len(ds) < 2:
                raise ValueError("Expected two ```mermaid blocks")
            return ds

        ds, _, _ = await agent_call(run, "draftsman", stage="discover", task="UML diagrams", user=user,
                                    validate=ok, max_tokens=2500)
        for i, d in enumerate(ds[:3]):
            run.data["diagrams"].append({"id": f"llm{i}", "title": d["title"], "code": d["code"], "source": "llm"})
        run.save()

    await asyncio.gather(overview(), draftsman())
    run.log("Orchestrator", "Discovery complete. Waiting for human review (Gate 1)", "gate")
    run.set_stage("discover", "review")


# =============================== DESIGN ===============================

@_guard("design")
async def design(run):
    a = run.data["analysis"]
    docs = "\n\n".join(f"### {p}\n{d}" for p, d in run.data["docs"].items())
    notes = run.data.get("notes") or "(none)"
    modules = [m for m in a["modules"] if "error" not in m]
    user = (
        f"Approved system overview:\n{run.data['overview']}\n\nApproved module docs:\n{docs}\n\n"
        f"Code outline:\n{an.signatures(a)}\n\nHUMAN REVIEWER NOTES (must be honoured):\n{notes}\n\n"
        "Design the migration of this Python codebase to the UNITE JavaScript standard. "
        "Return ONLY a JSON object:\n"
        '{"summary": "markdown: target architecture, key decisions and why (<= 300 words)",\n'
        ' "principles": ["short bullet", ...],\n'
        ' "modules": [{"source": "x.py", "target": "src/x.js", "notes": "porting guidance specific to this module",\n'
        '   "exports": [{"python": "snake_name", "js": "camelName", "kind": "function|class|constant",\n'
        '               "methods": [{"python": "apply_fee", "js": "applyFee"}]}]}],\n'
        ' "tasks": [{"id": "T1", "title": "...", "source": "x.py", "target": "src/x.js", "depends_on": ["T0"], "notes": "..."}],\n'
        ' "risks": [{"title": "...", "severity": "high|medium|low", "mitigation": "..."}]}\n'
        "One task per source module; depends_on must mirror the import graph. Include every public "
        "function and class in exports (methods listed for classes, including @property names)."
    )

    async def ok(text):
        d = extract_json(text)
        srcs = {m["source"] for m in d.get("modules", [])}
        missing = [m["path"] for m in modules if m["path"] not in srcs]
        if missing:
            raise ValueError(f"Design does not cover modules: {missing}")
        if not d.get("tasks"):
            raise ValueError("No tasks in design")
        return d

    run.log("Architect", "Designing target architecture (Frontier tier: high-stakes reasoning)")
    d, _, _ = await agent_call(run, "architect", stage="design", task="target design", user=user,
                               validate=ok, max_tokens=8000)
    run.data["design"] = d
    by_src = {m["source"]: m for m in d["modules"]}
    tasks = []
    for t in d["tasks"]:
        mod = next((m for m in modules if m["path"] == t.get("source")), None)
        if not mod:
            continue
        src = run.data["files"][mod["path"]]
        prof = forge.profile(src, mod.get("complexity", 0))
        r = forge.route("builder", prof)
        est_in = prof["size_tokens"] * 3 + 2500
        est_out = int(prof["size_tokens"] * 1.6) + 400
        tasks.append({
            "id": t["id"], "title": t.get("title") or f"Port {mod['path']}", "source": mod["path"],
            "module": mod["name"],
            "target": t.get("target") or by_src.get(mod["path"], {}).get("target") or f"src/{mod['name']}.js",
            "depends_on": t.get("depends_on", []), "notes": t.get("notes", ""), "enabled": True,
            "exports": by_src.get(mod["path"], {}).get("exports", []),
            "module_notes": by_src.get(mod["path"], {}).get("notes", ""),
            "profile": prof, "route": r, "estimate": forge.estimate(r["model"], est_in, est_out),
            "baseline_estimate": config.price(config.BASELINE_MODEL, est_in, est_out),
        })
    run.data["tasks"] = tasks
    run.log("Architect", f"Plan ready: {len(tasks)} tasks. Waiting for human approval (Gate 2)", "gate")
    run.set_stage("design", "review")


# =============================== BUILD ===============================

async def _node(*args, timeout=30, cwd=None):
    proc = await asyncio.create_subprocess_exec("node", *args, cwd=cwd, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return 1, "", "timeout"
    return proc.returncode, out.decode(), err.decode()


def _waves(tasks):
    done, waves = set(), []
    pending = {t["id"]: t for t in tasks}
    while pending:
        ready = [t for t in pending.values() if all(d in done or d not in pending for d in t["depends_on"])]
        if not ready:  # cycle; just run the rest
            ready = list(pending.values())
        waves.append(ready)
        for t in ready:
            done.add(t["id"])
            pending.pop(t["id"])
    return waves


def _export_names(task):
    return [e.get("js") or camel(e.get("python", "")) for e in task["exports"] if e.get("js") or e.get("python")]


async def _write_and_check(run, task, code):
    path = run.out_dir / task["target"]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(code)
    rc, _, err = await _node("--check", str(path))
    if rc != 0:
        raise ValueError(f"Syntax error:\n{err[-1200:]}")
    expected = _export_names(task)
    probe = ("import(process.argv[1]).then(m=>console.log(JSON.stringify(Object.keys(m))))"
             ".catch(e=>{console.error(e.stack||e);process.exit(1)})")
    rc, out, err = await _node("--input-type=module", "-e", probe, path.resolve().as_uri())
    if rc != 0:
        raise ValueError(f"Module failed to load:\n{err[-1200:]}")
    got = set(json.loads(out.strip().splitlines()[-1]))
    missing = [n for n in expected if n not in got]
    if missing:
        raise ValueError(f"Missing required exports: {missing}. Found: {sorted(got)}")
    return code


def _builder_prompt(run, task, extra=""):
    by_id = {t["id"]: t for t in run.data["tasks"]}
    deps = []
    for d in task["depends_on"]:
        t = by_id.get(d)
        if t:
            rel = Path(t["target"]).relative_to(Path(task["target"]).parent) if Path(t["target"]).parent == Path(task["target"]).parent else None
            imp = f"./{rel}" if rel else t["target"]
            deps.append(f"- `{t['source']}` is ported to `{imp}` exporting: {', '.join(_export_names(t))}")
    design = run.data["design"] or {}
    return (
        f"Approved design summary:\n{design.get('summary', '')}\n\n"
        f"Porting `{task['source']}` → `{task['target']}`.\n"
        f"Task notes: {task.get('notes') or '-'}\nModule notes: {task.get('module_notes') or '-'}\n\n"
        f"Required export mapping (export EXACTLY these names):\n{forge.dumps(task['exports'])}\n\n"
        f"Already-migrated dependencies (import from these, do not re-implement):\n{chr(10).join(deps) or '- none'}\n\n"
        f"Module documentation:\n{run.data['docs'].get(task['source'], '')}\n\n"
        f"Legacy source:\n```python\n{run.data['files'][task['source']]}\n```\n{extra}"
    )


@_guard("build")
async def build(run):
    tasks = [t for t in run.data["tasks"] if t["enabled"]]
    run.out_dir.mkdir(parents=True, exist_ok=True)
    (run.out_dir / "package.json").write_text(json.dumps(
        {"name": re.sub(r"\W+", "-", run.data["name"].lower()).strip("-") or "eastpac-unite-output",
         "version": "1.0.0", "type": "module", "private": True,
         "description": "Migrated by Eastpac UNITE", "engines": {"node": ">=20"}}, indent=2))
    for t in tasks:
        run.data["build"][t["id"]] = {"status": "queued", "attempts": [], "code": "", "error": None}
    run.save()

    async def one(task):
        b = run.data["build"][task["id"]]
        b["status"] = "running"
        run.save()

        async def ok(text):
            return await _write_and_check(run, task, extract_code(text))

        try:
            code, r, attempt = await agent_call(run, "builder", stage="build", task=f"port {task['source']}",
                                                user=_builder_prompt(run, task), prof=task["profile"],
                                                validate=ok, max_tokens=12000)
            b.update(status="done", code=code, model=r["model"], tier=r["tier"], attempts_used=attempt + 1)
            run.log("Builder", f"{task['target']} ✓ syntax + exports verified", "done")
        except Exception as e:  # noqa: BLE001
            b.update(status="failed", error=str(e))
        run.save()

    waves = _waves(tasks)
    for i, wave in enumerate(waves, 1):
        run.log("Orchestrator", f"Build wave {i}/{len(waves)}: {len(wave)} Builder(s) in parallel "
                                f"({', '.join(t['source'] for t in wave)})")
        await asyncio.gather(*(one(t) for t in wave))
    failed = [t for t, b in run.data["build"].items() if b["status"] == "failed"]
    if failed:
        raise LLMError(f"Tasks failed: {failed}")
    run.log("Orchestrator", "Build complete. Ready for verification", "gate")
    run.set_stage("build", "done")


# =============================== VERIFY ===============================

def _same(a, b) -> bool:
    if isinstance(a, dict) and isinstance(b, dict):
        if "error" in a or "error" in b:
            return "error" in a and "error" in b
        ka = {re.sub(r"[_#]", "", k).lower(): v for k, v in a.items()}
        kb = {re.sub(r"[_#]", "", k).lower(): v for k, v in b.items()}
        return ka.keys() == kb.keys() and all(_same(ka[k], kb[k]) for k in ka)
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b or a == b and type(a) is type(b)
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= 1e-9 * max(1.0, abs(a), abs(b))
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b))
    return a == b


async def _run_py(run, module, cases_file):
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-I", str(HARNESS / "py_harness.py"), str(run.repo_dir), module, str(cases_file),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await asyncio.wait_for(proc.communicate(), 60)
    if proc.returncode != 0:
        raise ValueError(f"Python harness failed: {err.decode()[-800:]}")
    return {r["id"]: r["result"] for r in json.loads(out.decode().strip().splitlines()[-1])}


async def _run_js(run, task, cases_file):
    rc, out, err = await _node(str(HARNESS / "js_harness.mjs"), str(run.out_dir / task["target"]), str(cases_file),
                               timeout=60)
    if rc != 0:
        return {"__crash__": err[-800:]}
    return {r["id"]: r["result"] for r in json.loads(out.strip().splitlines()[-1])}


def _mapping(task):
    fns, methods = {}, {}
    for e in task["exports"]:
        fns[e.get("python")] = e.get("js")
        for m in e.get("methods") or []:
            methods[(e.get("python"), m.get("python"))] = m.get("js")
    return fns, methods


async def _execute_js(run, task, mod_state):
    cases_file = run.dir / "verify" / f"{task['module']}.cases.json"
    js = await _run_js(run, task, cases_file)
    crash = js.get("__crash__")
    for c in mod_state["cases"]:
        c["js"] = js.get(c["id"], {"error": "HarnessCrash", "message": crash or "no result"})
        c["pass"] = _same(c["py"], c["js"])
    mod_state["passed"] = sum(c["pass"] for c in mod_state["cases"])
    mod_state["total"] = len(mod_state["cases"])


def _totals(run):
    v = run.data["verify"]
    v["passed"] = sum(m["passed"] for m in v["modules"].values())
    v["total"] = sum(m["total"] for m in v["modules"].values())
    run.save()


@_guard("verify")
async def verify(run):
    tasks = [t for t in run.data["tasks"] if t["enabled"] and run.data["build"].get(t["id"], {}).get("status") == "done"]
    (run.dir / "verify").mkdir(exist_ok=True)
    run.data["verify"] = {"modules": {}, "round": 1, "passed": 0, "total": 0}
    run.save()

    async def one(task):
        src = run.data["files"][task["source"]]
        user = (
            f"Legacy module `{task['source']}` (importable as `{task['module']}`):\n```python\n{src}\n```\n\n"
            f"Export mapping to the JS port:\n{forge.dumps(task['exports'])}\n\n"
            "Design 10-16 characterization test cases that pin the CURRENT behaviour of every public "
            "function and class, including error paths and edge cases where a JavaScript port could "
            "diverge. Arguments must be JSON literals, positional only. Return ONLY JSON:\n"
            '{"cases": [\n'
            ' {"label": "why this case matters", "kind": "function", "target": "python_name", "args": [...]},\n'
            ' {"label": "...", "kind": "class", "target": "ClassName", "ctor_args": [...],\n'
            '  "calls": [{"method": "python_method_or_property", "args": [...]}]}]}\n'
            "For a @property, put its name in `method` with no args. Do not compute expected values; "
            "the harness will execute the legacy code to obtain them."
        )
        fns, methods = _mapping(task)

        async def ok(text):
            cases = extract_json(text)["cases"]
            if len(cases) < 3:
                raise ValueError("Too few cases")
            return cases

        cases, _, _ = await agent_call(run, "verifier", stage="verify", task=f"tests {task['source']}",
                                       user=user, prof=forge.profile(src, 0), validate=ok, max_tokens=5000)
        for i, c in enumerate(cases):
            c["id"] = f"{task['module']}-{i + 1}"
            c["js_target"] = fns.get(c.get("target")) or camel(c.get("target", ""))
            for s in c.get("calls", []) or []:
                s["js_method"] = methods.get((c.get("target"), s.get("method"))) or camel(s.get("method", ""))
        cases_file = run.dir / "verify" / f"{task['module']}.cases.json"
        cases_file.write_text(json.dumps(cases, indent=1))
        py = await _run_py(run, task["module"], cases_file)
        # Drop malformed cases (target doesn't exist in legacy code): not real behaviour.
        kept = [c for c in cases if py.get(c["id"], {}).get("error") not in ("AttributeError",)
                or c.get("kind") == "class"]
        for c in kept:
            c["py"] = py.get(c["id"])
        cases_file.write_text(json.dumps(kept, indent=1))
        mod_state = {"source": task["source"], "target": task["target"], "task": task["id"], "cases": kept,
                     "passed": 0, "total": 0, "fix_rounds": 0}
        await _execute_js(run, task, mod_state)
        run.data["verify"]["modules"][task["module"]] = mod_state
        run.log("Verifier", f"{task['source']}: {mod_state['passed']}/{mod_state['total']} behaviours match",
                "done" if mod_state["passed"] == mod_state["total"] else "warn")
        _totals(run)

    run.log("Verifier", "Generating characterization tests, executing legacy Python as ground truth")
    await asyncio.gather(*(one(t) for t in tasks))
    _totals(run)
    v = run.data["verify"]
    run.log("Orchestrator", f"Equivalence: {v['passed']}/{v['total']} behaviours preserved",
            "gate" if v["passed"] < v["total"] else "done")
    run.set_stage("verify", "review" if v["passed"] < v["total"] else "done")


@_guard("verify")
async def fix(run):
    v = run.data["verify"]
    v["round"] += 1
    by_id = {t["id"]: t for t in run.data["tasks"]}

    async def one(module, ms):
        fails = [c for c in ms["cases"] if not c["pass"]]
        if not fails:
            return
        task = by_id[ms["task"]]
        b = run.data["build"][task["id"]]
        ms["fix_rounds"] += 1
        report = "\n".join(
            f"- {c.get('label', '')}: {c['kind']} {c['target']} "
            f"args={json.dumps(c.get('args', c.get('ctor_args')))}"
            + (f" calls={json.dumps(c.get('calls'))}" if c.get("calls") else "")
            + f"\n  legacy Python returned: {json.dumps(c['py'])}\n  your JS returned:       {json.dumps(c['js'])}"
            for c in fails[:12])
        extra = (f"\n\nYour current JavaScript port:\n```javascript\n{b['code']}\n```\n\n"
                 f"DIFFERENTIAL TESTS FAILED. The legacy Python is the source of truth:\n{report}\n\n"
                 "Fix the port so every case matches the Python exactly. Return the full corrected module.")

        async def ok(text):
            return await _write_and_check(run, task, extract_code(text))

        # Start one tier above whatever produced the current code.
        start = max(1, b.get("attempts_used", 1))
        code, r, attempt = await agent_call(run, "builder", stage="verify", task=f"fix {task['source']}",
                                            user=_builder_prompt(run, task, extra), prof=task["profile"],
                                            validate=ok, max_tokens=12000, start_attempt=start, max_attempts=2)
        b.update(code=code, model=r["model"], tier=r["tier"], attempts_used=attempt + 1)
        await _execute_js(run, task, ms)
        run.log("Verifier", f"{task['source']} after fix: {ms['passed']}/{ms['total']}",
                "done" if ms["passed"] == ms["total"] else "warn")
        _totals(run)

    run.log("Orchestrator", f"Fix round {v['round'] - 1}: sending failing behaviours to escalated Builders")
    await asyncio.gather(*(one(k, m) for k, m in v["modules"].items()))
    _totals(run)
    run.log("Orchestrator", f"Equivalence: {v['passed']}/{v['total']} behaviours preserved",
            "done" if v["passed"] == v["total"] else "gate")
    run.set_stage("verify", "done" if v["passed"] == v["total"] else "review")
