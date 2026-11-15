# Data retention

**Status: SUPERSEDED.** This page documents **retention policy v3.0**, which applied from
2025-04-01 through 2026-10-31. It is retained for reference and for workspaces whose data was
purged under these terms.

> **Do not quote these windows for questions about the current product.** Retention policy
> **v4.0** took effect on 2026-11-01 and is published in
> [Release notes, October 2026](../release-notes/2026-10.md). Where this page and that release
> note disagree, the release note governs.

Last updated: 2026-02-18 · Applies to: Meridian v3.x · Policy version: 3.0

## What retention covers

Meridian stores **synced records** (normalized rows pulled from source systems; the source remains
the system of record) and **workspace artifacts** (dashboards, saved queries, report exports, audit
logs, API keys, connector configuration). Retention windows define how long each remains queryable.

## Retention windows (policy v3.0, historical)

| Data category | Starter | Team | Business | Enterprise |
| --- | --- | --- | --- | --- |
| Raw synced record data (work orders, inspections, assets, telemetry) | 180 days | 13 months | 26 months | 5 years |
| Dashboard history window | 90 days | 24 months | 48 months | Custom |
| Audit logs | 12 months | 12 months | 12 months | 12 months |
| Query result cache | 24 hours | 24 hours | 24 hours | 24 hours |
| Report export files in workspace | 30 days | 30 days | 30 days | 30 days |
| Backup snapshots | 35 days | 35 days | 35 days | 35 days |
| Expired trial workspaces before purge | 30 days | — | — | — |

The **dashboard history window** is the span a dashboard can display; it is independent of raw
retention — older data remains in storage but is not available to dashboard tiles.

## Deletion and purge timeline (policy v3.0)

| Action | Behavior under policy v3.0 |
| --- | --- |
| Record deleted in source system | Removed from Meridian within 24 hours of the next successful sync, if the source exposes deletions |
| Record excluded by a changed backfill window | Removed on the next successful reconcile |
| Connector deleted | Stored records remain until the retention window expires unless an explicit purge is requested |
| Workspace deleted | Soft-delete for **45 days**, during which an Owner can restore it; after 45 days the data is permanently purged |
| Data purge requested by Owner | Completed within 30 days of a verified request |
| Backup expiration | Nightly snapshots expire after 35 days and are removed from all backup media |

## Legal holds and customer responsibilities

Meridian honors valid legal holds and subpoenas: data under hold is retained beyond the standard
window until the hold is released, but a hold does not restore data already purged. Keep your own
copies of anything you must retain — Meridian holds copies of source data, not the system of
record. Export before deleting a workspace; deletion is irreversible after the soft-delete window.

Policy changes are announced in the release notes at least 30 days before they take effect;
retention policy v4.0 took effect on 2026-11-01.
