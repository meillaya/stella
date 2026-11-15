# Stella demo — seven steps from a bad answer to a gated release

Last updated: 2026-11-15 · Applies to: Stella v0.1.0 · Corpus: Meridian (fictional demo product)

This is the scripted demo narrative for Stella. It runs against the bundled **Meridian field
operations** knowledge base (`corpus/meridian/`, 16 docs) and the 40-case **support** gold suite
(`datasets/support/0001.jsonl`). The story: a user asks a policy question, the answer is wrong
because the assistant retrieved a **superseded refund policy**, the failure is captured as a
test case, the release gate blocks, an improved retrieval profile is published, the gate passes,
and a validated fine-tune dataset is exported for external training.

> **Honest boundary up front.** As of 2026-11-15 the DeepSeek API has **no fine-tuning
> endpoint** (`docs/product-facts.md`). Stella produces validated training data and provider
> plans; it does not train models. Any training execution is external (Unsloth, Axolotl,
> Together, or an OpenAI-compatible endpoint), and Stella never reports a "tuned model" score it
> did not measure.
>
> **Replay boundary.** A replay run proves mechanics (gate, statistics, artifacts) — never live
> model quality. Live runs are the only source of quality claims. A missing cassette fails
> loudly; replay never fabricates an answer.

## Legend and prerequisites

| Tag | Meaning |
| --- | --- |
| `[local]` | Local-only command; no model calls (seed, ingest, search over FTS, dataset snapshot, gate over recorded runs, fine-tune preflight/export). |
| `[live]` | Requires `DEEPSEEK_API_KEY` in `.env.local`; produces live traces and runs. |
| `[replay]` | Serves recorded cassettes; deterministic, keyless, labelled replay. |

```bash
# one-time setup
pnpm install
cp .env.example .env.local        # add DEEPSEEK_API_KEY for live parts
pnpm seed                         # demo collection, dataset version, both profiles [local]
pnpm dev                          # server :8787, app :8090; open http://127.0.0.1:8090
stella doctor                     # confirm key, data dir, DB schema, counts [local]
```

`pnpm seed` (equivalently `stella seed`) creates the demo collection from `corpus/meridian/`,
imports `datasets/support/0001.jsonl`, and publishes the two demo profiles:

- **Support baseline** — `deepseek-flash`, retrieval k=3, rerank off, prompt `rag-v1`.
- **Support grounded** — `deepseek-flash`, retrieval k=6, rerank on, prompt `rag-v2` with an
  explicit citation instruction.

If seeding is skipped, ingest the corpus and snapshot the dataset manually:

```bash
stella ingest corpus/meridian --collection meridian        # [local]
stella search "refund window" --collection meridian --k 6  # [local] sanity-check retrieval
stella dataset snapshot support --notes "demo baseline v1" # [local]
```

> CLI command/flag names are **as of v0.1.0** and still provisional; run `stella help` (or
> `./bin/stella help`) before a live recording session. API routes referenced below are stable
> in `docs/API.md`.

---

## Step 1 — Ask a question and read the provenance `[live]`

In the app, switch the profile chip to **Support baseline** and ask:

> "We're about to renew our annual plan. What's our refund window if we cancel?"

The chat answers with a citation. Open the source chips and the trace panel:

- **Sources:** `policies/billing-refunds.md` (v3.2, superseded) and possibly
  `release-notes/2026-10.md` — naive retrieval prefers the keyword-dense old policy page.
- **Trace:** model, profile, retrieval on/off, latency, TTFB, token usage, cost, pricing basis.
- **Provenance:** every answer carries sources, cost and trace id; the gateway adds
  `usage.lantern_trace_id` and `usage.lantern_sources` to the streaming usage.

Replay equivalent:

```bash
pnpm demo:replay        # or: stella demo --replay
```

Expected: the baseline answer quotes the **old** policy (a 30-day window and a 12%
administration fee). The current policy is in `release-notes/2026-10.md` (v4.0, effective
2026-11-01): **14 days** full refund, **5%** administration fee between day 15 and day 75.
This is the seeded stale-policy trap.

## Step 2 — Thumbs-down the trace and annotate it `[live]`

In the chat, click **thumbs-down** on the answer and add an annotation such as
"cites the superseded v3.2 refund policy; current policy is v4.0 (release-notes/2026-10.md)".
The feedback and annotation attach to the trace and appear in the review queue.

