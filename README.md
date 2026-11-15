# Stella

**Every answer, accounted for.**

Stella is a local-first, chat-first workbench for teams shipping DeepSeek-powered assistants. It starts from DeepSeek's open-source [chat-demo](https://github.com/deepseek-ai/chat-demo) and turns it into a quality loop: **capture real chats → curate datasets → evaluate retrieval and answers → improve the profile → gate the release**, with a validated fine-tuning data pipeline and an honest account of what DeepSeek does and does not offer.

> Status: early `v0.1.0`. The app, gateway, retrieval, evaluation and release-gate loop are under active construction.

## Why this exists

- DeepSeek's API has **no embeddings and no fine-tuning endpoints**; the useful work is retrieval, evidence, evaluation and data curation, not another model API wrapper.
- Teams evaluating assistants still stitch four tools together: traces in one product, cases in a spreadsheet, evaluation in a CLI, prompts in git, and a gate in CI. Stella makes trace → case → decision one artifact.
- Chat UIs and quality dashboards are usually different products. Stella's chat carries its own receipts: sources, cost, latency, trace and feedback attach to every answer.

## Quickstart

Requirements: **Node 24+** and **pnpm 11+**. No Python, Docker or cluster is required.

```bash
pnpm install
cp .env.example .env.local        # add DEEPSEEK_API_KEY for live mode
pnpm seed                         # create the demo collection and dataset
pnpm dev                          # server :8787, app :8090
```

Open http://127.0.0.1:8090 for the dev server, or:

```bash
pnpm build
pnpm start                        # serves the app and API on http://127.0.0.1:8787
```

Without a key Stella runs in replay/offline mode: traces, datasets and recorded evaluation results remain inspectable, but new model calls fail with an actionable message.

## The loop

1. **Capture** — the gateway in front of `api.deepseek.com` records every request/response, usage, cost, latency and retrieved source.
2. **Curate** — promote any assistant answer (and its sources) to a versioned JSONL test case.
3. **Evaluate** — retrieval metrics, deterministic assertions and a rubric judge with visible calibration; cost per successful answer; per-slice regressions.
4. **Improve** — versioned profiles (model, prompt, retrieval k/rerank/context budget), run comparisons and sweeps.
5. **Gate** — configurable thresholds and regression guards, CI exit codes and a release review artifact (Markdown, JSON, self-contained HTML).
6. **Fine-tune data** — deduplicated, redacted, split SFT/DPO exports with provenance and contamination checks; DeepSeek training is explicitly marked unavailable, with plans for Unsloth, Axolotl, Together or an OpenAI-compatible endpoint.

## Stack

TypeScript on Node 24, Fastify gateway, SQLite (`node:sqlite`, FTS5), React 18 + rspack (the chat-demo fork), Playwright for visual checks. One package, one SQLite file, no external services.

## Documentation

- [`docs/product-facts.md`](docs/product-facts.md) — verified DeepSeek/chat-demo facts and sources
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, data flow, decisions
- [`docs/EVALS.md`](docs/EVALS.md) — metrics, judge design, gates
- [`docs/FINETUNE.md`](docs/FINETUNE.md) — data pipeline and honest limits
- [`UPSTREAM.md`](UPSTREAM.md) — chat-demo fork provenance and sync policy
- [`docs/RESEARCH.md`](docs/RESEARCH.md) — landscape research and why this shape

## License and attribution

MIT. Stella is derived from [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo), Copyright (c) 2026 DeepSeek, also MIT. See [`LICENSE`](LICENSE), [`NOTICE`](NOTICE) and [`UPSTREAM.md`](UPSTREAM.md).
