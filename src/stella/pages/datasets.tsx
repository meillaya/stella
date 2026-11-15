import { useRef, useState } from 'react'
import { Modal } from '../../components/base/Modal.js'
import type { Dataset, DatasetCase, DatasetVersion, ExpectedBehavior } from '../../../shared/types.js'
import { api, useApi } from '../api.js'
import { formatDate, formatRelative, pluralize, shortId } from '../format.js'
import { navigate } from '../router.js'
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  LoadingBlock,
  Page,
  PageHeader,
  Tabs,
  type Column,
} from '../ui/index.js'
import { IconDatasets, IconDownload, IconPlus, IconUpload } from '../ui/icons.js'
import {
  BehaviorBadge,
  InlineNotice,
  InputField,
  LoadError,
  SelectField,
  TableFoot,
  TextareaField,
  WorkButton,
  WorkLink,
} from '../workbench/components.js'
import type { DatasetDetailResponse, DatasetListResponse, ImportResponse } from '../workbench/api-types.js'
import {
  anchorDrift,
  caseToDraft,
  datasetDetailUrl,
  datasetExportUrl,
  describeApiError,
  draftToCase,
  emptyCaseDraft,
  newCaseId,
  questionFromCase,
  shortHash,
  validateCaseDraft,
  type AnchorDraft,
  type CaseDraft,
} from '../workbench/lib.js'

/* ------------------------------ list ------------------------------ */

const datasetColumns: Column<Dataset>[] = [
  {
    key: 'name',
    header: 'Dataset',
    render: (dataset) => (
      <div className="st-w-question-cell">
        <div className="st-w-cell-strong">{dataset.name}</div>
        <div className="st-w-sub st-w-clamp">{dataset.description || 'No description.'}</div>
      </div>
    ),
  },
  {
    key: 'cases',
    header: 'Cases',
    width: 90,
    align: 'right',
    render: (dataset) => <span className="st-w-num">{dataset.caseCount}</span>,
  },
  {
    key: 'version',
    header: 'Latest version',
    width: 130,
    render: (dataset) =>
      dataset.latestVersion == null ? (
        <span className="st-faint">No snapshot</span>
      ) : (
        <span className="st-mono">v{dataset.latestVersion}</span>
      ),
  },
  {
    key: 'drift',
    header: 'Anchor drift',
    width: 170,
    render: (dataset) => <DatasetDriftCell datasetId={dataset.id} latestVersion={dataset.latestVersion} />,
  },
  {
    key: 'created',
    header: 'Created',
    width: 120,
    align: 'right',
    render: (dataset) => (
      <span className="st-w-sub" style={{ marginTop: 0 }} title={formatDate(dataset.createdAt)}>
        {formatRelative(dataset.createdAt)}
      </span>
    ),
  },
]

const DatasetDriftCell = ({ datasetId, latestVersion }: { datasetId: string; latestVersion: number | null }) => {
  const detail = useApi<DatasetDetailResponse>(latestVersion == null ? null : datasetDetailUrl(datasetId))
  if (latestVersion == null) {return <span className="st-faint">No snapshot</span>}
  if (detail.error) {
    return (
      <span className="st-faint" title={detail.error}>
        Unknown
      </span>
    )
  }
  if (detail.loading || !detail.data) {return <span className="st-faint">Checking…</span>}
  const version = detail.data.versions.find((item) => item.version === latestVersion) ?? detail.data.versions.at(-1)
  const drift = anchorDrift(version?.anchorStatus)
  return (
    <Badge tone={drift.tone} title={drift.detail}>
      {drift.label}
    </Badge>
  )
}

