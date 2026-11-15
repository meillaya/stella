# Stella HTTP API (v1)

All routes are same-origin under `/api`. The server binds to loopback by
default; if it is exposed on a network interface, requests require
`Authorization: Bearer $STELLA_ACCESS_TOKEN`.

Responses use the contracts in [`shared/types.ts`](../shared/types.ts).
Errors always use:

```json
{ "error": { "message": "...", "code": "optional_machine_code" } }
```

## Ownership

| Area | Routes | Owner |
| --- | --- | --- |
| Core | `/health`, `/overview`, `/settings` | Lead |
| Traces | list, detail, annotate | Gateway workstream |
| Collections | list/create, documents, URL ingest, search | RAG workstream |
| Datasets / cases | list, snapshot, import/export, promote | Eval workstream |
| Runs | create/list/detail/cancel/compare | Eval workstream |
| Gates | create/list/artifact | Eval workstream |
| Fine-tuning | preflight, exports, jobs | Eval workstream |
| Jobs/events | job list, SSE progress | Lead + owners |

## Core

### `GET /api/health`
`{ ok, name, version, mode, hasKey, key: KeyStatus, dataDir, db }`

### `GET /api/overview` → `Overview`
Release readiness for the Quality page.

### `GET /api/settings` → `StellaSettings`
### `PATCH /api/settings`
Body: `{ activeProfileId?: string | null, traceRetentionDays?: number, defaultModel?: ModelId }`

## Traces

### `GET /api/traces?limit=50&cursor=&feedback=up|down&status=&q=&profileId=`
→ `{ items: TraceSummary[], nextCursor: string | null }`

### `GET /api/traces/:id` → `Trace`
### `PATCH /api/traces/:id`
Body: `{ feedback?: 'up' | 'down' | null, annotation?: string | null }` → `Trace`

### `POST /api/traces/:id/promote`
Body: `{ datasetId: string }` → `DatasetCase` (created or updated draft case)

## Collections and retrieval

### `GET /api/collections` → `{ items: Collection[] }`
### `POST /api/collections` body `{ name, description? }` → `Collection`
### `GET /api/collections/:id/documents` → `{ items: DocumentRecord[] }`
### `POST /api/collections/:id/documents` (multipart `file`) → `{ document, chunks: number }`
### `POST /api/collections/:id/urls` body `{ urls: string[] }` → `{ documents, errors }`
### `DELETE /api/documents/:id` → `{ ok: true }`
### `POST /api/collections/:id/search` body `{ query, k?, rerank? }` → `{ results: RetrievedChunk[] }`

## Datasets and cases

### `GET /api/datasets` → `{ items: Dataset[] }`
### `POST /api/datasets` body `{ name, description? }` → `Dataset`
### `GET /api/datasets/:id` → `{ dataset, versions: DatasetVersion[], cases: DatasetCase[] }`
### `POST /api/datasets/:id/snapshot` body `{ notes? }` → `DatasetVersion`
### `GET /api/datasets/:id/versions/:version` → `{ version: DatasetVersion, cases: DatasetCase[] }`
### `POST /api/datasets/:id/import` body `{ jsonl: string }` → `{ imported, skipped }`
### `GET /api/datasets/:id/export?version=` → `text/plain` JSONL
### `POST /api/cases` body `DatasetCase` → `DatasetCase`
### `PATCH /api/cases/:id` body partial `DatasetCase` → `DatasetCase`
### `DELETE /api/cases/:id` → `{ ok: true }`

## Profiles

### `GET /api/profiles` → `{ items: Profile[] }`
### `POST /api/profiles` body `{ name, spec, parentId? }` → `Profile`
### `POST /api/profiles/:id/publish` → `Profile`

## Runs

### `GET /api/runs` → `{ items: Run[] }`
### `POST /api/runs` body `{ datasetVersionId, profileId, budgetUsd, offPeak? }` → `Run` (queued; executes asynchronously)
### `GET /api/runs/:id` → `Run`
### `GET /api/runs/:id/items` → `{ items: RunItem[] }`
### `POST /api/runs/:id/cancel` → `Run`
### `GET /api/runs/compare?baseline=&candidate=` → `{ baseline: Run, candidate: Run, overall: Comparison, slices: SliceComparison[] }`

## Gates

### `POST /api/gates` body `{ baselineRunId, candidateRunId, config?: GateConfig }` → `Gate`
### `GET /api/gates` → `{ items: Gate[] }`
### `GET /api/gates/:id` → `Gate`
### `GET /api/gates/:id/artifact?format=md|json|html` → artifact body

## Fine-tuning

### `POST /api/finetune/preflight` body `{ datasetVersionId, format, filters? }` → preflight report
### `POST /api/finetune/exports` body `{ datasetVersionId, format, filters? }` → `FinetuneExport`
### `GET /api/finetune/exports` → `{ items: FinetuneExport[] }`
### `GET /api/finetune/exports/:id` → `{ export: FinetuneExport, manifest }`
### `POST /api/finetune/jobs` body `{ exportId, provider, baseModel }` → `FinetuneJob`
### `GET /api/finetune/jobs` → `{ items: FinetuneJob[] }`

## Jobs and events

### `GET /api/jobs?limit=` → `{ items: Job[] }`
### `GET /api/events` (SSE) — `job` events with `{ id, kind, status, progress }`

## Gateway routes (not under `/api`)

`/models`, `/anthropic/v1/*`, `/v1/tools/*` proxy to DeepSeek. `/models` and
Anthropic errors keep the upstream shape. The gateway adds `usage.lantern_trace_id`
and `usage.lantern_sources` to streaming usage so the chat client can show
provenance and post feedback without extra requests.
