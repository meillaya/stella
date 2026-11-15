# Query API

Last updated: 2026-11-10 · Applies to: Meridian v4.6.x

The Query API is a read API over normalized field-operations data. It is not a write API: work
orders and inspections are created in source systems and arrive through connectors.

## Base URL and authentication

```
https://api.meridian.example/v1
Authorization: Bearer mrd_live_xxxxxxxxxxxxxxxxxxxx
```

Create keys under **Settings → API keys**. Keys are shown once and stored hashed; their scopes and
site scope follow the creating member (see [Permissions and roles](../access/permissions-roles.md)).
Requests and responses are JSON except export downloads (CSV or JSONL).

## Datasets and fields

| Dataset | Contents |
| --- | --- |
| `work_orders` | Work-order header, status, priority, timestamps, asset link |
| `inspections` | Inspection submissions, template, result, technician |
| `assets` | Equipment and location register |
| `technicians` / `crews` | People and crews, with region |
| `custom_objects` | Customer tables from SQL and webhook connectors |

`GET /datasets` lists datasets; `GET /datasets/{dataset}/fields` returns each column's `name`,
`type` (`string`, `number`, `boolean`, `timestamp`, `enum`), and `filterable`. Here "fields" means
**columns**, not field sites; see the [Glossary](../reference/glossary.md).

## Run a query

`POST /query` takes `dataset` (required), `fields` (columns to return), `filter` (column →
condition), `order` (array of `{field, direction}`), `limit` (default 500, max 50,000), and
`cursor` (from `meta.next_cursor`). Filter operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`,
`contains`.

```bash
curl -s https://api.meridian.example/v1/query \
  -H "Authorization: Bearer $MERIDIAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dataset":"work_orders",
       "fields":["work_order_id","status","priority","completed_at"],
       "filter":{"completed_at":{"gte":"2026-10-01T00:00:00Z"},
                 "status":{"in":["completed","closed"]}},
       "order":[{"field":"completed_at","direction":"desc"}],"limit":1000}'
```

The response is `{ "rows": [...], "meta": { "dataset", "returned", "limit", "next_cursor",
"request_id" } }`. Timestamps are ISO 8601 UTC and date-only filter values mean midnight UTC; enum
values are lowercase strings; `contains` is a case-insensitive substring match on string columns; a
query times out after **120 seconds** (HTTP 504 `query_timeout`); one query returns at most
**50,000 rows** — page with `cursor` for larger reads; request bodies are limited to **1 MB**;
unknown column → HTTP 400 `invalid_field`, unknown dataset → HTTP 404 `unknown_dataset`.

## Bulk exports

`POST /exports` creates an asynchronous job from `{ "dataset", "format": "csv" | "jsonl",
"filter" }` and returns `202` with `{ "id", "status": "queued" }`. Poll `GET /exports/{id}`; when
complete, `download_url` is valid for **24 hours**. Exports larger than **2 GB** are split into
numbered part files. Daily job caps: Starter 2, Team 10, Business 50, Enterprise custom.
`GET /usage` returns current rate-window usage and daily export counts; `GET /health` returns
`{ "ok": true }`, needs no key, and is not rate limited.

## Rate limits

Limits are enforced **per workspace**, not per API key: all keys share one budget over a sliding
60-second window.

| Plan | Query requests per minute | Concurrent queries | Burst allowance | Bulk export jobs per day | API keys |
| --- | --- | --- | --- | --- | --- |
| Starter | 60 | 2 | 12 requests per 10 seconds | 2 | 2 |
| Team | 300 | 5 | 60 requests per 10 seconds | 10 | 10 |
| Business | 1,200 | 20 | 240 requests per 10 seconds | 50 | 25 |
| Enterprise | 6,000 (negotiable) | 50 | 1,200 requests per 10 seconds | Custom | Custom |

The burst allowance is a short-window ceiling, not an extra bucket: sustained burst-rate traffic
still exhausts the per-minute limit. Every request except `GET /health` counts toward the query
limit, including metadata calls. Creating an export job consumes the **daily bulk export cap**
instead of the query rate; polling `GET /exports/{id}` counts as a query request.

Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`; 429
responses add `Retry-After`. Respect `Retry-After` — retrying early extends the penalty window —
and back off exponentially with jitter (1 s, 2 s, 4 s, capped at 60 s). Do not retry in parallel
on every key; prefer one query with an `in` filter over many small ones; use bulk exports for long
reads. Exceeding a limit returns 429 rather than a surprise bill; rate limits are not billed as
overages. The Enterprise **streaming add-on** delivers up to 500 events per minute with HMAC-SHA256
signatures and a replayable dead-letter queue.

## Errors and versioning

```json
{"error":{"code":"invalid_filter","message":"Unknown operator 'near'","request_id":"req_01JCB2N5AB"}}
```

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_field`, `invalid_filter`, `invalid_body` | Bad column, operator, or JSON |
| 401 / 403 | `invalid_key`, `insufficient_scope` | Key missing, revoked, or lacking the scope |
| 404 | `unknown_dataset`, `unknown_export` | Not found in this workspace |
| 409 | `export_limit_reached` | Daily bulk export cap consumed |
| 429 | `rate_limited` | Limit exceeded; honor `Retry-After` |
| 500 / 504 | `internal_error`, `query_timeout` | Retry with backoff; narrow the query on timeout |

The API is versioned in the path (`/v1`). Within a version, changes are additive; removing a
member, renaming a column, or changing an error code is a breaking change announced at least
**6 months** in advance in the release notes and by email to Owners and Admins.
