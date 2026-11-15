# Quickstart

Last updated: 2026-11-10 · Applies to: Meridian v4.6.x

Get a workspace from signup to a first dashboard in under an hour. Plan details are in
[Pricing tiers](../plans/pricing-tiers.md); roles are in
[Permissions and roles](../access/permissions-roles.md).

## 1. Start a trial

Open `https://app.meridian.example`, choose **Start free trial**, verify your email; the first
user becomes the workspace **Owner**. Name the workspace and choose a **data region** — United
States or European Union. The region is permanent; see
[Security and compliance](../security/compliance.md).

The trial runs **14 days**, includes up to **5 seats**, **1 connector**, a preloaded sample
dataset, and Business-level features. No payment card is required. After the trial the workspace
is read-only until you pick a plan; retention for expired trials is in
[Data retention](../policies/data-retention.md).

## 2. Configure the workspace

- **Invite members:** **Settings → Members → Invite**. Invitations expire after 7 days. Use
  **Analyst** for dashboard builders and **Field User** for crew members.
- **Timezone:** **Settings → General → Timezone** defaults to UTC and drives sync windows and
  dashboard date filters.
- **MFA:** available on every plan and enforceable by an Owner or Admin. SSO (SAML 2.0 or OIDC)
  requires Business or Enterprise.
- **Workspace ID** (`ws_…`) is under **Settings → General**; support needs it for tickets.

## 3. Connect a source

**Settings → Connectors → Add connector**, then choose a source type from
[Connectors](../data-sources/connectors.md). You need the source URL (or bucket/SFTP details), a
**read-only integration account**, and the objects to sync. Click **Test connection**, select
objects, map required fields, then **Start first sync**. The first sync is a **backfill**: 5–15
minutes for up to 50,000 records. If a run fails, note the `MER-xxxx` code and follow
[Sync schedule and troubleshooting](../data-sources/sync-schedule.md).

## 4. Build a first dashboard

**Dashboards → New dashboard**. Start with tiles for: work orders completed this week by crew;
first-time fix rate; cycle time by priority; asset downtime this month. Each tile shows the
**last synced** time and reads normalized data stored in Meridian — it never queries the source
system directly.

## 5. Ask a question through the API

Create a key in **Settings → API keys**, then call the query API:

```bash
curl -s https://api.meridian.example/v1/query \
  -H "Authorization: Bearer mrd_live_xxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"dataset":"work_orders","fields":["work_order_id","status","completed_at"],
       "filter":{"completed_at":{"gte":"2026-10-01"}},"limit":100}'
```

The response contains `rows`, `meta.next_cursor`, and `meta.request_id`. See
[Query API](../api/query-api.md) for datasets, limits, and errors.

## First-day questions

| Question | Where to look |
| --- | --- |
| What does "sync" mean on a connector page versus the phone? | [Glossary](../reference/glossary.md) |
| Why is my dashboard empty after a successful sync? | [Sync schedule and troubleshooting](../data-sources/sync-schedule.md) |
| Who can invite people and change roles? | [Permissions and roles](../access/permissions-roles.md) |
| How do I cancel or get a refund? | [Billing and refunds](../policies/billing-refunds.md), then the current release note |
