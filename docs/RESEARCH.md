# Research notes

This is the evidence behind Stella's shape. It was assembled on **2026-11-15**
from the official DeepSeek API documentation, the chat-demo repository, live
HTTP probes, and the evaluation/retrieval literature. Product claims and copy
must stay consistent with [`product-facts.md`](./product-facts.md).

## 1. The DeepSeek API is a model + tools platform, not an ML platform

- Two models: `deepseek-flash` (DeepSeek-V4.1-Flash-1017) and `deepseek-v4-pro`
  (DeepSeek-V4-Pro-0813); 1M context, up to 384K output; thinking on by default.
  [pricing](https://api-docs.deepseek.com/quick_start/pricing),
  [thinking](https://api-docs.deepseek.com/guides/thinking_mode)
- Flash pricing per 1M tokens (off-peak / peak): cache hit $0.003/$0.006,
  cache miss $0.15/$0.30, output $0.60/$1.20. Peak is Mon–Fri 01:00–04:00 and
  06:00–10:00 UTC. [pricing](https://api-docs.deepseek.com/quick_start/pricing)
- The Anthropic-compatible surface is first-class, with DeepSeek extensions
  (`thinking`, server web tools, `safety_check`, `title`, `latest_reminder`,
  files beta). [guide](https://api-docs.deepseek.com/guides/anthropic_api)
- Search and Fetch are directly callable (`/v1/tools/search`, `/v1/tools/fetch`)
  at $0.75 per 1,000 successful requests. [search](https://api-docs.deepseek.com/guides/search)
- OCR is directly callable (`/v1/tools/ocr`) and returns per-page text at
  $0.225 per 1,000 pages. The Files API parses documents for chat but **does not
  let you download original or parsed text**, so OCR is the extraction path.
  [OCR](https://api-docs.deepseek.com/guides/ocr),
  [files](https://api-docs.deepseek.com/guides/files_api)
- There is **no embeddings endpoint** and **no fine-tuning endpoint** in the
  official API documentation (sitemap and API reference checked 2026-11-15).
- Structured grading is reliable through the Responses API JSON schema
  (`text.format`); Chat Completions only offers `json_object`, and the Anthropic
  compatibility layer ignores `output_config`.
  [responses](https://api-docs.deepseek.com/guides/responses_api),
  [JSON](https://api-docs.deepseek.com/guides/json_mode)
- The API is stateless: no stored conversations, batches, or request logs.
  Automatic prefix caching is best-effort and cleared within hours/days.
  [KV cache](https://api-docs.deepseek.com/guides/kv_cache)
- CORS reflects arbitrary origins with credentials (verified preflight). A
  browser-only app therefore exposes its key; a local gateway is the right place
  to hold it and to record traces.

**Consequence:** `embeddings RAG` needs a local or third-party embedder;
fine-tuning must be an external provider; eval runs are N parallel requests and
the cheap levers are off-peak pricing and cache hits. Stella's honest boundary
table follows directly from this.

## 2. chat-demo is a client, and a good one to fork

- MIT, static React 18 + rspack app, ~2k stars at the time of research, created
  2026-11-12. No backend, no router, no tests. [repo](https://github.com/deepseek-ai/chat-demo)
- The API origin is a build-time constant; building with an empty origin and
  serving `dist/` from the gateway makes every call same-origin.
- It consumes the Anthropic-compatible SSE protocol with DeepSeek extensions and
  re-sends the full visible history each turn. Unknown SSE payload types are
  dropped, but the whole `usage` object is persisted on the assistant message —
  which lets the gateway attach provenance (`lantern_trace_id`,
  `lantern_sources`, cost/latency) with no extra round trip.
- The message surface is rich (branches, attachments, markdown/KaTeX/Mermaid,
  read-aloud, history import/export). Rebuilding it from scratch would take
  weeks and lose the point.

**Consequence:** fork the app, preserve upstream paths, and add a Stella layer
(rail, workbench, provenance, profile chip). Keep upstream edits small and
documented.

## 3. The market moved upmarket; the local-first loop is the gap

- Consolidation: Humanloop was acquired by Anthropic and the platform sunset in
  September 2025 ([notice](https://humanloop.com/docs/v5/changelog/2025/08));
  promptfoo joined OpenAI in March 2026
  ([post](https://www.promptfoo.dev/blog/promptfoo-joining-openai/)); Langfuse
  self-hosting requires Postgres + Redis + ClickHouse + S3
  ([architecture](https://langfuse.com/self-hosting)); LangSmith lists seat +
  usage pricing ([pricing](https://www.langchain.com/pricing)).
- Local-first demand is visible: a Show HN "SQLite, no accounts, fully offline"
  traces tool reported 800+ downloads in two days
  ([HN](https://news.ycombinator.com/item?id=48063206)).
- Judge inflation is the trust killer: Ragas issue #2992 documents a judge that
  emits one verdict for a multi-statement answer and can print a perfect score
  on junk data ([issue](https://github.com/vibrantlabsai/ragas/issues/2992)).
- Retrieval is still the bottleneck even with 1M-token context: chunking destroys
  document metadata and similarity retrieval is not the same as covering all
  required evidence ([ACL 2026](https://aclanthology.org/2026.findings-emnlp.2222/),
  [Chroma chunking study](https://www.trychroma.com/research/evaluating-chunking),
  [Anthropic contextual retrieval](https://www.anthropic.com/news/contextual-retrieval)).

**Consequence:** do not build another cloud dashboard. Build the loop in one
local artifact: trace → case → eval → gate, with uncertainty visible and no
single magic score. The wedge is release evidence a product lead can read.

## 4. Retrieval defaults chosen from the literature

- Structure-aware chunks (~350 tokens target, 500 cap), heading breadcrumbs,
  no overlap above the embedding window; parent-section expansion when passing
  context to the model.
- Hybrid-ready: FTS5 BM25 (k1/b fixed by SQLite) with title/breadcrumb/code-token
  boosts and an RRF fusion hook for future dense retrieval. FTS5 query syntax
  must be escaped (`C++` is a syntax error) and code identifiers need a
  pre-tokenized shadow column (`getUserName` is one token under `unicode61`).
- Optional listwise LLM rerank: cheap off-peak, useful quality lever, recorded in
  the run config and cached.
- Citations are validated deterministically against the exact injected sources;
  retrieval metrics use gold anchors resolved by document/heading, so corpus
  drift is visible.

## 5. Evaluation defaults chosen from the literature

- Retrieval metrics: recall@k, precision@k, MRR, nDCG@k (formulas in
  [`EVALS.md`](./EVALS.md)); macro over cases, because corpus-level averages hide
  failed queries.
- Judge: pointwise rubric, thinking disabled, recorded model/prompt hash,
  calibration against a labelled set with agreement and Cohen's κ. Calibration
  is advisory by default and explicitly labelled when the labels are seed labels.
- Statistics: Wilson intervals and paired bootstrap (10,000 resamples, seeded);
  small-slice regressions are advisory.
- CI: replay recorded HTTP, never live calls; a missing cassette fails loudly.
  DeepSeek has no seed parameter and thinking mode ignores temperature, so
  sampling settings cannot make CI deterministic.

## 6. Naming

"Stella" is the name of chat-demo's default read-aloud voice, which gives the
fork a nice internal continuity. It is also a common product name; there are
existing companies/products using it, so a trademark and domain check is
required before any public launch. The repository and CLI use `stella`.

## Open questions

- Which dense embedding provider teams actually have (local ONNX vs an
  OpenAI-compatible endpoint) — the adapter is designed for either; v1 is lexical
  by default so the product works offline.
- How often product leads open the review artifact without a meeting — the demo
  is the test; the artifact is designed to stand alone.
- Whether DeepSeek will ship embeddings or fine-tuning; if it does, the adapters
  make this a configuration change, not a rewrite.

## References

- DeepSeek API: pricing, Anthropic compatibility, Responses/JSON, KV cache,
  Files, OCR, Search/Fetch, thinking mode (links inline above).
- chat-demo: <https://github.com/deepseek-ai/chat-demo>
- Retrieval: <https://aclanthology.org/2026.findings-emnlp.2222/>,
  <https://www.trychroma.com/research/evaluating-chunking>,
  <https://www.anthropic.com/news/contextual-retrieval>,
  <https://sqlite.org/fts5.html>,
  <https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf>
- Evaluation: <https://arxiv.org/abs/2309.15217> (RAGAS),
  <https://papers.nips.cc/paper_files/paper/2023/hash/91f18a1287b398d378ef22505bf41832-Abstract-Datasets_and_Benchmarks.html>
  (MT-Bench / LLM-as-judge), <https://arxiv.org/abs/2411.00640> (statistical
  reporting), <https://github.com/vibrantlabsai/ragas/issues/2992>
- Market: <https://humanloop.com/docs/v5/changelog/2025/08>,
  <https://www.promptfoo.dev/blog/promptfoo-joining-openai/>,
  <https://www.langchain.com/pricing>, <https://langfuse.com/self-hosting>,
  <https://news.ycombinator.com/item?id=48063206>