export const DatasetsPage = () => {
  const datasets = useApi<DatasetListResponse>('/api/datasets')
  const [createOpen, setCreateOpen] = useState(false)

  return (
    <Page className="st-w-page">
      <PageHeader
        title="Datasets"
        description="Versioned evaluation cases with expected behavior and gold anchors. Snapshots are immutable; drafts stay editable."
        actions={
          <WorkButton variant="primary" onClick={() => setCreateOpen(true)}>
            <IconPlus size={14} />
            New dataset
          </WorkButton>
        }
      />

      {datasets.error && !datasets.data ? (
        <LoadError message={datasets.error} onRetry={datasets.reload} />
      ) : datasets.loading && !datasets.data ? (
        <Card>
          <LoadingBlock />
        </Card>
      ) : (datasets.data?.items.length ?? 0) === 0 ? (
        <Card>
          <EmptyState
            icon={<IconDatasets size={18} />}
            title="No datasets yet"
            description="A dataset holds the questions, expected behavior and anchor evidence used by every evaluation run. Create one, add cases, then snapshot a version."
            action={
              <WorkButton variant="primary" onClick={() => setCreateOpen(true)}>
                New dataset
              </WorkButton>
            }
          />
        </Card>
      ) : (
        <Card flush>
          <DataTable
            columns={datasetColumns}
            rows={datasets.data?.items ?? []}
            getKey={(dataset) => dataset.id}
            onRowClick={(dataset) => navigate(`/datasets/${dataset.id}`)}
            ariaLabel="Datasets"
            footer={
              <TableFoot>
                {pluralize(datasets.data?.items.length ?? 0, 'dataset')} · select a row to open cases, versions and drift
                {datasets.error ? ` · refresh failed: ${datasets.error}` : ''}
              </TableFoot>
            }
          />
        </Card>
      )}

      {createOpen ? (
        <NewDatasetModal
          onClose={() => setCreateOpen(false)}
          onCreated={(dataset) => {
            setCreateOpen(false)
            navigate(`/datasets/${dataset.id}`)
          }}
        />
      ) : null}
    </Page>
  )
}

