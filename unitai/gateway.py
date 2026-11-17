"""The single choke point for every LLM call. Every call is metered in the run ledger."""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
import uuid

import httpx

from . import config


class LLMError(RuntimeError):
    pass


class MissingKey(Exception):
    """Not an LLMError: escalating to another model can't fix a missing key."""


_sem: asyncio.Semaphore | None = None


def _semaphore() -> asyncio.Semaphore:
    global _sem
    if _sem is None:
        _sem = asyncio.Semaphore(config.MAX_PARALLEL)
    return _sem


def _cache_key(model: str, messages: list[dict], max_tokens: int) -> str:
    blob = json.dumps({"m": model, "msg": messages, "mt": max_tokens}, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()


# In-flight calls, for the "Working now" view. id -> {agent, task, model, state, started, ...}
LIVE: dict[str, dict] = {}


async def complete(run, **kw) -> str:
    """Call OpenRouter, record usage + cost in the run ledger, return the text.
    While the call is in flight it is visible in LIVE (queued → thinking)."""
    lid = uuid.uuid4().hex[:8]
    data = getattr(run, "data", None)
    LIVE[lid] = {
        "id": lid, "run_id": data["id"] if data else None, "run_name": data["name"] if data else "Playground",
        "agent": kw["agent"], "task": kw["task"], "model": kw["model"], "tier": kw["tier"], "stage": kw["stage"],
        "attempt": kw.get("attempt", 0), "state": "queued", "started": time.time(), "since": time.time(),
    }
    try:
        return await _complete(run, live=LIVE[lid], **kw)
    finally:
        LIVE.pop(lid, None)


async def _complete(
    run,
    *,
    stage: str,
    agent: str,
    task: str,
    model: str,
    tier: int,
    system: str,
    user: str,
    max_tokens: int = 4000,
    temperature: float = 0.2,
    attempt: int = 0,
    route: dict | None = None,
    live: dict,
) -> str:
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    key = _cache_key(model, messages, max_tokens) if temperature == 0.2 else \
        _cache_key(model, messages + [{"role": "_t", "content": str(temperature)}], max_tokens)
    cache_file = config.CACHE_DIR / f"{key}.json"
    started = time.time()
    replayed = False

    if config.CACHE_ENABLED and cache_file.exists():
        payload = json.loads(cache_file.read_text())
        replayed = True
        live.update(state="replay", since=time.time())
        await asyncio.sleep(0.4)  # keep the live UI legible during replays
    else:
        api_key = config.api_key()
        if not api_key:
            raise MissingKey("OPENROUTER_API_KEY is not set. Add it to .env and run the stage again.")
        body = {
            "model": model,
            "messages": messages,
            # Reasoning models (e.g. DeepSeek V4.1) spend hidden reasoning tokens from this same budget.
            # Headroom costs nothing unless used, and prevents empty/truncated answers.
            "max_tokens": max_tokens + config.REASONING_HEADROOM,
            "temperature": temperature,
            "usage": {"include": True},
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "X-Title": "Eastpac UNITE",
        }
        payload = None
        last_err = ""
        async with _semaphore():
            live.update(state="thinking", since=time.time())
            for retry in range(3):
                try:
                    async with httpx.AsyncClient(timeout=240) as client:
                        r = await client.post(config.OPENROUTER_URL, json=body, headers=headers)
                    if r.status_code == 200:
                        payload = r.json()
                        if payload.get("choices"):
                            break
                        last_err = json.dumps(payload.get("error") or payload)[:300]
                    else:
                        last_err = f"HTTP {r.status_code}: {r.text[:300]}"
                except httpx.HTTPError as e:
                    last_err = f"{type(e).__name__}: {e}"
                await asyncio.sleep(1.5 * (retry + 1))
        if payload is None or not payload.get("choices"):
            raise LLMError(f"{model} failed: {last_err}")

    text = payload["choices"][0]["message"].get("content") or ""
    finish = payload["choices"][0].get("finish_reason")
    truncated = finish == "length" or not text.strip()
    if config.CACHE_ENABLED and not replayed and not truncated:
        cache_file.write_text(json.dumps(payload))  # never cache a broken answer
    usage = payload.get("usage") or {}
    t_in = int(usage.get("prompt_tokens") or 0)
    t_out = int(usage.get("completion_tokens") or 0)
    cached = int((usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0)
    cost = usage.get("cost")
    cost = float(cost) if cost is not None else config.price(model, t_in, t_out)

    run.record_call({
        "id": uuid.uuid4().hex[:8],
        "ts": time.time(),
        "stage": stage,
        "agent": agent,
        "task": task,
        "model": model,
        "tier": tier,
        "tokens_in": t_in,
        "tokens_out": t_out,
        "cached_tokens": cached,
        "cost": cost,
        "baseline_cost": config.price(config.BASELINE_MODEL, t_in, t_out),
        "latency_ms": int((time.time() - started) * 1000),
        "attempt": attempt,
        "escalated": attempt > 0,
        "replayed": replayed,
        "route": route or {},
    })
    if truncated:  # metered above (we paid for it), then rejected so the caller retries
        if replayed:
            cache_file.unlink(missing_ok=True)
        raise LLMError(f"{model} ran out of output tokens before answering (finish_reason={finish}, "
                       f"{t_out} tokens). Retrying.")
    return text


# ---------- output parsing helpers ----------

def extract_json(text: str):
    """Pull the first JSON object out of a model response (fenced or bare)."""
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    candidates = [m.group(1)] if m else []
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        candidates.append(text[start:end + 1])
    for c in candidates:
        try:
            return json.loads(c)
        except json.JSONDecodeError:
            continue
    raise LLMError("Model did not return valid JSON")


def extract_code(text: str, langs=("javascript", "js", "mjs")) -> str:
    blocks = re.findall(r"```([a-zA-Z]*)\s*\n(.*?)```", text, re.S)
    for lang, body in blocks:
        if lang.lower() in langs:
            return body.strip() + "\n"
    if blocks:
        return max((b for _, b in blocks), key=len).strip() + "\n"
    return text.strip() + "\n"


def extract_mermaid(text: str) -> list[dict]:
    """Return [{title, code}] for each ```mermaid block, titled by the nearest heading above it."""
    out = []
    for m in re.finditer(r"```mermaid\s*\n(.*?)```", text, re.S):
        before = text[: m.start()]
        heads = re.findall(r"^#+\s*(.+)$", before, re.M)
        title = heads[-1].strip() if heads else f"Diagram {len(out) + 1}"
        out.append({"title": title, "code": m.group(1).strip()})
    return out
