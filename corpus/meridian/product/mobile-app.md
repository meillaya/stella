# Mobile app

Last updated: 2026-11-12 · Applies to: Meridian Field v3.4, server v4.4+

Meridian Field is the mobile companion app for technicians and crews. It shows assigned work, lets
crews complete inspection forms without a network connection, and uploads results when a connection
returns. This page is about **mobile sync** (device to server); for connector sync (source system
to Meridian) see [Sync schedule](../data-sources/sync-schedule.md).

## Requirements

| Item | Requirement |
| --- | --- |
| App | Meridian Field, current 3.4.x (November 2026); minimum supported 3.0 |
| Minimum server version | v4.4 |
| iOS | iOS 16 or later |
| Android | Android 11 or later |
| Offline capture plan | Business and Enterprise |
| Roles that can capture offline | Owner, Admin, Field User |
| View-only mobile access | Owner, Admin, Analyst, Viewer; Field Users see assigned work only |

## What the app does

View assigned work orders, inspections, and assets; complete inspection forms offline with photos
and notes; scan asset barcodes; receive push notifications; and view a read-only dashboard summary
where the role permits it. The app does not edit work orders directly — status changes flow through
the source system, which syncs back through the connector, keeping the source as system of record.

## Offline behavior and limits

| Parameter | Value |
| --- | --- |
| Pending records per device | Up to 200 |
| Photo attachments per inspection | Up to 10 |
| Maximum photo size | 25 MB per photo |
| Cached assignment data | 7 days since last refresh |
| Automatic retry attempts on upload | 5, with backoff |

Work is stored in an encrypted local database. Removing a member, or using **Remote sign-out**
under **Settings → Members**, wipes cached data the next time the device comes online; a device
that stays offline keeps its local copy until the app can reach Meridian.

## Mobile sync behavior

When connectivity returns the app uploads pending inspection records first, then refreshes
assigned work. Uploads retry up to **5 times** with exponential backoff; if all retries fail,
records stay pending and the app shows a warning badge. Conflict resolution: inspection answers
entered on the device win unless the inspection is locked on the server; status transitions follow
the server (source system wins). Mobile sync does not count against connector limits and is not
subject to query API rate limits. Timestamps are captured with the device's time offset and
normalized to UTC when the record reaches the server.

Mobile sync is **not** a connector sync: a phone can be fully synced while a connector is failing,
and vice versa.

## Install and troubleshooting

Install **Meridian Field** from the App Store or Google Play (regional store availability can lag
a few days), sign in with your Meridian account or SSO, allow notifications and where required
location access, then open **My work** and download assignments before entering a low-coverage
area.

| Code | Message | Fix |
| --- | --- | --- |
| `M-1203` | Pending queue full | Upload on a stable connection; keep pending records under 200. |
| `M-1210` | Form version outdated | Update the app and reopen the assignment; the form template changed. |
| `M-1301` | Session expired | Sign in again; SSO workspaces redirect to the identity provider. |
| `M-1404` | Photo too large | Lower the camera resolution or attach fewer photos (25 MB each). |
| `M-1502` | Server unreachable | Check connectivity, then use **Retry upload** under **Settings → Sync**. |

For unlisted codes, open a support ticket with the device model, app version, and time of the last
successful upload; see [SLA and support tiers](../support/sla-support-tiers.md).

## Version support policy

Meridian supports the current app version and the previous two minor versions; unsupported versions
show an update prompt and block uploads. App 3.4 requires server v4.4 or later.