API equivalent (`docs/API.md`):

```bash
curl -s -X PATCH http://127.0.0.1:8787/api/traces/<trace-id> \
  -H "Content-Type: application/json" \
  -d '{"feedback":"down","annotation":"cites superseded v3.2 refund policy; current is v4.0"}'
```

## Step 3 — Promote the trace into a test case `[live]` → `[local]`

In the trace view, choose **Promote to test case** and target dataset **support**. Stella creates
a **draft** `DatasetCase` carrying the question and the retrieved sources as gold anchors. Then
snapshot a new immutable dataset version:

```bash
stella dataset snapshot support --notes "add promoted refund case (step 3)"   # [local]
```

API equivalent:

```bash
curl -s -X POST http://127.0.0.1:8787/api/traces/<trace-id>/promote \
  -H "Content-Type: application/json" -d '{"datasetId":"<support-dataset-id>"}'
curl -s -X POST http://127.0.0.1:8787/api/datasets/<support-dataset-id>/snapshot \
  -H "Content-Type: application/json" -d '{"notes":"add promoted refund case (step 3)"}'
```

Expected: dataset `support` version 2, with the promoted case marked as a draft until
validated. The demo suite (`datasets/support/0001.jsonl`) already contains the same trap as
`sup-0026`/`sup-0027`, so this step demonstrates trace→case without changing the seeded numbers.

## Step 4 — Baseline run hits the gate: **BLOCKED** `[live or replay]`

Run the baseline profile on the new dataset version:

```bash
stella eval run --dataset support@2 --profile "Support baseline" --budget 0.50
# optional cheaper off-peak window:
# stella eval run --dataset support@2 --profile "Support baseline" --budget 0.50 --off-peak
```

Then evaluate the gate against the seeded accepted baseline run (the run id printed by
`pnpm seed`; find run ids on the Runs page or via `GET /api/runs`):

```bash
stella gate --baseline <seed-baseline-run> --candidate <baseline-run> --config stella.gate.json
echo "exit code: $?"     # 1 = fail (blocked); 0 = pass; 2 = usage/config error
```

Expected: **gate.md verdict FAIL / BLOCKED**. The `stella.gate.json` thresholds are pass rate
≥ 0.85, faithfulness ≥ 0.85, citation validity ≥ 0.90, refusal accuracy ≥ 0.85, cost/case
≤ $0.01, p95 ≤ 8 s, overall regression ≤ 3 pp, slice regression ≤ 8 pp (n ≥ 8). The baseline
profile fails on the stale-policy and citation slices: it prefers the superseded v3.2 refund and
retention tables and cites less often than the grounded prompt.

Artifacts (written for the candidate run id):

```
data/runs/<candidate-run-id>/gate.md
data/runs/<candidate-run-id>/gate.json
data/runs/<candidate-run-id>/review.html
```

Read them from the Gate page (artifact links) or `GET /api/gates/<gate-id>/artifact?format=md|json|html`.
`review.html` is a self-contained release review suitable for attaching to a release ticket.

> Do not edit the artifacts to change the verdict. If a gate is overridden, `stella.gate.json`
> allows an override but requires a reason; the override is stored in the artifact, not hidden.

## Step 5 — Publish the improved profile: **Support grounded** `[local]` (config only)

In the app: **Profiles → Support baseline → New version**, name it **Support grounded**, set
retrieval `k=6`, rerank `llm`, prompt template `rag-v2` with the explicit citation instruction,
then **Publish**. Or use the API:

```bash
curl -s -X POST http://127.0.0.1:8787/api/profiles \
  -H "Content-Type: application/json" \
  -d '{"name":"Support grounded","parentId":"<support-baseline-profile-id>",
       "spec":{"model":{"id":"deepseek-flash","thinking":true,"effort":"low","maxTokens":4096},
               "retrieval":{"enabled":true,"collection":"meridian","k":6,"candidates":12,
                            "rerank":"llm","contextBudgetTokens":6000,"parentExpansion":true},
               "prompt":{"template":"rag-v2","citationStyle":"bracket"},
               "judge":{"rubric":"judge-v1","passScore":2,"model":"deepseek-flash"}}}'

curl -s -X POST http://127.0.0.1:8787/api/profiles/<new-profile-id>/publish
```