const NewDatasetModal = ({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (dataset: Dataset) => void
}) => {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!name.trim()) {
      setError('A dataset name is required.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const dataset = await api.post<Dataset>('/api/datasets', {
        name: name.trim(),
        description: description.trim(),
      })
      onCreated(dataset)
    } catch (cause) {
      setError(describeApiError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="New dataset"
      closable
      className="st-w-modal st-w-modal-sm"
      onClose={onClose}
      footer={
        <>
          <WorkButton onClick={onClose} disabled={busy}>
            Cancel
          </WorkButton>
          <WorkButton variant="primary" onClick={() => void submit()} disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create dataset'}
          </WorkButton>
        </>
      }
    >
      <div className="st-w-form">
        <InputField
          label="Name"
          value={name}
          maxLength={80}
          placeholder="Support refunds"
          onChange={(event) => setName(event.target.value)}
          hint="Names must be unique in the workbench."
        />
        <TextareaField
          label="Description"
          value={description}
          rows={3}
          placeholder="What this suite covers and where the cases come from."
          onChange={(event) => setDescription(event.target.value)}
        />
        {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      </div>
    </Modal>
  )
}

/* ------------------------------ detail ------------------------------ */

type DetailTab = 'cases' | 'versions'

export const DatasetDetailPage = ({ datasetId }: { datasetId?: string }) => {
  const dataset = useApi<DatasetDetailResponse>(datasetId ? datasetDetailUrl(datasetId) : null)
  const [tab, setTab] = useState<DetailTab>('cases')
  const [editor, setEditor] = useState<{ caseValue?: DatasetCase } | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!datasetId) {
    return (
      <Page className="st-w-page">
        <PageHeader title="Dataset" back={{ label: 'Datasets', onClick: () => navigate('/datasets') }} />
        <Card>
          <EmptyState title="Dataset not found" description="This route has no dataset id." />
        </Card>
      </Page>
    )
  }

  if (dataset.error && !dataset.data) {
    return (
      <Page className="st-w-page">
        <PageHeader title="Dataset" back={{ label: 'Datasets', onClick: () => navigate('/datasets') }} />
        <LoadError message={dataset.error} onRetry={dataset.reload} />
      </Page>
    )
  }

  if ((dataset.loading && !dataset.data) || !dataset.data) {
    return (
      <Page className="st-w-page">
        <PageHeader title="Dataset" back={{ label: 'Datasets', onClick: () => navigate('/datasets') }} />
        <Card>
          <LoadingBlock />
        </Card>
      </Page>
    )
  }

  const detail = dataset.data
  const versions = [...detail.versions].sort((left, right) => right.version - left.version)
  const latest = versions[0] ?? null
  const drift = latest ? anchorDrift(latest.anchorStatus) : null
  const canSnapshot = detail.cases.length > 0

  return (
    <Page className="st-w-page">
      <PageHeader
        back={{ label: 'Datasets', onClick: () => navigate('/datasets') }}
        title={detail.dataset.name}
        description={detail.dataset.description || 'No description yet.'}
        meta={
          <>
            <Badge tone="neutral" outline>
              {pluralize(detail.dataset.caseCount, 'draft case')}
            </Badge>
            <Badge tone="neutral" outline>
              {latest ? `v${latest.version} latest snapshot` : 'No snapshot'}
            </Badge>
            {drift ? (
              <Badge tone={drift.tone} title={drift.detail}>
                {drift.label}
              </Badge>
            ) : null}
            <span className="st-w-sub" style={{ marginTop: 0 }}>
              Created {formatDate(detail.dataset.createdAt)}
            </span>
          </>
        }
        actions={
          <div className="st-w-dataset-actions">
            {latest ? (
              <WorkLink
                href={datasetExportUrl(detail.dataset.id, latest.version)}
                download={`${detail.dataset.name}-v${latest.version}.jsonl`}
                variant="secondary"
              >
                <IconDownload size={14} />
                Export JSONL
              </WorkLink>
            ) : (
              <WorkButton disabled title="Snapshot the dataset before exporting a version.">
                <IconDownload size={14} />
                Export JSONL
              </WorkButton>
            )}
            <WorkButton onClick={() => setImportOpen(true)}>
              <IconUpload size={14} />
              Import JSONL
            </WorkButton>
            <WorkButton
              variant="primary"
              disabled={!canSnapshot}
              title={canSnapshot ? undefined : 'Add at least one case before snapshotting.'}
              onClick={() => setSnapshotOpen(true)}
            >
              Snapshot version
            </WorkButton>
          </div>
        }
      />

      {notice ? (
        <div style={{ marginBottom: 14 }}>
          <InlineNotice tone="success">{notice}</InlineNotice>
        </div>
      ) : null}
      {error ? (
        <div style={{ marginBottom: 14 }}>
          <InlineNotice tone="error">{error}</InlineNotice>
        </div>
      ) : null}
      {dataset.error ? (
        <div style={{ marginBottom: 14 }}>
          <InlineNotice
            tone="error"
            title="Showing the last loaded dataset"
            action={
              <WorkButton size="s" onClick={dataset.reload}>
                Retry
              </WorkButton>
            }
          >
            {dataset.error}
          </InlineNotice>
        </div>
      ) : null}

      {latest ? (
        <div style={{ marginBottom: 16 }}>
          <InlineNotice
        tone={drift?.tone === 'fail' ? 'warn' : drift?.tone === 'pass' ? 'success' : 'info'}
        title={`Anchor status · v${latest.version}`}
      >
            <p className="st-w-notice-para">{drift?.detail}</p>
            {latest.anchorStatus.missing.length > 0 ? (
              <p className="st-w-notice-para">
                Missing:{' '}
                {latest.anchorStatus.missing.slice(0, 6).join(', ')}
                {latest.anchorStatus.missing.length > 6 ? ` and ${latest.anchorStatus.missing.length - 6} more` : ''}
              </p>
            ) : null}
            <p className="st-w-notice-para st-w-muted">
              Anchor resolution is recorded when a version is snapshotted. Re-snapshot after fixing cases to update
              it.
            </p>
          </InlineNotice>
        </div>
      ) : (
        <div style={{ marginBottom: 16 }}>
          <InlineNotice tone="info" title="No snapshot yet">
            Runs evaluate a snapshot, not the editable draft. Add at least one case, then create the first version
            when the set is ready.
          </InlineNotice>
        </div>
      )}

      <Tabs<DetailTab>
        value={tab}
        onChange={setTab}
        items={[
          { value: 'cases', label: 'Cases', count: detail.cases.length },
          { value: 'versions', label: 'Versions', count: versions.length },
        ]}
      />

      {tab === 'cases' ? (
        <Card
          title="Draft cases"
          subtitle="Editable cases are imported, promoted from traces, or written by hand. Snapshot to freeze them."
          flush
          actions={
            <WorkButton size="s" variant="secondary" onClick={() => setEditor({})}>
              <IconPlus size={13} />
              Add case
            </WorkButton>
          }
        >
          <DataTable
            columns={caseColumns}
            rows={detail.cases}
            getKey={(caseValue) => caseValue.id}
            onRowClick={(caseValue) => setEditor({ caseValue })}
            ariaLabel="Dataset cases"
            empty={
              <EmptyState
                icon={<IconDatasets size={18} />}
                title="No cases in this dataset"
                description="Add a case by hand, import JSONL, or promote a real chat trace from the Traces page."
                action={
                  <WorkButton onClick={() => setEditor({})}>Add the first case</WorkButton>
                }
              />
            }
            footer={
              <TableFoot>
                {pluralize(detail.cases.length, 'draft case')} · select a row to edit. Changes affect the next
                snapshot, not existing versions.
              </TableFoot>
            }
          />
        </Card>
      ) : (
        <Card
          title="Versions"
          subtitle="Immutable JSONL snapshots with case counts, anchor resolution and content hashes."
          flush
        >
          <DataTable
            columns={versionColumns(detail.dataset.id)}
            rows={versions}
            getKey={(version) => version.id}
            ariaLabel="Dataset versions"
            empty={
              <EmptyState
                title="No versions yet"
                description="Snapshot the draft cases to create the first immutable version. Runs evaluate a snapshot so results stay reproducible."
              />
            }
            footer={
              <TableFoot>
                {pluralize(versions.length, 'version')} · exports are generated from the exact snapshot file
              </TableFoot>
            }
          />
        </Card>
      )}

      {editor ? (
        <CaseEditorModal
          datasetId={detail.dataset.id}
          caseValue={editor.caseValue}
          onClose={() => setEditor(null)}
          onSaved={(message) => {
            setEditor(null)
            setNotice(message)
            setError(null)
            dataset.reload()
          }}
          onDeleted={() => {
            setEditor(null)
            setNotice('Case deleted.')
            setError(null)
            dataset.reload()
          }}
        />
      ) : null}

      {importOpen ? (
        <ImportModal
          datasetId={detail.dataset.id}
          onClose={() => setImportOpen(false)}
          onImported={(result) => {
            setNotice(`Import finished: ${result.imported} added or replaced, ${result.skipped} skipped.`)
            setError(null)
            dataset.reload()
          }}
        />
      ) : null}

      {snapshotOpen ? (
        <SnapshotModal
          datasetId={detail.dataset.id}
          onClose={() => setSnapshotOpen(false)}
          onCreated={(version) => {
            setSnapshotOpen(false)
            setNotice(`Snapshot v${version.version} created with ${pluralize(version.caseCount, 'case')}.`)
            setError(null)
            dataset.reload()
          }}
        />
      ) : null}
    </Page>
  )
}

