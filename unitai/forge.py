"""AgentForge: persona registry, task profiler and cost-aware model router."""
from __future__ import annotations

import json
import re

from . import config

UNITE_JS_STANDARD = """UNITE JavaScript Standard (target stack):
- Node.js 20+, native ES modules (`export`/`import`, relative imports end in `.js`). No CommonJS.
- Zero runtime dependencies unless unavoidable; use the standard library.
- camelCase for functions/variables, PascalCase for classes, UPPER_SNAKE for constants.
- JSDoc on every export (@param / @returns / @throws) so editors and reviewers get types.
- Pure functions where possible; no hidden global state; `const` by default.
- Errors: throw subclasses of `Error` with a meaningful `name`; never return error codes.
- Behaviour must be IDENTICAL to the legacy Python, including its quirks (rounding, integer
  division, modulo of negatives, string casing) unless the approved design says otherwise.
"""

PERSONAS: list[dict] = [
    {
        "id": "cartographer", "name": "Cartographer", "glyph": "◎", "stage": "discover",
        "role": "Maps the repository with static analysis",
        "description": "Parses every module with the Python AST: functions, classes, imports, "
                       "complexity. Zero tokens, zero hallucination: the factual backbone.",
        "min_tier": 0, "max_tier": 0, "llm": False,
        "system": "(static analysis, no LLM)",
    },
    {
        "id": "scribe", "name": "Scribe", "glyph": "✎", "stage": "discover",
        "role": "Writes human-readable documentation",
        "description": "Explains each module: purpose, public API, business rules, edge cases "
                       "and language quirks a migration must preserve.",
        "min_tier": 1, "max_tier": 2, "llm": True,
        "system": (
            "You are Scribe, a senior engineer documenting a legacy codebase for a bank's "
            "modernisation programme. Write crisp, accurate Markdown for humans. Never invent "
            "behaviour that is not in the code. Call out business rules and any language-specific "
            "semantics (rounding mode, integer/floor division, modulo of negatives, string methods, "
            "mutability, exceptions) that a port to another language must preserve."
        ),
    },
    {
        "id": "draftsman", "name": "Draftsman", "glyph": "◇", "stage": "discover",
        "role": "Draws UML and architecture diagrams",
        "description": "Class and dependency diagrams are generated statically; Draftsman adds "
                       "component and sequence diagrams for the key business flows.",
        "min_tier": 1, "max_tier": 2, "llm": True,
        "system": (
            "You are Draftsman, a software architect who draws precise Mermaid diagrams. "
            "Only use valid Mermaid syntax (flowchart, sequenceDiagram). Keep node ids "
            "alphanumeric, put labels in double quotes, avoid parentheses inside unquoted labels."
        ),
    },
    {
        "id": "architect", "name": "Architect", "glyph": "△", "stage": "design",
        "role": "Designs the target architecture and plan",
        "description": "Turns approved docs into a target design aligned to the UNITE standard, "
                       "an export mapping, a risk register and a task DAG for the build swarm.",
        "min_tier": 3, "max_tier": 3, "llm": True,
        "system": (
            "You are Architect, principal engineer on Eastpac's UNITE programme, which migrates "
            "legacy services onto one uniform, maintainable stack.\n\n" + UNITE_JS_STANDARD +
            "\nYou design migrations that are safe, incremental and drop-in compatible."
        ),
    },
    {
        "id": "builder", "name": "Builder", "glyph": "▣", "stage": "build",
        "role": "Implements the migration (swarm)",
        "description": "One Builder per task, run in parallel waves along the dependency DAG. "
                       "Output is syntax-checked and export-checked; failures escalate the model.",
        "min_tier": 1, "max_tier": 3, "llm": True,
        "system": (
            "You are Builder, an expert Python-to-JavaScript migration engineer.\n\n"
            + UNITE_JS_STANDARD +
            "\nReturn ONLY one ```javascript code block containing the complete module."
        ),
    },
    {
        "id": "verifier", "name": "Verifier", "glyph": "✓", "stage": "verify",
        "role": "Proves old and new behave identically",
        "description": "Designs adversarial test inputs, executes them against the legacy Python "
                       "and the new JavaScript, and diffs every result.",
        "min_tier": 1, "max_tier": 2, "llm": True,
        "system": (
            "You are Verifier, a test engineer specialising in characterization and differential "
            "testing of migrations. You hunt for inputs where a naive port would diverge: .5 "
            "rounding (Python uses banker's rounding), floor division and modulo with negatives, "
            "str.title()/split() semantics, empty inputs, boundaries, and error paths."
        ),
    },
]

ROLES = ["scribe", "draftsman", "architect", "builder", "verifier"]  # pipeline slots an LLM persona can fill
EDITABLE = ("name", "glyph", "role", "description", "system", "model_override", "min_tier", "max_tier",
            "temperature", "max_tokens")
FORGE_FILE = config.DATA_DIR / "forge.json"

_overrides: dict[str, dict] = {}   # builtin persona id -> edited fields
_custom: list[dict] = []           # user-created personas
_bindings: dict[str, str] = {}     # pipeline role -> persona id filling it


def _load() -> None:
    if FORGE_FILE.exists():
        try:
            d = json.loads(FORGE_FILE.read_text())
        except json.JSONDecodeError:
            return
        _overrides.update(d.get("overrides", {}))
        _custom.extend(d.get("custom", []))
        _bindings.update(d.get("bindings", {}))
        for k, v in d.get("tiers", {}).items():
            if v in config.MODELS:
                config.TIER_MODELS[int(k)] = v


