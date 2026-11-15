# SLA and support tiers

Last updated: 2026-11-06 · Applies to: Meridian v4.6.x

This page defines support channels, response targets, severity levels, and the uptime SLA. Uptime
credits are service credits, not cash refunds; refunds follow the current billing policy (see
[Billing and refunds](../policies/billing-refunds.md) and the November 2026 policy update in
[Release notes, October 2026](../release-notes/2026-10.md)).

## Support channels and coverage

| Plan | Channels | Coverage | P1 first response | P2 first response | P3/P4 first response | Uptime SLA |
| --- | --- | --- | --- | --- | --- | --- |
| Starter | Email | Mon–Fri, 09:00–17:00 UTC | 2 business days | 3 business days | 5 business days | None (best effort) |
| Team | Email, in-app chat | Mon–Fri, 08:00–18:00 UTC | 8 business hours | 1 business day | 3 business days | 99.5% |
| Business | Email, in-app chat, phone | 24×5 (Mon 00:00 UTC through Fri 23:59 UTC) | 2 hours | 8 hours | 2 business days | 99.9% |
| Enterprise | All channels plus a dedicated support channel | 24×7 | 30 minutes | 2 hours | 1 business day | 99.95% |

Support email: `support@meridian.example`; portal: `https://support.meridian.example`. Business
and Enterprise can request German, French, or Spanish support during local business hours; P1
targets are unchanged.

## Severity definitions

| Severity | Definition | Examples |
| --- | --- | --- |
| P1 | Platform unavailable, or all data ingestion stopped for the workspace, with no workaround | All users cannot sign in; API errors on every request; every connector fails with a platform-side error |
| P2 | Major function degraded but workspace usable, or a workaround exists | Syncs delayed more than two intervals for all connectors; dashboards failing for most users; consistent bulk-export failures |
| P3 / P4 | Minor function impaired, single-connector issue, behavior question, cosmetic issue, documentation problem, or feature request | One connector fails while others succeed; one tile renders incorrectly; how-to question; UI typo |

Misclassified tickets are re-prioritized during triage; the response clock starts at the first
accurate classification. A single-connector failure caused by source credentials or a source-side
outage is normally P3 because the workspace remains usable.

## Uptime SLA and service credits

Uptime is the monthly percentage of minutes the web application and query API are available,
excluding the exclusions below. An API that returns authorization errors is available; a
platform-side 5xx is unavailable.

| Plan | Monthly uptime target | Credit if below target |
| --- | --- | --- |
| Starter | Best effort | No credits |
| Team | 99.5% | 10% at 99.0%–99.5%; 25% below 99.0% |
| Business | 99.9% | 10% at 99.5%–99.9%; 25% at 99.0%–99.5%; 50% below 99.0% |
| Enterprise | 99.95% | 10% at 99.5%–99.95%; 25% at 99.0%–99.5%; 50% below 99.0% |

Credits are calculated on the monthly fee actually paid for the affected workspace, capped at
**50%** of that month's fee; a credit request must be submitted within **30 days** after the
affected month through the support portal; credits apply to a future invoice, are not redeemable
for cash, and are the sole remedy for missed uptime targets except where law provides otherwise.
The SLA excludes scheduled maintenance, third-party source outages, customer network or
configuration problems, suspended workspaces, deprecated features, and force majeure.

## Maintenance windows and escalation

Routine maintenance is the **second Tuesday of each month, 02:00–04:00 UTC**. Business and
Enterprise receive at least **7 days' notice** by email; Starter and Team see it on the status page
and in-app banner. Emergency maintenance is announced at least 24 hours ahead where possible.
`https://status.meridian.example` is the canonical incident source: a confirmed P1 is updated
there within **30 minutes**, with email or in-app notification. If a P1 ticket is not acknowledged
within target, reply with "ESCALATE P1" and the workspace ID; the support duty manager is paged
automatically.
