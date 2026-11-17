# Eastpac UNITE — *See it. Shape it. Ship it.*

Agentic code migration for Eastpac's **UNITE** programme: legacy **Python → the UNITE JavaScript standard**,
with a human at every gate and every token accounted for.

## Run it

```bash
cp .env.example .env          # paste your OpenRouter key
uv run uvicorn unitai.server:app --port 8000
open http://localhost:8000
```

Needs Python 3.12+ (uv installs it) and Node 20+ (for building and verifying the JS).

## The pipeline

| Stage | Agents | What happens | Gate |
|---|---|---|---|
| 1 · Discover | Cartographer, Scribe ×N, Draftsman | AST static map (**0 tokens**), parallel module docs, UML (static class/deps diagrams + AI component/sequence) | **Gate 1**: human edits docs/diagrams, leaves notes for Architect |
| 2 · Design | Architect (Frontier tier) | Target design on UNITE standard, export mapping (snake→camel), risk register, task DAG with per-task cost estimate | **Gate 2**: toggle tasks, add notes, approve budget |
| 3 · Build | Builder swarm | Parallel waves along dependency DAG; each output is `node --check`ed and export-contract-checked; failure → escalate model | — |
| 4 · Verify | Verifier | LLM designs edge-case inputs → **legacy Python executes them as ground truth** → JS executes same → deep diff. Failures → escalated Builder auto-fix | Human triggers fix |
| 5 · Report | Ledger | Spend by agent / model / stage / tier, savings vs all-Opus, CSV export | — |

## AgentForge (cost control)

- **Personas** (`unitai/forge.py`): prompt, tier range, optional pinned model. Editable live in the UI.
- **Profiler**: deterministic score from size, complexity and risk keywords. No LLM call is needed to choose the LLM.
- **Router**: score → T1 Swift / T2 Balanced / T3 Frontier. Each failed validation escalates one tier.
- **Models (OpenRouter)**: T1 DeepSeek V4.1 Flash · GPT-6 Luna · Claude Haiku 5.5; T2 GPT-6.1 Terra · Claude Sonnet 5.5; T3 GLM 5.3 · GPT-6.1 Sol · Claude Opus 5.5. Defaults: T1 and T2 → DeepSeek V4.1 Flash, T3 → GLM 5.3.
- **Gateway** (`unitai/gateway.py`): the only path to an LLM. It logs tokens, real cost (`usage.cost` from OpenRouter), latency, tier and escalation for every call.
- **Replay cache**: identical prompts are replayed from `data/cache/`. Re-runs are free and the demo is deterministic.

## Demo script (~5 min)

1. **Hook:** "This 2014 banking core has no docs and its author has left. Watch."
2. **Start with the sample.** Run discovery. The Cartographer card reads **$0.00**: static analysis. Scribes swarm in parallel (activity feed on the right).
3. **Gate 1:** open *Modules → money.py* and show the Scribe flagged banker's rounding. Show *Diagrams*. Type a note: *"Preserve banker's rounding: finance signed off."* Approve.
4. **Design:** the Architect runs on Opus (Frontier tier, high stakes). Show the risk register and task cards: each task was routed by score, and most went to cheap T1. Show the cost estimate vs all-frontier. Approve.
5. **Build:** waves run in parallel along the DAG. Click a card to show Python and JS side by side. Point out any escalation trail (DeepSeek → Terra).
6. **Verify:** the ring shows *N/M behaviours preserved*. Show a failure (e.g. `round(0.125)` or `divmod(-7, 3)`). Click **Auto-fix**, the escalated Builder fixes it, and the result is 100% and *drop-in ready*.
7. **Cost report:** "Total $0.0x. **Y% cheaper** than running everything on Opus, and every token is traceable."
8. **Close:** "Eastpac UNITE: see it, shape it, ship it."

Tip: do one full run before presenting. The replay cache makes the live run fast and identical.

## Roadmap (for the pitch)
GitHub import · Docker sandbox per run · strangler-fig adapters · migration playbooks · zero-data-retention routing
· other language pairs (Java 8 → Spring Boot, .NET Framework → .NET 8).
