# Architecture

Stella is a local-first, chat-first workbench for teams shipping DeepSeek
assistants. It is a fork of [chat-demo](https://github.com/deepseek-ai/chat-demo)
with a gateway, retrieval layer, evaluation runner and fine-tuning data pipeline
built around it. One process, one SQLite file, no external services.

## Component map

| Layer | Location | Responsibility |
| --- | --- | --- |
| Chat app | `src/` (forked chat-demo) | Streaming chat, branches, attachments, markdown/KaTeX/Mermaid, history, themes, i18n. |
| Stella workbench | `src/stella/` | Rail/navigation, provenance strip, Quality, Traces, Datasets, Runs, Improve pages. |
| Gateway | `server/src/gateway/` | Proxies `/models`, `/anthropic/v1/*`, `/v1/tools/*`; injects RAG context; records traces; injects provenance into streaming usage. |
| Providers | `server/src/providers/` | Canonical chat client (live/replay), Responses JSON-schema caller, cassette replay. |
| Retrieval | `server/src/rag/`, `server/src/ingest/` | Parsing, chunking, FTS5/BM25, optional rerank, context packing, citations, collections API. |
| Evaluation | `server/src/evals/` | Datasets, profiles, run executor, graders, judge, statistics, gates. |
| Fine-tuning data | `server/src/finetune/` | SFT/DPO export, filters, splits, contamination checks, provider plans. |
| CLI | `server/src/cli/` | `stella serve|doctor|seed|ingest|search|eval|gate|finetune|demo`. |
| Shared contracts | `shared/` | Types, pricing, statistics, ids. |

## Chat request path

```
browser (chat-demo, same origin)
  POST /anthropic/v1/messages
        │
        ▼
Fastify gateway ── resolve published profile ── retrieve(collection, query, k, rerank)
        │                                            │
        │◄──────────── sources + context ─────────────┘
        │
        ├── append numbered source block to the final user message
        ├── create trace id, record request/sources
        ▼
  https://api.deepseek.com/anthropic/v1/messages
        │  SSE: message_start … message_delta … message_stop
        ▼
  byte-faithful passthrough, but message_start/message_delta usage gains
  lantern_trace_id, lantern_sources, lantern_cost_usd, lantern_latency_ms,
  lantern_pricing_basis
        │
        ▼
browser stores the whole usage object; the message renders a provenance strip
(trace/feedback/make-test-case) without an extra request.

After completion the gateway writes traces/trace_sources/sessions to SQLite.
```

Why mutate only the final user message: chat-demo re-sends the full visible
history every turn. Appending to the last user turn is stateless (the client
keeps the original), preserves the cacheable prefix for DeepSeek's automatic
cache, and never touches assistant thinking/signature blocks that must be
replayed verbatim.

## Evaluation path

```
profile + dataset version
        │
        ▼
eval runner (queued, budgeted, concurrency-limited)
  for each case: retrieve → build request → provider (live/replay) → answer
     ├── deterministic graders (contains, regex, JSON, citation validity, refusal, budget)
     ├── retrieval metrics vs gold anchors (recall@k, precision@k, MRR, nDCG@k)
     └── LLM judge (Responses JSON schema, rubric judge-v1) + calibration
        │
        ▼
run_items + run summary (Wilson CI, paired bootstrap vs baseline, slices,
cost per passing answer, p50/p95 latency, grader error rate)
        │
        ▼
gate: thresholds + regression rules + judge rules → gate.md / gate.json / review.html
```

The chat path and the eval path share the same retrieval and prompt builder so a
run measures what production would do, not a separate harness.

## Data model

SQLite (`data/stella.db`, WAL) with tables for collections, documents, chunks,
`chunks_fts` (FTS5), embeddings (optional adapter), sessions, traces,
trace_sources, datasets, dataset_versions, cases, profiles, runs, run_items,
gates, finetune_exports, finetune_jobs, jobs, events, settings.

- Datasets are **git-native**: snapshots are immutable JSONL files under
  `datasets/<name>/<version>.jsonl` with a manifest (content hash, counts,
  anchor resolution, drift). The database is an index, not the source of truth.
- Runs store their own retrieved sources and answers, so historical results stay
  interpretable after the corpus changes.
- Traces are the capture layer; datasets are the reviewed subset; runs are the
  decision layer.

## Fork strategy

The upstream `src/` layout is preserved. Product code lives in `src/stella/`;
server code in `server/`; shared contracts in `shared/`. Upstream edits are
limited and listed in [`UPSTREAM.md`](../UPSTREAM.md). The upstream commit is
pinned; sync is a diff/cherry-pick exercise, not a merge of history.

Key upstream edits:

- build with an empty API origin so the gateway is same-origin (no CORS, key
  stays server-side);
- a Stella rail/router and workbench pages around the chat view;
- provenance strip and feedback/promote actions on assistant messages;
- profile chip in the composer;
- a Stella settings tab for gateway key status, active profile and retention.

## Key decisions

| Decision | Why |
| --- | --- |
| TypeScript on Node 24, one package | chat-demo is TypeScript; Node 24 runs server TS with type stripping and has `node:sqlite`/FTS5. No second runtime to deploy. |
| Fastify + `@fastify/static` + multipart | Raw stream passthrough, static app, file uploads; small surface. |
| SQLite + FTS5; no vector DB | Local-first, zero services, fast enough for the target corpus. Dense retrieval is an adapter, not a dependency. |
| Server-held key, same-origin gateway | DeepSeek CORS is open and browser-held keys leak. The gateway is also the only place that can capture complete traces. |
| Publish-to-chat profiles | Product work is versioned and gated, not a prompt pasted into a UI. |
| Replay for CI, live for quality | DeepSeek has no seed parameter and thinking mode ignores temperature; deterministic CI must replay recorded HTTP, and replay never claims live quality. |
| Honest fine-tuning | DeepSeek has no fine-tuning endpoint. Stella validates/exports data and generates external plans; it never fabricates a tuned-model score. |

## Failure behavior

- No API key: browsing/traces/datasets/replay work; new model calls return an
  actionable error. PDF/URL ingestion needs the DeepSeek Tools API.
- Upstream 4xx/5xx: forwarded in the upstream shape; chat shows the error and
  Settings link; trace records status/error.
- Client abort: upstream is aborted, trace is `aborted`; missing usage is
  estimated and flagged.
- Truncated stream (no `message_stop`): trace is `interrupted`, not a pass.
- Budget exceeded: run cancels with a clear error; partial items remain.
- Judge errors: recorded per grader; gate blocks above the configured error rate.
- Corpus drift: unresolved gold anchors are reported; retrieval metrics exclude
  unresolved anchors while generation metrics remain.

## Security

- Binds to `127.0.0.1` by default. A non-loopback bind requires
  `STELLA_ACCESS_TOKEN`.
- The DeepSeek key is read from `.env.local`/environment and never returned to
  the browser or written to traces/logs. BYOK is supported when no server key is
  configured.
- Same-origin API; mutating routes check the request origin.
- Traces contain user content. Retention defaults to 30 days with a purge
  command; all data is local and exportable.
- Rendered model output is sanitized; files are parsed server-side with size
  limits and path checks.
