# Sync schedule and troubleshooting

Last updated: 2026-11-12 · Applies to: Meridian v4.6.x

This page covers **connector sync** (source system → Meridian) and its failure modes. It does not
cover the mobile app's device-to-server sync (see [Mobile app](../product/mobile-app.md)) or
dashboard rendering (see [Reporting and exports](../product/reporting-exports.md)).

## Default intervals by plan

| Plan | Default sync interval | Minimum configurable |
| --- | --- | --- |
| Starter | 6 hours | 6 hours |
| Team | 2 hours | 2 hours |
| Business | 30 minutes | 30 minutes |
| Enterprise | 10 minutes | 10 minutes |

Intervals run from the **end** of the previous run. If a run takes longer than its interval, the
next starts immediately when the previous finishes and an overlapping scheduled run is coalesced
(logged as skipped). Enterprise can add the **streaming add-on**, which delivers eligible objects
as events instead of on an interval; see [Pricing tiers](../plans/pricing-tiers.md).

## Backfill, incremental sync, and reconcile

The first sync is a **backfill**: the earliest record date Meridian will request. Starter 90 days,
Team 13 months, Business 36 months, Enterprise up to 7 years per contract. A backfill runs once per
connector; **Connector → Rebuild backfill** re-reads the window and replaces canonical rows, and a
backfill older than the plan window fails with `MER-5005`.

Afterward, syncs are incremental: Meridian reads the per-object **watermark** (newest source
`updated_at` seen) and requests records changed at or after `watermark` minus a fixed **24-hour
lookback**, catching late edits and timezone quirks. Records are upserted by primary key;
source-side deletions are applied on the next successful sync if the source exposes them. A source
that backdates records by more than 24 hours can show stale rows until the next full reconcile. A
reconcile re-reads the backfill window and compares it with stored data: weekly on Sunday for
Starter and Team, nightly at 02:00 workspace local time for Business, nightly or custom for
Enterprise. Scheduled syncs pause while a reconcile runs.

## Statuses and scheduling options

Statuses are `queued`, `running`, `succeeded`, `warning` (finished with non-fatal issues, for
example schema drift `MER-2007`), `failed` (at least one object not updated; error code shown on the
connector), and `paused`. A failed sync never deletes previously synced data, and the dashboard
freshness badge keeps showing the last successful sync. After **5 consecutive failed runs**
Meridian pauses the connector and emails Owner and Admin.

- **Business-hours only** (Team and above): restrict syncs to a window such as 06:00–20:00
  workspace time. Schedule windows use the workspace timezone and handle daylight-saving
  transitions; a window that does not exist on a transition day runs at the next valid minute.
- **Expected duration:** a first backfill of up to 50,000 records takes about 5–15 minutes;
  50,000–500,000 records 20–90 minutes; more than 500,000 records 2–6 hours. A run longer than
  6 hours is marked `warning`, not cancelled.

## Sync error reference

Open **Settings → Connectors → [connector] → Sync history**: a failed run shows an error code such
as `MER-1002`, the affected object, and the record count. `MER-1xxx` is source authentication and
permissions; `MER-2xxx` data mapping and schema; `MER-3xxx` attachments and payloads; `MER-5xxx`
scheduling and platform-side problems.

| Code | Message | Likely cause | Fix |
| --- | --- | --- | --- |
| `MER-1001` | Source credentials rejected | OAuth token expired or revoked, password changed, account disabled, or SQL role lost `SELECT` | **Reconnect** with the integration account; recreate it if the source disabled it; verify SQL grants. |
| `MER-1002` | Source rate limit reached | Source returned HTTP 429, often because several connectors read the same source | Meridian retries up to **5 attempts** over about **15 minutes to 4 hours** of backoff. Spread start times, slow the noisiest interval, or ask the vendor to raise the quota. No records are lost. |
| `MER-2003` | Field mapping rejected | Required canonical field missing, source type changed, or required value empty | Remap under **Connector → Mapping**; map new enum values to statuses; re-run. |
| `MER-2004` | Duplicate work order identifier | Source reuses a work-order number after archiving the original | Key on composite `source_instance + work_order_number` or the immutable `external_id`, then rebuild the work-orders backfill. Duplicates are quarantined, not overwritten. |
| `MER-2007` | Schema drift detected | Source added, renamed, or removed a field (column) | Run is `warning`, not failed; new fields become `custom.*`. Map what you need, then dismiss. |
| `MER-3001` | Attachment exceeds size limit | Attachment larger than **250 MB** | Skipped and listed in run details; reduce the file or exclude attachment bodies. Metadata still syncs. |
| `MER-5005` | Backfill window not supported | Requested start older than the plan window | Choose a start inside the window or upgrade; Enterprise can request an extended import. |

Download **Settings → Connectors → [connector] → Download diagnostics** for support: it covers the
last **30 days** (run history, error codes, mapping snapshots, record counts; no customer records).
Include the workspace ID (`ws_…`), connector ID, and UTC time of the first failure.
