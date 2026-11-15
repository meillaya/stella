# Glossary

Last updated: 2026-11-10 · Applies to: Meridian v4.6.x

Several words mean different things in different parts of Meridian. This page disambiguates them.

## Sync

| Meaning | What it means | Page |
| --- | --- | --- |
| **Connector sync** | Meridian pulling data from a source system (Atlas, Sentinel, Kestrel, …) into the workspace on a schedule | [Sync schedule](../data-sources/sync-schedule.md) |
| **Mobile sync** | The Meridian Field app uploading pending inspections from a device and refreshing assignments | [Mobile app](../product/mobile-app.md) |
| **Dashboard refresh** | Re-rendering dashboard tiles from already-synced data; does not read the source system | [Reporting and exports](../product/reporting-exports.md) |

**Rule:** if a page says "sync" without a qualifier it means **connector sync**, unless the page is
specifically about the mobile app (mobile sync) or dashboards (refresh).

## Field

| Meaning | Example | Where it appears |
| --- | --- | --- |
| **Field (column)** | `completed_at`, `priority`, and `site_id` are fields of the `work_orders` dataset | Query API, datasets, connector mapping |
| **Field site** | A physical location such as a substation or tower, identified by `site_id` | Site scoping, dashboards, mobile assignments |
| **Field crew** | A team of technicians, identified by `crew_id` | Scheduling, dashboards, analytics |

`GET /datasets/{dataset}/fields` lists **columns**, not sites or crews. "Field operations" refers to
work performed at remote sites and is unrelated to a data field.

## Export

| Meaning | What it is | Page |
| --- | --- | --- |
| **Report export** | CSV/XLSX download of a dashboard or table view, capped at 250,000 rows | [Reporting and exports](../product/reporting-exports.md) |
| **Bulk API export** | Asynchronous large CSV/JSONL job created with `POST /exports` | [Query API](../api/query-api.md) |
| **Backup restore** | Restoring a nightly backup snapshot into a new workspace | [Reporting and exports](../product/reporting-exports.md) |
