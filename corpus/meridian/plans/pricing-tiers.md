# Pricing tiers

Last updated: 2026-11-06 · Applies to: Meridian v4.6.x

Prices are in US dollars and exclude local sales tax. Prices are per workspace, not per
organization. Monthly and annual billing are available on every plan; annual billing takes
**20% off the monthly list price**.

## Plan comparison

| | Starter | Team | Business | Enterprise |
| --- | --- | --- | --- | --- |
| Monthly list price | $119 | $449 | $1,290 | From $3,500 |
| Annual billing (20% off), effective monthly | $95.20 | $359.20 | $1,032.00 | Custom |
| Annual total, billed yearly | $1,142.40 | $4,310.40 | $12,384.00 | Custom |
| Seats included | 3 | 15 | 50 | Custom |
| Extra seat, per month | $35 | $25 | $19 | Contract |
| Connector instances included | 2 | 6 | 15 | Custom |
| Default sync interval | 6 hours | 2 hours | 30 minutes | 10 minutes |
| API query requests per minute | 60 | 300 | 1,200 | 6,000 (negotiable) |
| Concurrent API queries | 2 | 5 | 20 | 50 |
| Bulk API export jobs per day | 2 | 10 | 50 | Custom |
| Dashboard history window | 30 days | 12 months | 36 months | Custom |
| SSO (SAML 2.0 / OIDC) | — | — | Included | Included |
| SCIM provisioning and IP allowlisting | — | — | — | Included |
| Offline mobile inspection capture | — | — | Included | Included |
| Scheduled report exports (email, SFTP) | — | — | Included | Included |
| Support coverage | Email | Email + chat | 24×5, email + chat + phone | 24×7, dedicated channel |
| Uptime SLA | Best effort | 99.5% | 99.9% | 99.95% |

Enterprise is sold on an annual contract at a minimum of **$3,500 per month**, includes custom
seat, connector, and API limits, and can add the streaming add-on. Multi-region volume discounts
are negotiated with the account team.

## Add-ons

| Add-on | Price | Applies to |
| --- | --- | --- |
| Connector pack (+3 connector instances) | $99 / month | Team |
| Connector pack (+5 connector instances) | $199 / month | Business |
| Streaming add-on | $750 / month | Enterprise |

For sync cadence see [Sync schedule](../data-sources/sync-schedule.md); for API limits see
[Query API](../api/query-api.md); for support targets see
[SLA and support tiers](../support/sla-support-tiers.md).

## Billing cycles and plan changes

| Topic | How it works |
| --- | --- |
| Billing cycle | Monthly in advance, or annual in advance with the 20% discount; added seats prorated, removed seats at renewal |
| Upgrades | Immediate and prorated; features unlock immediately |
| Downgrades | End of the current billing period; if new limits are exceeded the workspace becomes read-only for new connectors until usage fits |
| Cancellation | End of the current period; access continues through the paid period |
| Payment methods | Major credit cards; invoice and purchase order for Enterprise only |
| Invoices and receipts | Owner: **Settings → Billing → Invoices**. Taxes added per billing address |

Cancellation and refunds follow the billing policy in effect on the request date. The current
policy is the **v4.0 update** announced in
[Release notes, October 2026](../release-notes/2026-10.md), effective 2026-11-01; it replaced
[Billing and refunds](../policies/billing-refunds.md) v3.2.

## Trial

The trial runs **14 days**, includes up to **5 seats** and **1 connector**, needs no payment
card, and unlocks Business-level features. At the end of the trial the workspace is read-only
until a plan is selected.

Not billed: calls to `GET /health`, failed sync attempts and retries, deletion requests, and
reading documentation.
