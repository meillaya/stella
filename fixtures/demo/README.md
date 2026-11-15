# Demo cassettes — record and replay layout

This directory holds **live demo recordings** for Stella's replay mode. A cassette is the
recorded HTTP exchange between Stella's providers and the DeepSeek API, replayed in CI and in
keyless demos so the loop (chat → trace → case → run → gate → export) works deterministically.

Replay proves **mechanics**, not model quality. A replay run is labelled `mode: replay` in
Stella and its numbers must never be presented as live model quality. A missing cassette fails
loudly (`replay_miss`); Stella never fabricates an answer from a missing recording.

## Layout

```
fixtures/demo/
├── README.md                     # this file
├── recordings/                   # real recordings made with a user's DEEPSEEK_API_KEY
│   └── <recording-slug>/         # e.g. demo-live-2026-11-15
│       ├── meta.json             # provenance for the whole recording
│       ├── index.json            # caseId → event key → sequence
│       └── events.jsonl          # one JSON object per line, one per model call
└── synthetic/
    └── smoke-001/                # hand-written CI fixture, NOT a recording
        ├── meta.json             # "synthetic": true, excluded from quality claims
        └── events.jsonl
```

The live HTTP cassettes that Stella writes automatically under `data/cassettes/<sha256>.json`
are gitignored runtime data. A *demo recording* is the reviewed, committed bundle above: the
same events plus provenance, keyed for deterministic per-case replay of the seeded suite.

## Keys: config + case

Each event is keyed by the **effective request configuration plus the case id**, not by request
hash alone. The key is:

```
sha256(canonical_json({
  caseId,                        # "sup-0026"
  profileHash,                   # sha256 of the published ProfileSpec
  model,                         # "deepseek-flash"
  promptTemplate,                # "rag-v1" | "rag-v2"
  retrieval: { enabled, k, rerank, contextBudgetTokens, parentExpansion },
  messagesSha256,                # sha256 of the final messages array after RAG injection
  stream: true
}))
```

Consequences:

- Changing the profile (model, prompt template, retrieval k/rerank/context budget) invalidates
  the old cassettes; that is intentional — a replay of an old config must not masquerade as a
  new config.
- Two runs of the same case under the same profile reuse the same key, so a whole recording can
  serve repeated demo runs.
- A cassette miss is reported per case and fails the run; it never falls back to live calls in
  `STELLA_MODE=replay`.

## `meta.json` (recording metadata)

```json
{
  "cassette": "demo-live-2026-11-15",
  "synthetic": false,
  "recordedAt": "2026-11-15T14:03:00Z",
  "gitSha": "<40-char commit sha of the Stella checkout used to record>",
  "stellaVersion": "0.1.0",
  "model": "deepseek-flash",
  "profile": "Support grounded",
  "profileId": "prof_…",
  "profileHash": "sha256:…",
  "dataset": "support",
  "datasetVersion": 1,
  "corpus": "corpus/meridian",
  "mode": "live",
  "recordedBy": "<operator initials or name>",
  "caseCount": 40,
  "apiKeyLastFour": "…9f2c",
  "note": "Recorded from a live key on the seeded Support suite. No secrets are stored."
}
```

Rules:

- **Never** write API keys, bearer tokens, or raw request headers into a cassette. Only the
  last four characters of the key may appear, as an operator aid.
- Record from the **seeded** dataset (`datasets/support/`) and corpus (`corpus/meridian/`) so
  the material is reproducible and contains no customer data.
- If a recording includes user-typed chat content, review it for personal data before
  committing. Prefer the seeded demo questions for committed recordings.
- `gitSha` must be the committed checkout the recording was made from; a replay recorded on a
  different build is still useful but must be labelled in the demo notes.

## `index.json`

```json
{
  "cassette": "demo-live-2026-11-15",
  "events": [
    { "caseId": "sup-0001", "key": "sha256:9d1c…", "seq": 1 },
    { "caseId": "sup-0026", "key": "sha256:52ab…", "seq": 2 }
  ]
}
```

`index.json` is an ordering/navigation aid. Replay matches by `key` inside `events.jsonl`; the
index is how the demo runner knows which case to request next.

## `events.jsonl` (one replayable call per line)

```json
{"key":"sha256:9d1c…","caseId":"sup-0001","seq":1,
 "request":{"model":"deepseek-flash","stream":true,
            "messages_sha256":"sha256:…","profile_hash":"sha256:…",
            "retrieval":{"enabled":true,"k":6,"rerank":"llm","contextBudgetTokens":6000}},
 "response":{"status":200,"stopReason":"end_turn",
             "text":"…model answer…","thinking":null,
             "frames":[{"type":"message_start","data":{}},
                       {"type":"content_block_delta","data":{"text":"…"}},
                       {"type":"message_stop","data":{}}]},
 "usage":{"inputTokens":2103,"cacheReadTokens":0,"cacheCreationTokens":0,"outputTokens":214},
 "latencyMs":1840,
 "recordedAt":"2026-11-15T14:03:12Z"}
```

Requirements:

- One JSON object per line; UTF-8; no trailing commas; `\n` line endings.
- `frames` preserve the streaming SSE frames needed to re-render the answer (message_start,
  content_block_delta, message_delta with usage, message_stop). Unknown frame types are kept
  verbatim so the replay provider stays protocol-faithful.
- `usage` is the final cumulative usage from `message_delta`; cost is recomputed by Stella
  from the price table, not trusted from the cassette.
- `latencyMs` is the recorded wall-clock generation latency, replayable for demo purposes but
  **not** a measurement of the replayed run.

## Recording workflow

```bash
# 1. Live only; requires DEEPSEEK_API_KEY in .env.local
pnpm seed
stella doctor
stella record demo-live-2026-11-15 --live \
  --dataset support@1 --profile "Support grounded" \
  --out fixtures/demo/recordings/demo-live-2026-11-15

# 2. Review meta.json/events.jsonl for secrets and personal data, then commit the bundle.
# 3. Replay the demo deterministically:
pnpm demo:replay
# or
STELLA_MODE=replay stella demo --replay --cassette fixtures/demo/recordings/demo-live-2026-11-15
```

Command/flag names are provisional as of **v0.1.0**; confirm with `stella help` before running
a live recording session. `stella record` refuses to write a cassette when the key is missing.

## Synthetic fixture

`fixtures/demo/synthetic/smoke-001/` is a **hand-written synthetic cassette**, not a recording:

- its `meta.json` sets `"synthetic": true` and `"excludeFromQualityClaims": true`;
- the answer text is obviously synthetic ("synthetic smoke answer: replay mechanics only");
- it exists only to exercise the replay provider and the demo runner path in keyless CI;
- it must **never** be used for quality, accuracy, cost, latency, or model-behaviour claims,
  and it is excluded from demo cassettes and from any reported metrics.

No other fake cassettes are committed. Recordings under `recordings/` must come from a real
live session with a user key; the demo narrative in [`docs/DEMO.md`](../../docs/DEMO.md) marks
which steps are live and which are replay.
