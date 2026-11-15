# Security and compliance

Last updated: 2026-11-06 · Applies to: Meridian v4.6.x

Meridian processes operational records about equipment, sites, work orders, and field crews. This
page summarizes the security program for customer reviewers; signed contracts govern where they
differ.

## Certifications and attestations

| Attestation | Scope | Availability |
| --- | --- | --- |
| SOC 2 Type II | Security, availability, confidentiality; annual audit period | Report under NDA via trust portal |
| Annual third-party penetration test | Web app, API, cloud infrastructure | Summary under NDA |
| GDPR / UK GDPR | Processor obligations | DPA and standard contractual clauses |

Meridian does **not** support HIPAA workloads and does not sign business associate agreements; do
not store protected health information. Payment card data is handled by the payment processor.
Attestations and questionnaire answers are at `https://trust.meridian.example`.

## Encryption, credentials, and identity

TLS 1.3 on all external endpoints (TLS 1.2 minimum for legacy connector paths); AES-256-GCM for
databases, object storage, and backups; connector secrets and API keys encrypted with a
per-workspace key-encryption key and never displayed after saving; root keys rotated every 90 days
with logged, restricted access; mobile data encrypted at rest with an OS-protected key. Passwords
are hashed with Argon2id and checked against a breached-password list; five failed sign-ins lock an
account for 15 minutes. MFA (TOTP) is available on every plan and can be enforced by an Owner or
Admin. SSO (SAML 2.0 or OIDC) requires Business or Enterprise; SCIM provisioning and IP allowlisting
require Enterprise. The session timeout defaults to 12 hours and is configurable from 1 to 24 hours
on Business and Enterprise. Removing a member revokes sessions and API keys immediately. RBAC and
the five roles are described in [Permissions and roles](../access/permissions-roles.md).

## Regions and data residency

| Region | Location | Applies to |
| --- | --- | --- |
| United States | N. Virginia | Workspaces that selected US at creation |
| European Union | Frankfurt | Workspaces that selected EU at creation |

A workspace's region is permanent. Connector data is processed and stored in the workspace region;
backups and disaster-recovery replicas stay in the same region. Support access is granted per
incident with customer approval and is audit-logged.

## Audit logging and vulnerability management

A tamper-evident audit log records sign-in success and failure, MFA and SSO changes, role and
site-scope changes, member invitations and removals, connector credential changes, API key events,
export creation, and deletion requests; it is exportable by Owner or Admin. Retention follows
[Data retention](../policies/data-retention.md) as amended by the November 2026 policy update in
[Release notes, October 2026](../release-notes/2026-10.md).

Third-party penetration testing runs at least annually. Critical vulnerabilities are remediated
within **14 days** of confirmation, high severity within **30 days**, and medium/low by risk.
Dependency and container scanning is continuous; externally reachable services are authenticated
and rate limited. Report vulnerabilities to `security@meridian.example`; Meridian follows a
**90-day coordinated disclosure** window and will not pursue good-faith research that respects the
disclosure policy.

## Incidents, subprocessors, and customer data

The security team runs a 24×7 on-call rotation. If a personal data breach is confirmed, affected
workspace Owners and Admins are notified without undue delay and within **72 hours** of
confirmation, with what happened, the data categories involved, and remediation steps;
multi-customer incidents receive a public post-incident review. Subprocessors cover cloud hosting,
email delivery, error monitoring, and payment processing, and the list is published in the trust
portal; customers under a DPA receive at least **30 days' notice** before a new subprocessor that
processes customer data is engaged and may object as described in the DPA. Customer data is
processed only to provide and secure the service, is not sold, and is **not used to train Meridian
models or third-party models**; Meridian does not process customer data with external AI model
providers, and web-app analytics exclude customer record contents.

## Backups

Nightly encrypted backups are retained 35 days, consistent with
[Data retention](../policies/data-retention.md). Business and Enterprise have an RPO of
**15 minutes** and an RTO of **4 hours**; Starter and Team are recovered best-effort. Restore
procedures are in [Reporting and exports](../product/reporting-exports.md). Security
questionnaires, SOC 2 reports, DPA templates, and the subprocessor list are available through
the trust portal or your account team.