def save() -> None:
    FORGE_FILE.write_text(json.dumps({"overrides": _overrides, "custom": _custom, "bindings": _bindings,
                                      "tiers": config.TIER_MODELS}, indent=1))


def _defaults(p: dict) -> dict:
    q = {"temperature": 0.2, "max_tokens": None, "model_override": None, "custom": False}
    q.update(p)
    return q


def personas() -> list[dict]:
    out = []
    for p in PERSONAS:
        q = _defaults(p)
        q.update(_overrides.get(p["id"], {}))
        out.append(q)
    out += [_defaults(p) for p in _custom]
    for q in out:
        slot = q.get("acts_as") or q["id"]
        q["acts_as"] = slot
        q["active"] = not q["llm"] or binding(slot) == q["id"]
    return out


def binding(role: str) -> str:
    return _bindings.get(role, role)


def persona(pid: str) -> dict:
    return next(p for p in personas() if p["id"] == pid)


def for_role(role: str) -> dict:
    """The persona currently filling a pipeline role (a builtin, or a custom one bound to it)."""
    try:
        return persona(binding(role))
    except StopIteration:
        return persona(role)


def set_override(pid: str, data: dict) -> None:
    allowed = {k: v for k, v in data.items() if k in EDITABLE}
    for k in ("min_tier", "max_tier"):
        if k in allowed:
            allowed[k] = max(1, min(3, int(allowed[k])))
    if "temperature" in allowed:
        allowed["temperature"] = max(0.0, min(1.5, float(allowed["temperature"])))
    if allowed.get("model_override") == "":
        allowed["model_override"] = None
    if "min_tier" in allowed or "max_tier" in allowed:
        cur = persona(pid)
        lo = allowed.get("min_tier", cur["min_tier"])
        hi = allowed.get("max_tier", cur["max_tier"])
        if lo > hi:
            allowed["max_tier"] = lo
    custom = next((p for p in _custom if p["id"] == pid), None)
    if custom:
        custom.update(allowed)
    else:
        _overrides.setdefault(pid, {}).update(allowed)
    save()


def reset(pid: str) -> None:
    _overrides.pop(pid, None)
    save()


def create(base_id: str, name: str) -> dict:
    base = persona(base_id)
    if not base["llm"]:
        raise ValueError("Cartographer is static analysis; clone an LLM persona instead")
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "persona"
    pid, n = slug, 2
    existing = {p["id"] for p in personas()}
    while pid in existing:
        pid, n = f"{slug}-{n}", n + 1
    p = {k: base[k] for k in ("glyph", "stage", "role", "description", "min_tier", "max_tier", "llm", "system",
                              "temperature", "max_tokens", "model_override")}
    p.update(id=pid, name=name, custom=True, acts_as=base["acts_as"], cloned_from=base["name"])
    _custom.append(p)
    save()
    return persona(pid)


def delete(pid: str) -> None:
    _custom[:] = [p for p in _custom if p["id"] != pid]
    for role, bound in list(_bindings.items()):
        if bound == pid:
            _bindings.pop(role)
    save()


def bind(role: str, pid: str) -> None:
    if role not in ROLES:
        raise ValueError(f"Unknown role {role}")
    p = persona(pid)
    if p["acts_as"] != role:
        raise ValueError(f"{p['name']} is a {p['acts_as']} persona, not a {role}")
    if pid == role:
        _bindings.pop(role, None)
    else:
        _bindings[role] = pid
    save()


# ---------------- Profiler ----------------

RISK_WORDS = re.compile(
    r"\b(interest|balance|amount|cents|rate|fee|payment|repay|loan|money|round|decimal|"
    r"auth|password|token|crypto|secret|account|withdraw|deposit|tax)\b", re.I)


def profile(text: str, complexity: int = 0) -> dict:
    """Cheap, deterministic task profile. No LLM call needed to decide which LLM to call."""
    size = max(1, len(text) // 4)
    risk_hits = len(set(m.lower() for m in RISK_WORDS.findall(text)))
    s_size = min(1.0, size / 5000)
    s_cx = min(1.0, complexity / 30)
    s_risk = min(1.0, risk_hits / 8)
    score = round(0.35 * s_size + 0.35 * s_cx + 0.30 * s_risk, 3)
    return {
        "size_tokens": size, "complexity": complexity, "risk_hits": risk_hits,
        "score": score,
        "base_tier": 1 if score < 0.33 else 2 if score < 0.66 else 3,
    }


def route(pid: str, prof: dict | None = None, attempt: int = 0) -> dict:
    """Pick a tier + model for a persona/task. Each failed attempt escalates one tier."""
    p = persona(pid)
    base = (prof or {}).get("base_tier", p["min_tier"])
    tier = max(p["min_tier"], min(p["max_tier"], base + attempt))
    model = p.get("model_override") or config.TIER_MODELS[tier]
    reason = f"score {prof['score']:.2f} → T{base}" if prof else f"persona default T{p['min_tier']}"
    if attempt:
        reason += f", escalated +{attempt} after failure"
    if tier != base + attempt:
        reason += f", clamped to T{tier}"
    if p.get("model_override"):
        reason += " (pinned model)"
    return {"tier": tier, "model": model, "reason": reason, "profile": prof or {},
            "persona": p["id"], "slot": p.get("acts_as") or p["id"]}


def estimate(model: str, tokens_in: int, tokens_out: int) -> float:
    return config.price(model, tokens_in, tokens_out)


def dumps(obj) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False)


_load()
