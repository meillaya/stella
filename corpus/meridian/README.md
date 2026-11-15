# Meridian Field Operations Knowledge Base

Meridian is a cloud analytics platform for field-operations teams: utilities, telecom,
facilities maintenance, and renewable-energy operations. It connects to the systems your
crews already use (work-order management, inspections, scheduling, telemetry), normalizes
the data, and gives analysts dashboards and an API to answer questions about field work:
what was done, where, by whom, how long it took, and what it cost.

This knowledge base is the customer-facing source of truth for setup, plans, policies,
security, and the public API. It applies to Meridian **v4.6.x** (November 2026) unless a
page states otherwise.

## Who this is for

| Audience | Start here |
| --- | --- |
| New workspace owners | [Quickstart](getting-started/quickstart.md) |
| Admins configuring a team | [Workspace setup](getting-started/workspace-setup.md), [Permissions and roles](access/permissions-roles.md) |
| Integration engineers | [Connectors](data-sources/connectors.md), [Sync schedule](data-sources/sync-schedule.md) |
| Analysts and developers | [Query API](api/query-api.md), [Rate limits](api/rate-limits.md) |
| Buyers and finance | [Pricing tiers](plans/pricing-tiers.md), [Billing and refunds](policies/billing-refunds.md), [SLA and support tiers](support/sla-support-tiers.md) |
| Security reviewers | [Security and compliance](security/compliance.md), [Data retention](policies/data-retention.md) |
| Field crews | [Mobile app](product/mobile-app.md) |

## Documentation map

| Path | What it covers |
| --- | --- |
| `getting-started/quickstart.md` | 14-day trial, first connector, first dashboard |
| `getting-started/workspace-setup.md` | Workspace creation, invites, regions, SSO |
| `data-sources/connectors.md` | Supported source systems, object coverage, setup steps |
| `data-sources/sync-schedule.md` | Sync intervals, backfills, reconcile windows |
| `data-sources/sync-troubleshooting.md` | Common sync errors and fixes (MER codes) |
| `access/permissions-roles.md` | Roles, capability matrix, site scoping |
| `api/query-api.md` | REST query API, datasets, exports, errors |
| `api/rate-limits.md` | Per-plan limits, 429 handling, headers |
| `plans/pricing-tiers.md` | Plan comparison, seat and connector limits, billing cycles |
| `policies/billing-refunds.md` | Refund and cancellation policy (superseded 2026-11-01) |
| `policies/data-retention.md` | Retention and deletion schedule (superseded 2026-11-01) |
| `support/sla-support-tiers.md` | Support channels, response targets, uptime SLA credits |
| `security/compliance.md` | Certifications, encryption, regions, subprocessors |
| `product/reporting-exports.md` | Dashboards, report exports, backups, restore |
| `product/mobile-app.md` | Meridian Field mobile app, offline capture, device sync |
| `release-notes/2026-09.md` | Release notes, September 2026 |
| `release-notes/2026-10.md` | Release notes, October 2026 (billing and retention policy update) |
| `release-notes/2026-11.md` | Release notes, November 2026 |
| `reference/glossary.md` | Terms, including overloaded words such as "sync", "field", "export" |

## Documentation conventions

- **Dates** are ISO 8601 (`2026-11-01`). **Times** are UTC unless marked otherwise.
- **Money** is in US dollars and excludes local taxes unless stated.
- Each page carries a **Last updated** date. A page marked **Superseded** has been replaced;
  follow the pointer at the top of that page to the page that now governs.
- Plan names are **Starter**, **Team**, **Business**, and **Enterprise**. Limits are per
  workspace (tenant) unless a page says "per user" or "per connector".
- Example hostnames use the reserved `.example` domain and are not resolvable.

## Support and status

- Support portal and email contacts are listed in
  [SLA and support tiers](support/sla-support-tiers.md).
- Service status and incident history: `https://status.meridian.example`
- Documentation feedback: `docs-feedback@meridian.example`
