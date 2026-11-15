# Reporting and exports

Last updated: 2026-11-10 · Applies to: Meridian v4.6.x

This page covers dashboards, report exports, scheduled exports, and backup/restore. "Export" has
three meanings in Meridian; they are listed below and in the [Glossary](../reference/glossary.md).

## Three things called "export"

| Term | Where | What it is |
| --- | --- | --- |
| Report export | Web app, **Dashboards → Export** | CSV or XLSX file of the rows behind a tile or table view |
| Bulk API export | Query API, `POST /exports` | Asynchronous large CSV or JSONL download job; see [Query API](../api/query-api.md) |
| Backup restore | Support request | Nightly backup snapshot restored into a new workspace |

## Dashboards and refresh

Dashboard tiles read normalized data stored in Meridian; they never query a source system
directly. When a connector sync finishes, affected tiles refresh automatically. The **Refresh**
button re-renders tiles from stored data and does **not** trigger a connector sync.

| Behavior | Value |
| --- | --- |
| Manual refresh rate limit | Once per 60 seconds per user |
| Data freshness indicator | Last successful sync time, shown on each tile |
| Dashboard history window | Starter 30 days; Team 12 months; Business 36 months; Enterprise custom |

The dashboard history window is the span a dashboard can display; raw record retention is a
separate policy — see [Data retention](../policies/data-retention.md) and the November 2026 policy
update in [Release notes, October 2026](../release-notes/2026-10.md).

## Report exports

Available on every plan to Owner, Admin, and Analyst roles; see
[Permissions and roles](../access/permissions-roles.md). Limits: CSV and XLSX (PDF dashboards on
Business and Enterprise); **250,000 rows** and **500 columns** per export; **3 concurrent** report
exports per user; timestamps ISO 8601 in UTC; UTF-8 text. Export files remain downloadable from
**Exports** for **14 days**, after which the retention job removes them. Exports above the row
limit fail with a message asking you to narrow the filter or use a bulk API export.

## Scheduled exports (Business and Enterprise)

Scheduled exports run a saved dashboard or table view daily or weekly and deliver it by email to up
to 10 workspace members, or by SFTP. Each workspace can have **10 schedules**; a failed delivery is
retried **3 times**, then Owner and Admin are notified. Files are encrypted at rest with AES-256.
SFTP delivery uses a Meridian-generated public key that you authorize on your server; Meridian's
outbound IP ranges are listed in the trust portal (`https://trust.meridian.example`). Scheduled
exports obey the same 250,000-row and 500-column limits as manual ones.

## Backup and restore

| Item | Behavior |
| --- | --- |
| Backup cadence | Nightly encrypted snapshot |
| Backup retention | 35 days |
| Restore target | Always a **new workspace**; never restored in place over a live workspace |
| Restore request | Owner opens a support ticket with the workspace and target backup date |
| Point-in-time recovery window | Team 24 hours; Business 7 days; Enterprise 14 days |

A restored workspace has its own workspace ID; members are not copied and must be invited.
Restores are audit-logged. Backups use the same encryption and access controls as production data;
see [Security and compliance](../security/compliance.md).

## Before you export

Confirm the tile's date filter matches the period you are reporting — exports do not add a date
filter of their own. Check the freshness badge: a stale sync means the export reflects the last
successful sync. Timestamps are UTC, so local-time spreadsheets can appear shifted by a day. Export
before deleting a workspace or purging connector data.