Expected: profile version 2 published, with `Support baseline` history preserved. The change is:
wider retrieval (k=6), LLM listwise rerank so the newer release note outranks the superseded
policy page, and a prompt that requires bracket citations and prefers the most recent policy
version.

## Step 6 — Candidate run passes the gate: **PASS** `[live or replay]`

```bash
stella eval run --dataset support@2 --profile "Support grounded" --budget 1.00
stella eval compare --baseline <baseline-run> --candidate <grounded-run>     # optional view
stella gate --baseline <baseline-run> --candidate <grounded-run> --config stella.gate.json
echo "exit code: $?"    # 0 = PASS
```

Expected: **gate.md verdict PASS** (possibly WARN when judge calibration is advisory). The
pass is not just a higher number: the stale-policy slice now answers from
`release-notes/2026-10.md` (14 days, 5%, 18 months, 30 days, 24 months), citation validity
clears the threshold, and refusal cases do not over-refuse. Compare the artifact to step 4:

```
data/runs/<grounded-run-id>/gate.md
data/runs/<grounded-run-id>/gate.json
data/runs/<grounded-run-id>/review.html
```

Statistics to read in `gate.md`/`review.html`: pass rate with Wilson 95% interval, cost per
successful answer, p50/p95 latency, per-slice pass rate, paired-bootstrap delta with 95% CI,
grader errors, and judge agreement/κ from the calibration set (seed labels: agreement is
advisory until independent human labels exist).

## Step 7 — Export a validated fine-tune dataset and preflight it `[local]`

```bash
stella finetune preflight --dataset support@2 --format sft
stella finetune export   --dataset support@2 --format sft
stella finetune plan     --export <export-id> --target unsloth
```

Expected artifacts:

```
data/finetune/<export-id>/*.jsonl           # SFT rows (also sharegpt and dpo formats)
data/finetune/<export-id>/manifest.json     # stats, filters, splits, provenance, sha256
```

Preflight runs hard-blocking checks: schema, length, exact + MinHash dedupe, PII/secret
redaction, refusal filtering, 80/10/10 splits by source document, and 13-gram contamination
against the evaluation suite. An SFT row is OpenAI/DeepSeek-compatible chat JSONL
(`{"messages":[...]}`); provenance (trace/case/run ids) lives in the manifest, not in the rows.

The provider plan for `unsloth` (or `axolotl` / `together` / `openai-compatible`) is a runnable
external training artifact — a script, YAML config, or job payload. The DeepSeek target returns
an explicit **"not offered by DeepSeek"** result with the documentation link; it never produces
a fake job id.

**What this step does not do:** train a model. DeepSeek has no fine-tuning endpoint on
`api.deepseek.com`; training execution is external. Stella generates validated data and plans,
and can evaluate a tuned endpoint through the `openai-compatible` provider on the same suite —
only after that external training actually happened, and only with the resulting model's real
measurements. Until then, the honest claim is "validated training data + external plan", not
"improved model".

---

## Command summary

| Step | Command | Mode |
| --- | --- | --- |
| 0 | `pnpm install`, `cp .env.example .env.local`, `pnpm seed`, `stella doctor` | local |
| 1 | `pnpm dev` then ask in chat; or `pnpm demo:replay` / `stella demo --replay` | live / replay |
| 2 | UI thumbs-down + annotation, or `PATCH /api/traces/:id` | live |
| 3 | UI promote, or `POST /api/traces/:id/promote`; `stella dataset snapshot support --notes …` | live → local |
| 4 | `stella eval run --dataset support@2 --profile "Support baseline" --budget 0.50`; `stella gate --baseline <seed> --candidate <run> --config stella.gate.json` | live / replay |
| 5 | UI publish **Support grounded**, or `POST /api/profiles` + `POST /api/profiles/:id/publish` | local |
| 6 | `stella eval run --dataset support@2 --profile "Support grounded" --budget 1.00`; `stella gate --baseline <run-a> --candidate <run-b> --config stella.gate.json` | live / replay |
| 7 | `stella finetune preflight --dataset support@2 --format sft`; `stella finetune export …`; `stella finetune plan --export <id> --target unsloth` | local |

