# Meridian Field Operations Knowledge Base

Meridian is a cloud analytics platform for field-operations teams — utilities, telecom,
facilities maintenance, and renewable energy. It connects to work-order, inspection,
scheduling, and telemetry systems, normalizes the data, and gives teams dashboards and an API
to answer questions about field work: what was done, where, by whom, how long it took, and what
it cost.

This knowledge base is the customer-facing source of truth for setup, plans, policies,
security, and the public API. It applies to Meridian **v4.6.x** (November 2026).

| If you are… | Start here |
| --- | --- |
| A new workspace owner | [Quickstart](getting-started/quickstart.md) |
| An integration engineer | [Connectors](data-sources/connectors.md), [Sync schedule](data-sources/sync-schedule.md) |
| An admin | [Permissions and roles](access/permissions-roles.md) |
| Finance or a buyer | [Pricing](plans/pricing-tiers.md), [Billing and refunds](policies/billing-refunds.md), [SLA](support/sla-support-tiers.md) |
| A security reviewer | [Security and compliance](security/compliance.md), [Data retention](policies/data-retention.md) |

## Documentation map

| Path | Covers |
| --- | --- |
| `getting-started/quickstart.md` | Trial, workspace setup, first connector, first dashboard |
| `data-sources/connectors.md` | Supported sources, object coverage, setup |
| `data-sources/sync-schedule.md` | Sync intervals, backfills, error codes |
| `access/permissions-roles.md` | Roles, capability matrix, site scoping |
| `api/query-api.md` | Query API, bulk exports, rate limits |
| `plans/pricing-tiers.md` | Plans, seats, connector limits, billing cycles |
| `policies/billing-refunds.md` | Refund policy (superseded 2026-11-01) |
| `policies/data-retention.md` | Retention schedule (superseded 2026-11-01) |
| `support/sla-support-tiers.md` | Channels, response targets, uptime credits |
| `security/compliance.md` | Certifications, encryption, regions, subprocessors |
| `product/reporting-exports.md` | Dashboards, report exports, backup/restore |
| `product/mobile-app.md` | Meridian Field app, offline capture, device sync |
| `release-notes/2026-10.md` | October releases; billing and retention policy v4.0 |
| `release-notes/2026-11.md` | November releases; policy v4.0 in effect |
| `reference/glossary.md` | Terms including "sync", "field", "export" |

## Conventions

Dates are ISO 8601 (`2026-11-01`); times are UTC unless stated; money is US dollars excluding
local taxes unless stated. Each page has a **Last updated** date. A page marked **Superseded**
has been replaced — follow the pointer at its top, and where an older page conflicts with a
newer release note, the newer release note governs. Plans are **Starter**, **Team**,
**Business**, and **Enterprise**; limits are per workspace unless stated.

Status: `https://status.meridian.example` · Support: `support@meridian.example` · Security:
`security@meridian.example`
