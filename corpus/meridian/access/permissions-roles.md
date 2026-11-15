# Permissions and roles

Last updated: 2026-11-06 · Applies to: Meridian v4.6.x

Every workspace member has exactly one role, assigned at invitation and changeable by an Owner or
Admin. API keys are not members; a key inherits the creator's role and never exceeds it.

## Roles

| Role | Intended for | Summary |
| --- | --- | --- |
| Owner | Accountable workspace owner | Full control including billing, plan, ownership transfer, and deletion. Exactly one Owner. |
| Admin | IT and operations leads | Manage members, connectors, API keys, SSO, and audit logs; no billing. |
| Analyst | Data and operations analysts | Build dashboards, run API queries, export report data. |
| Viewer | Regional managers and stakeholders | View dashboards and rendered reports; no raw-data export or API. |
| Field User | Crew members | Mobile app for assigned work, including offline inspection capture on Business and Enterprise. |

## Capability matrix

| Capability | Owner | Admin | Analyst | Viewer | Field User |
| --- | --- | --- | --- | --- | --- |
| View dashboards | ✓ | ✓ | ✓ | ✓ | — |
| Create and edit dashboards; export report data | ✓ | ✓ | ✓ | — | — |
| Run API queries and bulk exports | ✓ | ✓ | ✓ | — | — |
| Create and manage API keys | ✓ | ✓ | — | — | — |
| Add, remove, and manage connectors; rebuild backfills | ✓ | ✓ | — | — | — |
| Invite and remove members; change roles | ✓ | ✓ (not Owner) | — | — | — |
| Configure SSO / SCIM | ✓ | ✓ | — | — | — |
| View or export audit logs | ✓ | ✓ | — | — | — |
| Manage billing, plan, and seats | ✓ | — | — | — | — |
| Transfer ownership or delete workspace | ✓ | — | — | — | — |
| Use mobile app for own assignments | ✓ | ✓ | ✓ | ✓ | ✓ |
| Complete inspections offline (mobile) | ✓ | ✓ | — | — | ✓ |

Workspace setting **Allow Analysts to create connectors** (default off) lets Admins grant Analyst
members connector creation without full Admin rights; Analysts still cannot delete a connector
or change its credentials. Maximum API keys per workspace: Starter 2, Team 10, Business 25,
Enterprise custom.

## Site scoping (Business and Enterprise)

Owners and Admins restrict members to **sites** under **Settings → Members → [member] → Site
scope**: all sites (the default for Owner, Admin, Analyst, Viewer), selected sites, or assigned
only. Field Users are always limited to their own assignments plus assets at those sites. Scoping
applies to dashboards, report exports, API responses, and the mobile app; a scoped API key returns
only permitted rows.

## API keys and audit logging

API key scopes are `read:query`, `read:exports`, and `write:exports`; the default is read-only.
Keys are displayed once and stored hashed, a lost key is rotated rather than recovered, and a key
is deactivated immediately when its creator is removed or loses the role. Rotating a key allows a
24-hour overlap in which the old key still works. All keys share the workspace rate limit; see
[Query API](../api/query-api.md).

The audit log records sign-ins including failures, role and site-scope changes, member invitations
and removals, connector changes, credential rotations, API key events, export creation, deletion
requests, SSO and MFA changes, and billing changes. Logs are not editable and can be exported by
Owner or Admin. Retention is defined in [Data retention](../policies/data-retention.md) **as
amended by the 2026-10 release note**; where they differ, the release note wins.

## Timing and ownership

Role and scope changes take effect within **60 seconds** for active web sessions; removing a
member ends their sessions immediately and revokes their keys. The Owner can transfer ownership to
an existing member and becomes Admin; a workspace always has one Owner, and the Owner cannot be
deleted until ownership is transferred.