const caseColumns: Column<DatasetCase>[] = [
  {
    key: 'question',
    header: 'Question',
    render: (caseValue) => (
      <div className="st-w-question-cell">
        <div className="st-w-cell-strong st-w-clamp">{questionFromCase(caseValue) || '(no question)'}</div>
        <div className="st-w-sub">
          {caseValue.notes ? <span className="st-w-clamp">{caseValue.notes}</span> : shortId(caseValue.id)}
        </div>
      </div>
    ),
  },
  {
    key: 'slices',
    header: 'Slices',
    width: 180,
    render: (caseValue) =>
      caseValue.slices.length > 0 ? (
        <span className="st-w-muted st-small">{caseValue.slices.join(', ')}</span>
      ) : (
        <span className="st-faint">—</span>
      ),
  },
  {
    key: 'behavior',
    header: 'Behavior',
    width: 110,
    render: (caseValue) => <BehaviorBadge behavior={caseValue.expected.behavior} />,
  },
  {
    key: 'anchors',
    header: 'Anchors',
    width: 110,
    render: (caseValue) => {
      const anchors = caseValue.expected.anchors
      return (
        <span
          className="st-w-num"
          title={anchors.length > 0 ? anchors.map((anchor) => anchor.doc).join('\n') : 'No gold anchors'}
        >
          {anchors.length}
        </span>
      )
    },
  },
  {
    key: 'updated',
    header: 'Updated',
    width: 120,
    align: 'right',
    render: (caseValue) => (
      <span className="st-w-sub" style={{ marginTop: 0 }} title={formatDate(caseValue.updatedAt ?? caseValue.createdAt)}>
        {formatRelative(caseValue.updatedAt ?? caseValue.createdAt)}
      </span>
    ),
  },
]