Exit codes for `stella gate`: `0` pass, `1` fail, `2` usage/config error — usable directly in CI.

## Recording a real live demo

```bash
stella record demo-live-2026-11-15 --live \
  --dataset support@2 --profile "Support grounded" \
  --out fixtures/demo/recordings/demo-live-2026-11-15
```

Recording requires a real key; `stella record` refuses to run without one. Review
`meta.json`/`events.jsonl` for secrets and personal data before committing, then replay with
`pnpm demo:replay` or `STELLA_MODE=replay stella demo --replay --cassette fixtures/demo/recordings/…`.
The cassette layout (keyed by config + case; JSONL events; metadata including model, profile,
`recorded_at`, and git sha) is specified in [`fixtures/demo/README.md`](../fixtures/demo/README.md).
The hand-written cassette under `fixtures/demo/synthetic/` is labelled synthetic and excluded
from all quality claims; no other fake cassettes are committed.


## Observed live run (2026-11-15)

Command: `./bin/stella demo --live --no-judge --budget 0.40` on `deepseek-flash`
(off-peak). This is the acceptance run for v0.1.0, not a projection:

| Signal | Baseline "Support baseline" | Candidate "Support grounded" |
| --- | --- | --- |
| Pass rate | 23/40 = **57.5%** (95% CI 42.2–71.5%) | 36/40 = **90.0%** (95% CI 76.9–96.0%) |
| Retrieval recall@k | 65.4% | 95.6% |
| Cost per successful answer | $0.00012 | $0.00010 |
| p95 latency | 1583 ms | 1514 ms |

Paired comparison: **+32.5 pp** (95% CI +17.5…+47.5), 13 improved, **0 regressed**,
27 unchanged. Gate: **PASS** (exit 0) with one warning that faithfulness was not
measured because the judge was disabled. Fine-tune preflight: 33 examples
(train 27 / val 3 / holdout 3), 0 duplicates, 0 PII redactions, 0 contamination
(self-suite overlap is a warning, not a hidden pass).

The candidate required two honest improvement iterations: a wider context window
(k=8, 6k tokens) and a prompt that demands exact figures/identifiers and resolves
superseded policy by effective date. The first candidate (k=6, 4k tokens) reached
82.5% and the gate correctly failed it.

A separate **judge-enabled advisory run** scored 33/40 = 82.5% with 70.8% agreement
and Cohen's κ = 0.391 against 24 seed labels. That calibration is too weak to gate
on, so the default demo runs with the deterministic graders and reports the
unmeasured-faithfulness warning rather than hiding it.

### Replay limitation (known, labelled)

`stella record` writes 184 cassettes, but replay cannot reproduce the profile's
LLM rerank: the candidate's recorded prompts came from replay-stable lexical
retrieval, while a replay of the rerank-on profile asks the replay provider for
rerank calls that were never recorded. `stella demo --replay` therefore fails
loudly on the rerank-on candidate. Replay remains a mechanics check for the
lexical path, never a quality claim; the live gate above is authoritative.

## Artifact map

| Artifact | Path | Written by |
| --- | --- | --- |
| Traces, usage, cost, sources | SQLite `data/stella.db`; UI Trace panel | gateway (step 1) |
| Dataset versions and manifests | `datasets/support/` + snapshots; API `GET /api/datasets/:id` | ingestion/promote/snapshot (step 3) |
| Run results | DB runs/items; UI Runs; `GET /api/runs/:id/items` | eval runner (steps 4, 6) |
| Gate review | `data/runs/<run-id>/gate.md`, `gate.json`, `review.html` | gate (steps 4, 6) |
| Fine-tune export | `data/finetune/<export-id>/` JSONL + `manifest.json` | finetune (step 7) |
| Replay cassettes | `data/cassettes/<sha256>.json` (runtime); `fixtures/demo/recordings/<slug>/` (committed demos) | replay provider / `stella record` |

## What not to claim in the demo

- Do not present replay numbers as model quality, and do not call a replay run "live".
- Do not call the exported dataset a tuned model, and do not invent fine-tuning endpoints or
  provider results for DeepSeek.
- Do not add customer logos, testimonials, benchmarks, or real-company data to the Meridian
  corpus; it is a fictional demo product for evaluation practice.
- Do not hide a gate override. The artifact records it with a reason.
