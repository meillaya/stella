# Connectors

Last updated: 2026-11-06 · Applies to: Meridian v4.6.x

A connector is a saved integration between a source system and a Meridian workspace. Each
configured connector counts as one **connector instance** toward the plan limit, even when several
instances point at the same source product.

## Supported connector types

| Connector type | Protocol | Objects synced | Authentication | Setup |
| --- | --- | --- | --- | --- |
| Atlas Work Orders | REST | Work orders, assets, technicians, crews | OAuth 2.0 | 15 min |
| Sentinel Inspections | GraphQL | Inspections, form templates, photo metadata | Workspace API key | 20 min |
| Kestrel Scheduling | REST | Schedules, assignments, crews | API token | 10 min |
| Tessera Telemetry | MQTT + HTTP | Telemetry readings, meter registries | Mutual TLS | 30 min |
| Marlin ERP | SFTP (CSV drops) | Parts, purchase orders, cost lines | SFTP key pair | 45 min |
| Skiff Files | S3-compatible bucket | Inspection exports, asset registers (CSV) | Access key + secret | 20 min |
| Cairn FMS | REST | Assets, preventive-maintenance schedules | OAuth 2.0 | 15 min |
| PostgreSQL / MySQL replica | Read-only SQL | Tables you select | Read-only DB role | 30 min |
| Webhook intake | JSON over HTTPS | Events you send (for example work-order updates) | HMAC signing secret | 10 min |

Plan limits: Starter 2, Team 6, Business 15, Enterprise custom connector instances. Webhook intake
is Business and Enterprise only. Team and Business can buy connector packs; see
[Pricing tiers](../plans/pricing-tiers.md).

## Object coverage

Meridian normalizes source data into canonical objects; extra source fields are stored as
`custom.*` and can be used in dashboards and the query API.

| Canonical object | Key fields (columns) | Source connectors |
| --- | --- | --- |
| `work_orders` — units of field work | `work_order_id`, `status`, `priority`, `created_at`, `completed_at`, `asset_id` | Atlas, Kestrel, Cairn, webhook |
| `inspections` — form submissions | `inspection_id`, `template_id`, `result`, `submitted_at`, `technician_id` | Sentinel, Skiff |
| `assets` — equipment and locations | `asset_id`, `asset_type`, `site_id`, `install_date` | Atlas, Cairn, Skiff |
| `technicians` / `crews` | `technician_id`, `crew_id`, `region` | Atlas, Kestrel |
| `schedules` — planned assignments | `assignment_id`, `technician_id`, `asset_id`, `window_start` | Kestrel |
| `telemetry` — readings | `meter_id`, `reading`, `unit`, `recorded_at` | Tessera |
| `parts_costs` — cost lines | `cost_id`, `work_order_id`, `part_number`, `amount` | Marlin |

**"Field" is overloaded.** Here and in the API, a **field** is a column of a dataset (for example
`completed_at`); a **field site** or **field crew** is a location or team. See the
[Glossary](../reference/glossary.md).

## Add a connector

1. **Settings → Connectors → Add connector**; choose the type and give the instance a regional
   display name, for example `Atlas — North region`.
2. Enter the source URL and credentials. Credentials are encrypted at rest and never shown again
   after saving.
3. **Test connection**; a failed test does not save the connector.
4. Select objects and accept the detected primary key or choose a composite key. A wrong key is the
   most common cause of duplicate records (`MER-2004`).
5. Optionally map source fields to canonical fields. Required canonical fields must be mapped or the
   sync fails with `MER-2003`.
6. Choose a sync interval — slower than the plan default is allowed, faster is not.
7. **Start first sync**. This is the connector's backfill; its window depends on plan.

Use a dedicated **read-only integration account**, not a person's login. For SQL replicas grant
`SELECT` only; SFTP drops are read-only on Meridian's side.

## Connector lifecycle

| Action | Effect on data |
| --- | --- |
| Pause / Resume | Stops or restarts scheduled syncs; stored data remains queryable |
| Edit objects or mappings | Applied on the next sync; existing rows update in place |
| Delete connector | Stops future syncs; stored data remains until retention expires unless purged |
| Rotate credentials | Re-authenticate; syncs resume at the next interval |

Deleting a connector does **not** delete already-synced records; use **Settings → Data → Purge
connector data** to remove them. The purge is audit-logged and cannot be undone.

Next: [Sync schedule and troubleshooting](../data-sources/sync-schedule.md) · [Query API](../api/query-api.md)
