# Operations

## Requirements

- Node.js 24+ (24.22.2 used during development)
- pnpm 11+
- A DeepSeek API key for live chat, URL/PDF ingestion and live evaluations
- No Python, Docker, database server or cluster required
- Chromium/Chrome only for optional visual QA (`scripts/screenshot.mjs`)

## Install and run

```bash
pnpm install
cp .env.example .env.local     # add DEEPSEEK_API_KEY
pnpm seed                      # demo collection, dataset and profiles
pnpm dev                       # server :8787, rspack dev app :8090
```

Production-style single origin:

```bash
pnpm build
pnpm start                      # http://127.0.0.1:8787
```

The server serves `dist/` at `/` and proxies `/models`, `/anthropic/v1/*` and
`/v1/tools/*` to DeepSeek. In dev, rspack proxies those paths to :8787.

## Configuration

Environment variables (`.env.local` is gitignored; process env wins):

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | — | Server-held key. Required for live mode. |
| `STELLA_HOST` | `127.0.0.1` | Bind address. Non-loopback requires an access token. |
| `STELLA_PORT` | `8787` | Server port. |
| `STELLA_MODE` | `live` | `live` or `replay`. |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | For proxies or compatible gateways. |
| `STELLA_ACCESS_TOKEN` | — | Bearer token required when binding non-loopback. |
| `STELLA_DATA_DIR` | `data` | SQLite, cassettes, exports. |
| `STELLA_RUN_CONCURRENCY` | `4` | Parallel cases per eval run. |
| `STELLA_JUDGE_CONCURRENCY` | `4` | Parallel judge calls. |
| `STELLA_TRACE_RETENTION_DAYS` | `30` | Trace retention default. |
| `STELLA_LOG` | `info` | `debug`, `info`, `warn`, `error`. |

BYOK: with no `DEEPSEEK_API_KEY`, the gateway forwards the key entered in
Settings → Data. The preferred mode is a server-held key; the browser never
receives it.

## Data and backup

Everything lives under `data/` (gitignored):

```
data/stella.db        SQLite (WAL), all index/state
data/runs/<id>/       gate.md, gate.json, review.html, run artifacts
data/finetune/        exported JSONL + manifests
data/cassettes/       replay cassettes (keyed by request hash)
data/uploads/         temporary ingestion files
```

Back up with `sqlite3 data/stella.db ".backup data/backup.db"` while stopped, or
copy the database plus `data/runs` and `data/finetune` while the server is idle.
Datasets are also plain JSONL in `datasets/` and can be restored from git.

The app has no telemetry and makes no network calls except to the configured
DeepSeek base URL (and to URLs you explicitly ingest).

## Retention and deletion

Settings → Stella controls the default trace retention. `PATCH /api/settings
{traceRetentionDays}` updates it. A purge runs on server start and via the CLI
(`stella doctor` reports counts; add `--purge` when implemented). Deleting traces
also deletes their sources (foreign keys). Exports and gate artifacts are kept
until you remove them.

## Replay and cassettes

`STELLA_MODE=replay` (or a run with a replay provider) serves recorded responses
from `data/cassettes/<sha256>.json`. A missing cassette is a loud `replay_miss`,
never a fabricated answer. Recording is done with
`stella record <name> --live` once a key is configured; the record command writes
the cassette format described in `fixtures/demo/README.md`. Replay proves
mechanics and statistics in CI; it does not make claims about live quality.

Known limitation: the demo's default grounded profile enables LLM rerank, and
rerank calls are not recorded, so `stella demo --replay` against that profile
fails loudly on missing rerank cassettes. Record with a rerank-off profile (or
add rerank cassette recording) before relying on replay for the demo; the live
gate is authoritative.

## Ingestion limits

- Local text/Markdown/HTML: no key needed.
- URLs: DeepSeek Fetch API when a key is present; local fetch + strip fallback.
- PDF/DOCX/PPTX/images: DeepSeek OCR (`text_recognition`), 100 MiB / 1,000 pages
  per file, 15 concurrent recognitions, $0.225 per 1,000 pages.
- Files API attachments are proxied for chat but their parsed text cannot be
  downloaded; OCR is the extraction path.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Chat says the key is missing | `.env.local` has `DEEPSEEK_API_KEY`; restart the server; Settings → Stella shows key status. |
| Chat streams but no provenance | Ensure the gateway (not `api.deepseek.com`) is the API origin; check `/api/health`. |
| 401 from DeepSeek | Key invalid or no balance; check `/user/balance`; the chat notice links to top-up. |
| Eval run stuck | `GET /api/runs/:id`; check provider mode and budget; cancel and retry. |
| `replay_miss` | Record the cassette or run live; replay never falls back silently. |
| Port already in use | `STELLA_PORT` / rspack `devServer.port`; stop the other process. |
| No Chromium for screenshots | `CHROMIUM_PATH=/path/to/chrome node scripts/screenshot.mjs`. |

## Upgrade and reset

- Update dependencies: `pnpm install` (in-repo store). Update upstream chat-demo
  per `UPSTREAM.md`.
- DB migrations run on open (`user_version`/schema idempotent); back up first.
- Full reset: stop the server, delete `data/` (SQLite/cassettes/exports), keep
  `datasets/` and `corpus/`; `pnpm seed` rebuilds the demo.
