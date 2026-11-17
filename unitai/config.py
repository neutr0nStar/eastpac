"""Model catalogue, tiers and global settings for Eastpac UNITE."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

DATA_DIR = ROOT / "data"
RUNS_DIR = DATA_DIR / "runs"
CACHE_DIR = DATA_DIR / "cache"
SAMPLES_DIR = ROOT / "samples"
WEB_DIR = ROOT / "web"
for d in (RUNS_DIR, CACHE_DIR):
    d.mkdir(parents=True, exist_ok=True)

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
def api_key() -> str:
    """Re-read .env if the key is missing, so adding it doesn't need a restart."""
    if not os.getenv("OPENROUTER_API_KEY"):
        load_dotenv(ROOT / ".env", override=True)
    return os.getenv("OPENROUTER_API_KEY", "")
# Replay identical prompts from disk (saves money on re-runs, makes demos deterministic).
CACHE_ENABLED = os.getenv("UNITAI_CACHE", "1") == "1"
MAX_PARALLEL = int(os.getenv("UNITAI_MAX_PARALLEL", "6"))
# Extra output budget for models that reason before answering (billed only if actually used).
REASONING_HEADROOM = int(os.getenv("UNITAI_REASONING_HEADROOM", "16000"))

# Prices in USD per 1M tokens (from OpenRouter /api/v1/models, Nov 2026).
# Used as a fallback when the API response doesn't include `usage.cost`,
# and to price the "everything on the premium model" baseline.
MODELS: dict[str, dict] = {
    "deepseek/deepseek-v4.1-flash-1017": {
        "label": "DeepSeek V4.1 Flash", "vendor": "DeepSeek", "tier": 1, "in": 0.036, "out": 0.50},
    "openai/gpt-6-luna": {
        "label": "GPT-6 Luna", "vendor": "OpenAI", "tier": 1, "in": 0.10, "out": 0.50},
    "anthropic/claude-haiku-5.5": {
        "label": "Claude Haiku 5.5", "vendor": "Anthropic", "tier": 1, "in": 0.10, "out": 0.50},
    "z-ai/glm-5.3": {
        "label": "GLM 5.3", "vendor": "Z.ai", "tier": 3, "in": 0.07, "out": 1.40},
    "openai/gpt-6.1-terra": {
        "label": "GPT-6.1 Terra", "vendor": "OpenAI", "tier": 2, "in": 1.00, "out": 5.00},
    "anthropic/claude-sonnet-5.5": {
        "label": "Claude Sonnet 5.5", "vendor": "Anthropic", "tier": 2, "in": 2.00, "out": 10.00},
    "openai/gpt-6.1-sol": {
        "label": "GPT-6.1 Sol", "vendor": "OpenAI", "tier": 3, "in": 2.00, "out": 10.00},
    "anthropic/claude-opus-5.5": {
        "label": "Claude Opus 5.5", "vendor": "Anthropic", "tier": 3, "in": 4.00, "out": 20.00},
}

TIER_NAMES = {1: "Swift", 2: "Balanced", 3: "Frontier"}

# Mutable at runtime from the AgentForge screen.
TIER_MODELS: dict[int, str] = {
    1: "deepseek/deepseek-v4.1-flash-1017",
    2: "deepseek/deepseek-v4.1-flash-1017",
    3: "z-ai/glm-5.3",
}

# What we compare against: "if every call had gone to the most capable model".
BASELINE_MODEL = "anthropic/claude-opus-5.5"


def price(model: str, tokens_in: int, tokens_out: int) -> float:
    m = MODELS.get(model)
    if not m:
        return 0.0
    return (tokens_in * m["in"] + tokens_out * m["out"]) / 1_000_000