const versionColumns = (datasetId: string): Column<DatasetVersion>[] => [
  {
    key: 'version',
    header: 'Version',
    width: 100,
    render: (version) => <span className="st-w-cell-strong st-mono">v{version.version}</span>,
  },
  {
    key: 'cases',
    header: 'Cases',
    width: 84,
    align: 'right',
    render: (version) => <span className="st-w-num">{version.caseCount}</span>,
  },
  {
    key: 'anchors',
    header: 'Anchors',
    width: 160,
    render: (version) => {
      const drift = anchorDrift(version.anchorStatus)
      return (
        <Badge tone={drift.tone} title={drift.detail}>
          {drift.label}
        </Badge>
      )
    },
  },
  {
    key: 'hash',
    header: 'Content hash',
    width: 130,
    render: (version) => (
      <span className="st-mono st-small" title={version.contentHash}>
        {shortHash(version.contentHash)}
      </span>
    ),
  },
  {
    key: 'notes',
    header: 'Notes',
    render: (version) => (
      <span className="st-w-clamp st-w-muted">{version.notes || <span className="st-faint">No release note.</span>}</span>
    ),
  },
  {
    key: 'created',
    header: 'Created',
    width: 120,
    align: 'right',
    render: (version) => (
      <span className="st-w-sub" style={{ marginTop: 0 }} title={formatDate(version.createdAt)}>
        {formatRelative(version.createdAt)}
      </span>
    ),
  },
  {
    key: 'export',
    header: 'Export',
    width: 88,
    render: (version) => (
      <a
        className="st-link st-small"
        href={datasetExportUrl(datasetId, version.version)}
        download={`${datasetId}-v${version.version}.jsonl`}
      >
        JSONL
      </a>
    ),
  },
]

/* ------------------------------ case editor ------------------------------ */

