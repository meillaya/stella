# Evaluation methodology

Stella evaluates three things separately and never hides them behind one
"quality score": **retrieval**, **answer behavior**, and **judge trust**.

## Datasets

A dataset is a directory under `datasets/<name>/`:

- `<version>.jsonl` — one case per line, immutable once written;
- `manifest.json` — content hash, case count, slices, anchor resolution, notes,
  corpus version, creation time.

A case:

```json
{
  "id": "support-refunds-001",
  "slices": ["stale-policy"],
  "messages": [{ "role": "user", "content": "What is the refund window for annual plans?" }],
  "expected": {
    "answer": "45 days ...",
    "behavior": "answer",
    "mustContain": ["45 days"],
    "mustNotContain": ["30 days"],
    "anchors": [{ "doc": "release-notes/2026-10.md", "heading": "Policy v4.0" }],
    "minCitations": 1
  },
  "notes": "Supersedes the 30-day policy.",
  "sourceTraceId": "trace_..."
}
```

Gold anchors are resolved against retrieved chunks by document path/title,
heading breadcrumb and optional quote. If an anchor no longer resolves, the
manifest and UI show **corpus drift**; retrieval metrics skip unresolved anchors
and the gate warns. Cases can come from curated traces (`POST
/api/traces/:id/promote`), JSONL import, or the seed suite.

## Retrieval metrics

Computed per case when anchors resolve, macro-averaged over evaluated cases:

- `recall@k = |relevant ∩ top-k| / |relevant|`
- `precision@k = |relevant ∩ top-k| / k` (reported as diagnostic; can be gamed by small k)
- `MRR = mean(1 / rank of first relevant chunk)`
- `nDCG@k = DCG@k / IDCG@k`, `DCG = Σ (2^rel - 1) / log2(i + 1)`, binary relevance by anchor match

k defaults to the profile's retrieval k. Corpus-level aggregation can mask a
query with zero hits, so the run also reports the number of evaluated cases and
the gate uses macro values.

## Deterministic graders

| Grader | Passes when |
| --- | --- |
| `contains` / `not_contains` | normalized answer contains/does not contain every configured phrase |
| `regex` | configured pattern matches |
| `json_valid` | answer parses as JSON and validates against the optional schema (ajv) |
| `citation_valid` | every `[n]` refers to an injected source; no citation when sources are empty |
| `min_citations` | answer cites at least N distinct injected sources |
| `refusal_expected` | behavior `refuse` cases refuse; behavior `answer` cases do not falsely refuse |
| `max_cost_usd` / `max_latency_ms` | per-case budget limits |

A case passes when every **required** grader passes. Grader errors are counted,
not converted to passes.

## Judge

The rubric judge is versioned (`judge-v1`) and called through the DeepSeek
Responses API with a JSON schema; thinking is disabled and temperature is 0.
It returns `{score: 0..3, verdict, reasons, unsupported_claims}`. A configured
`passScore` (default 2) turns it into a pass/fail. Invalid JSON is retried twice;
a persistent failure is a grader error.

Judges are not trusted by default:

- the judge model/version, prompt hash and per-case responses are recorded;
- a calibration set (`datasets/calibration/`) compares judge verdicts to
  seed/human labels and reports **percent agreement and Cohen's κ**;
- the UI shows "seed labels, not independent human labels" until the team adds
  its own;
- `requireCalibration` in the gate config can block on low agreement; by default
  calibration is advisory.
- Pairwise judging is deliberately out of v1; pointwise scores on fixed cases
  plus paired statistics are easier to audit.

## Statistics

- Pass rate is reported with a **Wilson 95% interval**.
- Candidate vs baseline deltas use a **paired bootstrap** over the same cases
  (10,000 resamples, seeded for reproducibility): mean delta, 95% CI, and the
  share of resamples where the candidate is not better.
- Slices report their own case count; regressions in slices below
  `minSliceCases` are advisory.
- Small suites are noisy. `minCases` in the gate config prevents a release from
  being gated on a handful of cases.

## Gate

`stella gate --baseline <run> --candidate <run> --config stella.gate.json`
evaluates absolute thresholds, regression rules and judge rules, then writes:

- `gate.md` — human-readable verdict with evidence;
- `gate.json` — machine-readable result;
- `review.html` — self-contained release review for sharing/archiving.

Exit codes: `0` pass, `1` fail, `2` usage/config error. An override can be
recorded with a reason; it is stored in the artifact, not hidden.

Default config in the repo: pass rate ≥ 0.85, faithfulness ≥ 0.85, citation
validity ≥ 0.90, refusal accuracy ≥ 0.85, cost/case ≤ $0.01, p95 ≤ 8 s, overall
regression ≤ 3 pp, slice regression ≤ 8 pp (n ≥ 8), judge calibration advisory,
grader errors ≤ 10%.

## Replay vs live

- **Live** calls DeepSeek and is the only mode that makes quality claims.
- **Replay** serves recorded HTTP cassettes keyed by request hash. It proves
  mechanics, UI and statistics in CI; a missing cassette fails loudly.
- DeepSeek has no `seed` and ignores temperature in thinking mode, so replay is
  the only CI-safe mechanism.
- Cassettes live in `data/cassettes/` (gitignored); demo cassettes are recorded
  from the user's key and can be committed under `fixtures/demo/` if desired,
  labelled as recorded evidence.

## Cost and latency

Cost uses the final cumulative `message_delta.usage` and the published price
table, including cache hit/miss split and peak/off-peak basis (Mon–Fri
01:00–04:00 and 06:00–10:00 UTC; Chinese holidays are not modelled). Runs report
`cost_per_successful_answer`, p50/p95 generation latency and the judge cost
separately. Off-peak scheduling halves model cost; the UI says so before a run.
