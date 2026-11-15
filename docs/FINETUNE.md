# Fine-tuning data pipeline

## First, the honest part

As of 2026-11-15 the official DeepSeek API at `api.deepseek.com` has **no
fine-tuning endpoint** (see [`docs/product-facts.md`](./product-facts.md)).
Stella therefore does not train models and never reports a "tuned model" score
it did not measure. What Stella does:

1. curates and validates training data from real traces, annotations and runs;
2. exports provider-ready datasets with provenance and contamination checks;
3. generates runnable training plans for external stacks;
4. evaluates a tuned endpoint (if one exists) on the same suite, so the
   Fine-tune-vs-RAG-vs-prompt decision is evidence-based.

The UI says this explicitly next to every export.

## Where the data comes from

- **Curated cases** from a dataset version (question + expected answer).
- **Traces** with thumbs-up/down and annotations.
- **Runs**: passing answers as SFT targets; a passing/failing pair on the same
  case can become a DPO pair.
- **Teacher pass** (planned): ask `deepseek-v4-pro` to answer failing cases,
  judge the result, and propose it as a candidate SFT target for review. Nothing
  is added automatically.

Every example records its source (`trace_id`, `case_id`, run id) in the manifest.

## Formats

SFT (`sft`) — OpenAI/DeepSeek-compatible chat JSONL:

```json
{"messages":[{"role":"system","content":"..."},{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}
```

ShareGPT (`sharegpt`) — for Unsloth/Axolotl templates:

```json
{"conversations":[{"from":"human","value":"..."},{"from":"gpt","value":"..."}]}
```

DPO (`dpo`) — TRL-style preference pairs:

```json
{"prompt":[{"role":"user","content":"..."}],"chosen":"...","rejected":"..."}
```

Metadata (provenance, split, token estimate) goes in `manifest.json`, not in the
training rows, so providers that reject unknown fields can consume the JSONL
directly.

## Filters and preflight

Before export, `stella finetune preflight` runs and can hard-block:

- **Schema**: every row validates against the chosen format; no empty
  assistant/user turns; no duplicated ids.
- **Length**: configurable min/max characters and estimated tokens.
- **Dedupe**: exact normalized hash plus MinHash near-duplicates (5-gram,
  Jaccard ≥ 0.8); duplicates are dropped and counted.
- **PII/secrets**: email, phone, payment-card, IP and API-key patterns are
  redacted; counts are reported. This is a safety net, not a compliance program.
- **Refusals**: refusal-only answers are dropped unless the user explicitly wants
  refusal training data.
- **Quality**: empty/truncated/boilerplate answers and cases that failed their
  graders are excluded by default.
- **Splits**: 80/10/10 by source document, so a document cannot appear in both
  train and validation; split integrity is checked.
- **Contamination**: 13-gram overlap against the evaluation suite. Hard-block
  when the export source differs from the suite; a suite self-check is recorded
  as a warning (exporting your test set for training is a decision, not an
  accident).

The preflight report is shown in the UI and saved next to the export; export
refuses to write when a hard check fails.

## Manifest

```json
{
  "export_id": "ft_...",
  "dataset": "support@3",
  "format": "sft",
  "created_at": 1760000000000,
  "stats": { "examples": 120, "dropped": 7, "duplicates": 3, "piiRedactions": 2,
             "train": 96, "val": 12, "holdout": 12, "contamination": 0,
             "estimatedTokens": 48210 },
  "filters": { "...": "..." },
  "sources": ["trace_...", "case_..."],
  "files": { "jsonl": "...", "sha256": "..." },
  "provider_targets": ["unsloth", "axolotl", "together", "openai-compatible"],
  "honesty": "DeepSeek does not offer fine-tuning; training runs externally."
}
```

## Provider plans and jobs

Stella generates, rather than pretends to run:

- **Unsloth**: a ready-to-run Python script + dataset path (external GPU).
- **Axolotl**: YAML config + dataset path.
- **Together / OpenAI-compatible**: a job payload; the job adapter can submit
  and poll a configured endpoint, tested against a mock server.
- **DeepSeek**: returns an explicit "not offered by DeepSeek" result with the
  docs link. No fake job id.

Tuned endpoints can be evaluated through the `openai-compatible` provider on the
same suite, so the report can compare DeepSeek + RAG + prompt vs a tuned model
on quality, citation validity, refusal correctness, cost and latency.

## Guardrails

- Keep an untouched holdout; do not export the suite you gate on unless you
  accept the contamination warning.
- Re-run the 200-item core suite (format, refusal, grounded QA) after any
  fine-tune; accept no more than a 2 pp drop.
- Prefer RAG/prompt improvements until a fine-tune demonstrably wins on
  cost/quality with citations intact.
- Never train on API keys, secrets or customer data without review; the PII
  filter is a net, not a guarantee.