const CaseEditorModal = ({
  datasetId,
  caseValue,
  onClose,
  onSaved,
  onDeleted,
}: {
  datasetId: string
  caseValue?: DatasetCase
  onClose: () => void
  onSaved: (message: string) => void
  onDeleted: () => void
}) => {
  const [draft, setDraft] = useState<CaseDraft>(() => (caseValue ? caseToDraft(caseValue) : emptyCaseDraft()))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const update = <K extends keyof CaseDraft>(key: K, value: CaseDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  const updateAnchor = (index: number, patch: Partial<AnchorDraft>) =>
    setDraft((current) => ({
      ...current,
      anchors: current.anchors.map((anchor, anchorIndex) =>
        anchorIndex === index ? { ...anchor, ...patch } : anchor
      ),
    }))

  const save = async () => {
    const validation = validateCaseDraft(draft)
    if (validation) {
      setError(validation)
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (caseValue) {
        const payload = draftToCase(draft, {
          id: caseValue.id,
          datasetId,
          existing: caseValue,
          sourceTraceId: caseValue.sourceTraceId,
        })
        await api.patch<DatasetCase>(`/api/cases/${encodeURIComponent(caseValue.id)}`, payload)
        onSaved('Case updated.')
      } else {
        const payload = draftToCase(draft, { id: newCaseId(), datasetId })
        await api.post<DatasetCase>('/api/cases', payload)
        onSaved('Case created.')
      }
    } catch (cause) {
      setError(describeApiError(cause))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!caseValue) {return}
    setBusy(true)
    setError(null)
    try {
      await api.del<{ ok: boolean }>(`/api/cases/${encodeURIComponent(caseValue.id)}`)
      onDeleted()
    } catch (cause) {
      setError(describeApiError(cause))
      setConfirmDelete(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={caseValue ? 'Edit case' : 'New case'}
      closable
      className="st-w-modal"
      mainClassName="st-w-modal-scroll"
      onClose={onClose}
      footer={
        <>
          <WorkButton onClick={onClose} disabled={busy}>
            Cancel
          </WorkButton>
          <WorkButton variant="primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : caseValue ? 'Save case' : 'Create case'}
          </WorkButton>
        </>
      }
    >
      <div className="st-w-form">
        {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
        <TextareaField
          label="Question"
          value={draft.question}
          rows={3}
          placeholder="What a user would ask."
          hint="Saving replaces the case's user messages with this question; system messages are preserved."
          onChange={(event) => update('question', event.target.value)}
        />
        <TextareaField
          label="Expected answer"
          value={draft.answer}
          rows={3}
          placeholder="Optional reference answer used by the rubric and reviewers."
          onChange={(event) => update('answer', event.target.value)}
        />
        <div className="st-w-field-grid">
          <SelectField
            label="Expected behavior"
            value={draft.behavior}
            onChange={(value) => update('behavior', value as ExpectedBehavior)}
            options={[
              { value: 'answer', label: 'Answer from evidence' },
              { value: 'refuse', label: 'Refuse / decline' },
              { value: 'any', label: 'Any behavior' },
            ]}
          />
          <InputField
            label="Minimum citations"
            type="number"
            min={0}
            step={1}
            value={draft.minCitations}
            onChange={(event) => update('minCitations', event.target.value)}
          />
        </div>
        <InputField
          label="Must contain"
          value={draft.mustContain}
          placeholder="five business days, refund"
          hint="Comma separated; each phrase is a deterministic grader."
          onChange={(event) => update('mustContain', event.target.value)}
        />
        <InputField
          label="Must not contain"
          value={draft.mustNotContain}
          placeholder="instant, guaranteed"
          hint="Comma separated phrases that should never appear."
          onChange={(event) => update('mustNotContain', event.target.value)}
        />
        <InputField
          label="Slices"
          value={draft.slices}
          placeholder="billing, refunds"
          hint="Comma separated. Slices drive the per-slice regression table."
          onChange={(event) => update('slices', event.target.value)}
        />
        <div>
          <div className="st-w-field-label-row">
            <span className="st-label">Gold anchors</span>
            <WorkButton
              size="s"
              variant="ghost"
              onClick={() => update('anchors', [...draft.anchors, { doc: '', heading: '' }])}
            >
              <IconPlus size={12} />
              Add anchor
            </WorkButton>
          </div>
          <p className="st-hint" style={{ marginTop: 4 }}>
            Document path plus an optional heading. Anchors are resolved against the corpus at snapshot time.
          </p>
          <div className="st-w-stack-sm">
            {draft.anchors.length === 0 ? (
              <p className="st-hint">No anchors. The case can still pass on behavior and content graders.</p>
            ) : null}
            {draft.anchors.map((anchor, index) => (
              <div className="st-w-anchor-row" key={index}>
                <InputField
                  label={index === 0 ? 'Document' : `Document ${index + 1}`}
                  value={anchor.doc}
                  placeholder="policies/refunds.md"
                  title={anchor.quote ? `Exact quote: ${anchor.quote}` : undefined}
                  onChange={(event) => updateAnchor(index, { doc: event.target.value })}
                />
                <InputField
                  label="Heading"
                  value={anchor.heading}
                  placeholder="Refund timing"
                  onChange={(event) => updateAnchor(index, { heading: event.target.value })}
                />
                <WorkButton
                  size="s"
                  className="st-w-remove"
                  variant="ghost"
                  aria-label={`Remove anchor ${index + 1}`}
                  onClick={() =>
                    update(
                      'anchors',
                      draft.anchors.filter((_, anchorIndex) => anchorIndex !== index)
                    )
                  }
                >
                  Remove
                </WorkButton>
              </div>
            ))}
          </div>
        </div>
        <TextareaField
          label="Notes"
          value={draft.notes}
          rows={2}
          placeholder="Why this case exists, or the source of the expectation."
          onChange={(event) => update('notes', event.target.value)}
        />
        {caseValue ? (
          <div className="st-w-inline-actions" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--st-border)', paddingTop: 12 }}>
            <span className="st-hint">Delete removes the draft case; immutable snapshots are unaffected.</span>
            {confirmDelete ? (
              <span className="st-w-inline-actions">
                <WorkButton variant="danger" size="s" disabled={busy} onClick={() => void remove()}>
                  {busy ? 'Deleting…' : 'Delete case'}
                </WorkButton>
                <WorkButton size="s" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>
                  Keep
                </WorkButton>
              </span>
            ) : (
              <WorkButton size="s" variant="ghost" onClick={() => setConfirmDelete(true)}>
                Delete case
              </WorkButton>
            )}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}

/* ------------------------------ import / snapshot ------------------------------ */

const ImportModal = ({
  datasetId,
  onClose,
  onImported,
}: {
  datasetId: string
  onClose: () => void
  onImported: (result: ImportResponse) => void
}) => {
  const [jsonl, setJsonl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResponse | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const readFile = async (file: File | undefined) => {
    if (!file) {return}
    setError(null)
    try {
      setJsonl(await file.text())
    } catch (cause) {
      setError(`Could not read the file: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  const submit = async () => {
    if (!jsonl.trim()) {
      setError('Paste JSONL or choose a file first.')
      return
    }
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const response = await api.post<ImportResponse>(`/api/datasets/${encodeURIComponent(datasetId)}/import`, {
        jsonl,
      })
      setResult(response)
      if (response.imported > 0) {onImported(response)}
    } catch (cause) {
      setError(describeApiError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Import cases from JSONL"
      closable
      className="st-w-modal"
      mainClassName="st-w-modal-scroll"
      onClose={onClose}
      footer={
        <>
          <WorkButton onClick={onClose} disabled={busy}>
            Close
          </WorkButton>
          <WorkButton variant="primary" onClick={() => void submit()} disabled={busy || !jsonl.trim()}>
            {busy ? 'Importing…' : 'Import JSONL'}
          </WorkButton>
        </>
      }
    >
      <div className="st-w-form">
        <p className="st-w-muted st-small">
          One JSON case per line. Valid cases are inserted or replaced by case id; invalid lines are reported and
          skipped.
        </p>
        <div className="st-w-inline-actions">
          <input
            ref={fileRef}
            type="file"
            accept=".jsonl,.json,text/plain"
            className="st-w-sr-only"
            aria-label="Choose a JSONL file to import"
            onChange={(event) => void readFile(event.target.files?.[0])}
          />
          <WorkButton size="s" onClick={() => fileRef.current?.click()} disabled={busy}>
            <IconUpload size={13} />
            Choose file
          </WorkButton>
          <span className="st-hint">or paste below</span>
        </div>
        <TextareaField
          label="JSONL"
          value={jsonl}
          rows={8}
          placeholder='{"id":"case_...","slices":["billing"],"messages":[{"role":"user","content":"..."}],"expected":{"behavior":"answer","mustContain":[],"mustNotContain":[],"anchors":[],"minCitations":1}}'
          onChange={(event) => setJsonl(event.target.value)}
          hint="The dataset id is assigned by the server; do not include files from another dataset."
        />
        {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
        {result ? (
          <InlineNotice
            tone={result.skipped > 0 ? 'warn' : 'success'}
            title={`Imported ${result.imported}; skipped ${result.skipped}`}
          >
            {result.issues && result.issues.length > 0 ? (
              <ul className="st-w-issue-list">
                {result.issues.slice(0, 6).map((issue, index) => (
                  <li key={index}>
                    {issue.line ? `Line ${issue.line}: ` : ''}
                    {issue.caseId ? `${issue.caseId} · ` : ''}
                    {issue.field ? `${issue.field}: ` : ''}
                    {issue.message}
                  </li>
                ))}
                {result.issues.length > 6 ? <li>…and {result.issues.length - 6} more.</li> : null}
              </ul>
            ) : (
              'All lines were valid.'
            )}
          </InlineNotice>
        ) : null}
      </div>
    </Modal>
  )
}

const SnapshotModal = ({
  datasetId,
  onClose,
  onCreated,
}: {
  datasetId: string
  onClose: () => void
  onCreated: (version: DatasetVersion) => void
}) => {
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const version = await api.post<DatasetVersion>(`/api/datasets/${encodeURIComponent(datasetId)}/snapshot`, {
        notes: notes.trim(),
      })
      onCreated(version)
    } catch (cause) {
      setError(describeApiError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Snapshot dataset"
      closable
      className="st-w-modal st-w-modal-sm"
      onClose={onClose}
      footer={
        <>
          <WorkButton onClick={onClose} disabled={busy}>
            Cancel
          </WorkButton>
          <WorkButton variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Snapshotting…' : 'Create version'}
          </WorkButton>
        </>
      }
    >
      <div className="st-w-form">
        <p className="st-w-muted st-small">
          A snapshot freezes the current draft cases into an immutable JSONL version, resolves gold anchors against
          the corpus, and records a content hash.
        </p>
        <TextareaField
          label="Release note"
          value={notes}
          rows={3}
          placeholder="Why this version exists, or what changed since the last snapshot."
          onChange={(event) => setNotes(event.target.value)}
        />
        {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      </div>
    </Modal>
  )
}
