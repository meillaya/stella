import { useEffect, useRef, useState } from 'react'
import { Modal } from '../../components/base/Modal.js'
import { Markdown } from '../../components/markdown/Markdown.js'
import type { Gate, Run, RunItem } from '../../../shared/types.js'
import { api, useApi } from '../api.js'
import { formatDate, formatDuration, formatRelative, percent, shortId } from '../format.js'
import { href, navigate, withQuery } from '../router.js'
import {
  Badge,
  Card,
  DataTable,
  Delta,
  EmptyState,
  KeyValue,
  LoadingBlock,
  Page,
  PageHeader,
  Stat,
  StellaBar,
  Tabs,
  type Column,
} from '../ui/index.js'
import { IconRuns } from '../ui/icons.js'
import {
  InlineNotice,
  InputField,
  LoadError,
  RunStatusBadge,
  SourceList,
  TableFoot,
  TokenBreakdown,
  WorkButton,
  WorkLink,
  ConfirmModal,
} from '../workbench/components.js'
import type {
  CompareResponse,
  GateListResponse,
  RunItemsResponse,
  RunListResponse,
} from '../workbench/api-types.js'
import { DatasetVersionFields, ProfileField, useDatasetVersionChoices, useProfileChoices } from '../workbench/data.js'
import {
  confidenceLabel,
  costPerAnswer,
  describeApiError,
  filterRunItems,
  formatUsd,
  gateArtifactUrl,
  gateForRun,
  gateThreshold,
  retrievalLabel,
  runElapsedMs,
  runIsActive,
  type RunItemFilter,
} from '../workbench/lib.js'

/* ------------------------------ list ------------------------------ */

const runColumns: Column<Run>[] = [
  {
    key: 'run',
    header: 'Run',
    render: (run) => (
      <div className="st-w-question-cell">
        <div className="st-w-cell-strong">
          {run.datasetName} <span className="st-faint">v{run.datasetVersion}</span>
        </div>
        <div className="st-w-sub">
          <span className="st-mono">{shortId(run.id)}</span> · {run.profileName} · {run.mode}
        </div>
      </div>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    width: 112,
    render: (run) => <RunStatusBadge status={run.status} />,
  },
  {
    key: 'passRate',
    header: 'Pass rate',
    width: 170,
    render: (run) =>
      run.summary ? (
        <div>
          <span className="st-w-num-strong">{percent(run.summary.passRate)}</span>
          <div className="st-w-sub">
            CI {percent(run.summary.ciLow)}–{percent(run.summary.ciHigh)} · {run.summary.cases} cases
          </div>
        </div>
      ) : (
        <span className="st-faint">—</span>
      ),
  },
  {
    key: 'cost',
    header: 'Cost',
    width: 92,
    align: 'right',
    render: (run) => <span className="st-w-num">{run.summary ? formatUsd(run.summary.costUsd) : '—'}</span>,
  },
  {
    key: 'created',
    header: 'Created',
    width: 124,
    align: 'right',
    render: (run) => (
      <span className="st-w-sub" style={{ marginTop: 0 }} title={formatDate(run.createdAt)}>
        {formatRelative(run.createdAt)}
      </span>
    ),
  },
]

export const RunsPage = ({ openNew = false }: { openNew?: boolean }) => {
  const runs = useApi<RunListResponse>('/api/runs')
  const [newOpen, setNewOpen] = useState(openNew)

  useEffect(() => {
    if (openNew) {setNewOpen(true)}
  }, [openNew])

  const closeNew = () => {
    setNewOpen(false)
    if (openNew) {navigate('/runs', { replace: true })}
  }

  return (
    <Page className="st-w-page">
      <PageHeader
        title="Runs"
        description="Evaluation runs over an immutable dataset version and a profile. Pass rates carry their 95% interval; cost and latency are recorded per case."
        actions={
          <>
            <WorkLink href={href('/runs/compare')} variant="secondary">
              Compare runs
            </WorkLink>
            <WorkButton variant="primary" onClick={() => setNewOpen(true)}>
              <IconRuns size={15} />
              New evaluation
            </WorkButton>
          </>
        }
      />

      {runs.error && !runs.data ? (
        <LoadError message={runs.error} onRetry={runs.reload} />
      ) : runs.loading && !runs.data ? (
        <Card>
          <LoadingBlock />
        </Card>
      ) : (runs.data?.items.length ?? 0) === 0 ? (
        <Card>
          <EmptyState
            icon={<IconRuns size={18} />}
            title="No evaluation runs yet"
            description="Create a run to score the dataset against a profile. Runs execute asynchronously; this table updates with pass rate, cost and timing when they finish."
            action={
              <WorkButton variant="primary" onClick={() => setNewOpen(true)}>
                New evaluation
              </WorkButton>
            }
          />
        </Card>
      ) : (
        <Card flush>
          <DataTable
            columns={runColumns}
            rows={runs.data?.items ?? []}
            getKey={(run) => run.id}
            onRowClick={(run) => navigate(`/runs/${run.id}`)}
            ariaLabel="Evaluation runs"
            footer={
              <TableFoot
                actions={
                  <WorkButton size="s" onClick={runs.reload} disabled={runs.loading}>
                    {runs.loading ? 'Refreshing…' : 'Refresh'}
                  </WorkButton>
                }
              >
                {runs.data?.items.length} run{(runs.data?.items.length ?? 0) === 1 ? '' : 's'} · select a row to
                inspect the scorecard and per-case results
              </TableFoot>
            }
          />
        </Card>
      )}

      {runs.error && runs.data ? (
        <div style={{ marginTop: 14 }}>
          <InlineNotice tone="error" title="Showing the last loaded runs">
            {runs.error}
          </InlineNotice>
        </div>
      ) : null}

      {newOpen ? (
        <NewRunModal
          onClose={closeNew}
          onCreated={(run) => {
            setNewOpen(false)
            navigate(`/runs/${run.id}`)
          }}
        />
      ) : null}
    </Page>
  )
}

const NewRunModal = ({ onClose, onCreated }: { onClose: () => void; onCreated: (run: Run) => void }) => {
  const datasets = useDatasetVersionChoices()
  const profiles = useProfileChoices()
  const [budget, setBudget] = useState('')
  const [offPeak, setOffPeak] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const budgetValue = Number(budget)
  const canSubmit =
    Boolean(datasets.versionId) && Boolean(profiles.profileId) && Number.isFinite(budgetValue) && budgetValue > 0

  const submit = async () => {
    if (!canSubmit) {return}
    setBusy(true)
    setError(null)
    try {
      const run = await api.post<Run>('/api/runs', {
        datasetVersionId: datasets.versionId,
        profileId: profiles.profileId,
        budgetUsd: budgetValue,
        offPeak,
      })
      onCreated(run)
    } catch (cause) {
      setError(describeApiError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="New evaluation run"
      closable
      className="st-w-modal"
      mainClassName="st-w-modal-scroll"
      onClose={onClose}
      footer={
        <>
          <WorkButton onClick={onClose} disabled={busy}>
            Cancel
          </WorkButton>
          <WorkButton
            variant="primary"
            onClick={() => void submit()}
            disabled={busy || !canSubmit}
            title={
              !canSubmit
                ? 'Choose a dataset version and profile, and enter a budget above zero.'
                : undefined
            }
          >
            {busy ? 'Starting…' : 'Start run'}
          </WorkButton>
        </>
      }
    >
      <div className="st-w-form">
        <p className="st-w-muted st-small">
          The runner executes asynchronously and stops before the budget cap. The detail page polls while the run is
          queued or running.
        </p>
        <DatasetVersionFields choices={datasets} disabled={busy} />
        <ProfileField choices={profiles} disabled={busy} />
        <div className="st-w-field-grid">
          <InputField
            label="Budget (USD)"
            type="number"
            min={0.01}
            step={0.01}
            value={budget}
            placeholder="2.00"
            onChange={(event) => setBudget(event.target.value)}
            hint="Hard cap for this run. Existing cost data is not a prediction; the runner enforces the limit."
          />
          <div className="st-field">
            <span className="st-label">Pricing</span>
            <label className="st-w-checkbox">
              <input type="checkbox" checked={offPeak} onChange={(event) => setOffPeak(event.target.checked)} />
              <span>
                Prefer off-peak pricing
                <span className="st-hint" style={{ display: 'block' }}>
                  Peak windows are Mon–Fri 01:00–04:00 and 06:00–10:00 UTC, excluding CN holidays. The recorded basis
                  stays visible on each run.
                </span>
              </span>
            </label>
          </div>
        </div>
        {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
        {!canSubmit ? (
          <p className="st-hint">
            Choose a dataset version and profile, then enter a positive budget to enable Start run.
          </p>
        ) : null}
      </div>
    </Modal>
  )
}

/* ------------------------------ run detail ------------------------------ */

const runItemColumns: Column<RunItem>[] = [
  {
    key: 'case',
    header: 'Case',
    render: (item) => (
      <div className="st-w-question-cell">
        <div className="st-w-cell-strong st-mono st-w-nowrap">{shortId(item.caseId)}</div>
        <div className="st-w-sub">{item.slices.length > 0 ? item.slices.join(', ') : 'No slice'}</div>
      </div>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    width: 100,
    render: (item) => (
      <Badge tone={item.status === 'ok' ? 'pass' : item.status === 'error' ? 'fail' : 'neutral'} outline>
        {item.status === 'ok' ? 'OK' : item.status === 'error' ? 'Error' : 'Skipped'}
      </Badge>
    ),
  },
  {
    key: 'pass',
    header: 'Result',
    width: 92,
    render: (item) => (
      <Badge tone={item.pass ? 'pass' : 'fail'}>{item.pass ? 'Pass' : 'Fail'}</Badge>
    ),
  },
  {
    key: 'cost',
    header: 'Cost',
    width: 84,
    align: 'right',
    render: (item) => <span className="st-w-num">{formatUsd(item.costUsd)}</span>,
  },
  {
    key: 'latency',
    header: 'Latency',
    width: 96,
    align: 'right',
    render: (item) => <span className="st-w-num">{formatDuration(item.latencyMs)}</span>,
  },
  {
    key: 'graders',
    header: 'Graders',
    width: 200,
    render: (item) => {
      const failed = item.graderResults.filter((grader) => !grader.pass)
      if (failed.length === 0) {return <span className="st-faint">All passed</span>}
      return (
        <div className="st-row st-wrap">
          {failed.slice(0, 3).map((grader) => (
            <Badge key={grader.graderId} tone="fail">
              {grader.kind}
            </Badge>
          ))}
          {failed.length > 3 ? <span className="st-hint">+{failed.length - 3}</span> : null}
        </div>
      )
    },
  },
  {
    key: 'answer',
    header: 'Answer',
    render: (item) => <span className="st-w-clamp st-w-muted">{item.answer || item.error || 'No answer'}</span>,
  },
]

export const RunDetailPage = ({ runId }: { runId?: string }) => {
  const runDetail = useApi<Run>(runId ? `/api/runs/${encodeURIComponent(runId)}` : null)
  const active = runIsActive(runDetail.data?.status)
  const items = useApi<RunItemsResponse>(runId ? `/api/runs/${encodeURIComponent(runId)}/items` : null, {
    pollMs: active ? 1500 : undefined,
  })
  const runs = useApi<RunListResponse>('/api/runs')
  const gates = useApi<GateListResponse>('/api/gates')
  const [filter, setFilter] = useState<RunItemFilter>('all')
  const [selectedItem, setSelectedItem] = useState<RunItem | null>(null)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [gateOpen, setGateOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Poll the run itself only after the first response tells us it is active.
  const reloadRun = runDetail.reload
  useEffect(() => {
    if (active && runId) {
      const timer = window.setInterval(() => reloadRun(), 1500)
      return () => window.clearInterval(timer)
    }
    return undefined
  }, [active, runId, reloadRun])

  if (!runId) {
    return (
      <Page className="st-w-page">
        <PageHeader title="Run" back={{ label: 'Runs', onClick: () => navigate('/runs') }} />
        <Card>
          <EmptyState title="Run not found" description="This route has no run id." />
        </Card>
      </Page>
    )
  }

  if (runDetail.error && !runDetail.data) {
    return (
      <Page className="st-w-page">
        <PageHeader title={`Run ${shortId(runId)}`} back={{ label: 'Runs', onClick: () => navigate('/runs') }} />
        <LoadError message={runDetail.error} onRetry={runDetail.reload} />
      </Page>
    )
  }

  if ((runDetail.loading && !runDetail.data) || !runDetail.data) {
    return (
      <Page className="st-w-page">
        <PageHeader title={`Run ${shortId(runId)}`} back={{ label: 'Runs', onClick: () => navigate('/runs') }} />
        <Card>
          <LoadingBlock />
        </Card>
      </Page>
    )
  }

  const run = runDetail.data
  const summary = run.summary
  const gate = gateForRun(run.id, gates.data?.items)
  const threshold = gateThreshold(gate)
  const allItems = items.data?.items ?? []
  const visibleItems = filterRunItems(allItems, filter)
  const failedCount = allItems.filter((item) => !item.pass).length
  const errorCount = allItems.filter((item) => item.status === 'error').length
  const baselineOptions = (runs.data?.items ?? [])
    .filter((candidate) => candidate.status === 'done' && candidate.id !== run.id)
    .sort((left, right) => right.createdAt - left.createdAt)
  const canGate = run.status === 'done' && Boolean(summary) && baselineOptions.length > 0
  const elapsed = runElapsedMs(run)

  const cancel = async () => {
    setCancelling(true)
    setActionError(null)
    try {
      await api.post<Run>(`/api/runs/${encodeURIComponent(run.id)}/cancel`)
      setCancelOpen(false)
      setNotice('Cancellation requested.')
      runDetail.reload()
      items.reload()
    } catch (cause) {
      setActionError(describeApiError(cause))
    } finally {
      setCancelling(false)
    }
  }

  return (
    <Page className="st-w-page">
      <PageHeader
        back={{ label: 'Runs', onClick: () => navigate('/runs') }}
        title={`${run.profileName} on ${run.datasetName} v${run.datasetVersion}`}
        description={`Run ${shortId(run.id)}${run.summary ? ` · ${run.summary.cases} cases` : ''}.`}
        meta={
          <>
            <RunStatusBadge status={run.status} />
            <Badge tone="neutral" outline>
              {run.provider === run.mode ? run.mode : `${run.provider} · ${run.mode}`}
            </Badge>
            <Badge tone="neutral" outline>
              Budget {formatUsd(run.budgetUsd)}
            </Badge>
            <span className="st-w-sub" style={{ marginTop: 0 }} title={formatDate(run.createdAt)}>
              Started {formatRelative(run.startedAt ?? run.createdAt)}
            </span>
            {elapsed != null ? <span className="st-w-sub" style={{ marginTop: 0 }}>Elapsed {formatDuration(elapsed)}</span> : null}
          </>
        }
        actions={
          <>
            <WorkButton
              disabled={run.status !== 'done'}
              title={run.status === 'done' ? undefined : 'Comparison is available after the run finishes.'}
              onClick={() => navigate(withQuery('/runs/compare', { candidate: run.id }))}
            >
              Compare
            </WorkButton>
            <WorkButton
              disabled={!canGate}
              title={
                run.status !== 'done'
                  ? 'The gate is available when this run finishes.'
                  : !summary
                    ? 'The run has no summary to gate.'
                    : baselineOptions.length === 0
                      ? 'A second completed run is required as the baseline.'
                      : undefined
              }
              onClick={() => setGateOpen(true)}
            >
              Evaluate gate
            </WorkButton>
            {runIsActive(run.status) ? (
              <WorkButton
                variant="danger"
                onClick={() => {
                  setActionError(null)
                  setCancelOpen(true)
                }}
              >
                Cancel run
              </WorkButton>
            ) : (
              <WorkButton variant="primary" onClick={() => navigate(withQuery('/runs', { new: 1 }))}>
                New evaluation
              </WorkButton>
            )}
          </>
        }
      />

      {notice ? (
        <div style={{ marginBottom: 14 }}>
          <InlineNotice tone="success">{notice}</InlineNotice>
        </div>
      ) : null}
      {actionError ? (
        <div style={{ marginBottom: 14 }}>
          <InlineNotice tone="error">{actionError}</InlineNotice>
        </div>
      ) : null}
      {runDetail.error ? (
        <div style={{ marginBottom: 14 }}>
          <InlineNotice
            tone="error"
            title="Showing the last loaded run"
            action={
              <WorkButton size="s" onClick={runDetail.reload}>
                Retry
              </WorkButton>
            }
          >
            {runDetail.error}
          </InlineNotice>
        </div>
      ) : null}
      {run.error ? (
        <div style={{ marginBottom: 14 }}>
          <InlineNotice tone="error" title="The runner reported an error">
            {run.error}
          </InlineNotice>
        </div>
      ) : null}

      {runIsActive(run.status) ? (
        <div style={{ marginBottom: 16 }} aria-live="polite">
          <InlineNotice tone="info" title={run.status === 'queued' ? 'Run queued' : 'Run in progress'}>
            {allItems.length} case{allItems.length === 1 ? '' : 's'} recorded so far. This page polls the run and its
            items every 1.5 seconds; cancellation is available above.
          </InlineNotice>
        </div>
      ) : null}

      {run.status === 'cancelled' && !summary ? (
        <div style={{ marginBottom: 16 }}>
          <InlineNotice tone="warn" title="Run cancelled">
            No summary was recorded. Completed items remain visible below.
          </InlineNotice>
        </div>
      ) : null}

      {summary ? (
        <div className="st-stack">
          <Card
            title="Scorecard"
            subtitle={`${run.datasetName} v${run.datasetVersion} · ${run.profileName} · ${confidenceLabel(summary)}`}
            actions={
              gate ? (
                <Badge tone={gate.result.pass ? 'pass' : 'fail'} dot>
                  Gate {gate.result.pass ? 'passed' : 'blocked'}
                </Badge>
              ) : (
                <Badge tone="neutral" outline>
                  No gate
                </Badge>
              )
            }
          >
            <div className="st-w-scorecard-top">
              <div className="st-w-signal">
                <div className="st-w-signal-head">
                  <span>Overall pass rate</span>
                  <span className="st-w-signal-value">{percent(summary.passRate)}</span>
                </div>
                <StellaBar
                  value={summary.passRate}
                  low={summary.ciLow}
                  high={summary.ciHigh}
                  threshold={threshold}
                  caption={gate ? `Gate threshold ${percent(threshold, 0)}` : `Default threshold ${percent(threshold, 0)}`}
                />
                <div className="st-w-inline-actions">
                  <span className="st-hint">
                    {summary.pass}/{summary.cases} cases passed · {summary.graderErrors} grader error
                    {summary.graderErrors === 1 ? '' : 's'}
                  </span>
                </div>
              </div>
              <div className="st-w-metric-grid">
                <div className="st-w-metric">
                  <span className="st-w-metric-label">Cost / answer</span>
                  <span className="st-w-metric-value">{formatUsd(costPerAnswer(run))}</span>
                  <span className="st-w-metric-foot">{formatUsd(summary.costUsd)} total</span>
                </div>
                <div className="st-w-metric">
                  <span className="st-w-metric-label">Cost / pass</span>
                  <span className="st-w-metric-value">{formatUsd(summary.costPerPassUsd)}</span>
                  <span className="st-w-metric-foot">budget {formatUsd(run.budgetUsd)}</span>
                </div>
                <div className="st-w-metric">
                  <span className="st-w-metric-label">p50 latency</span>
                  <span className="st-w-metric-value">{formatDuration(summary.p50LatencyMs)}</span>
                </div>
                <div className="st-w-metric">
                  <span className="st-w-metric-label">p95 latency</span>
                  <span className="st-w-metric-value">{formatDuration(summary.p95LatencyMs)}</span>
                </div>
                <div className="st-w-metric">
                  <span className="st-w-metric-label">Judge agreement</span>
                  <span className="st-w-metric-value">
                    {summary.judgeAgreement == null ? '—' : percent(summary.judgeAgreement)}
                  </span>
                  <span className="st-w-metric-foot">
                    {summary.judgeKappa == null ? 'kappa not available' : `kappa ${summary.judgeKappa.toFixed(2)}`}
                  </span>
                </div>
                <div className="st-w-metric">
                  <span className="st-w-metric-label">Retrieval</span>
                  <span className="st-w-metric-value" style={{ fontSize: 13 }}>
                    {retrievalLabel(summary.retrieval)}
                  </span>
                  <span className="st-w-metric-foot">graded retrieval metrics</span>
                </div>
              </div>
            </div>

            <div style={{ marginTop: 16 }}>
              {gate ? (
                <InlineNotice
                  tone={gate.result.pass ? 'success' : 'error'}
                  title={`Gate ${gate.result.pass ? 'PASS' : 'BLOCKED'} · ${gate.config.suite}`}
                  action={
                    <WorkLink
                      href={gateArtifactUrl(gate.id, 'md')}
                      download={`gate-${gate.id}.md`}
                      variant="ghost"
                      className="st-w-btn-s"
                    >
                      Artifact
                    </WorkLink>
                  }
                >
                  {gate.result.failures.length > 0 ? (
                    <ul className="st-w-issue-list">
                      {gate.result.failures.map((failure) => (
                        <li key={failure.rule}>{failure.message}</li>
                      ))}
                    </ul>
                  ) : gate.result.warnings.length > 0 ? (
                    <ul className="st-w-issue-list">
                      {gate.result.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  ) : (
                    'No blocking failures or warnings were recorded.'
                  )}
                </InlineNotice>
              ) : (
                <InlineNotice tone="info">
                  No gate has been evaluated for this run. Use “Evaluate gate” to compare it with a baseline and
                  produce an artifact.
                </InlineNotice>
              )}
            </div>
          </Card>

          <Card title="Per-slice scorecard" subtitle="Pass rate against the same threshold as the overall bar." flush>
            <DataTable
              columns={sliceColumns(threshold)}
              rows={Object.entries(summary.slices ?? {})
                .map(([slice, value]) => ({ slice, ...value }))
                .sort((left, right) => left.slice.localeCompare(right.slice))}
              getKey={(row) => row.slice}
              ariaLabel="Per-slice metrics"
              empty="No slices were declared on the cases in this version."
              footer={<TableFoot>Slice pass rates use the run’s cases only; small slices are noisy.</TableFoot>}
            />
          </Card>
        </div>
      ) : run.status === 'done' ? (
        <InlineNotice tone="warn" title="Run completed without a summary">
          The backend reported a completed run but returned no scorecard. Items below are still inspectable; this is
          inconsistent server state, not a quality result.
        </InlineNotice>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <Tabs<RunItemFilter>
          value={filter}
          onChange={setFilter}
          items={[
            { value: 'all', label: 'All cases', count: allItems.length },
            { value: 'failed', label: 'Failed', count: failedCount },
            { value: 'errors', label: 'Errors', count: errorCount },
          ]}
        />
        {items.error && items.data ? (
          <div style={{ marginBottom: 12 }}>
            <InlineNotice
              tone="error"
              title="Showing the last loaded cases"
              action={
                <WorkButton size="s" onClick={items.reload}>
                  Retry
                </WorkButton>
              }
            >
              {items.error}
            </InlineNotice>
          </div>
        ) : null}
        <Card flush>
          {items.error && !items.data ? (
            <div style={{ padding: 18 }}>
              <LoadError message={items.error} onRetry={items.reload} />
            </div>
          ) : (
            <DataTable
              columns={runItemColumns}
              rows={visibleItems}
              getKey={(item) => item.id}
              onRowClick={(item) => setSelectedItem(item)}
              ariaLabel="Run cases"
              loading={items.loading && !items.data}
              empty={
                allItems.length === 0
                  ? runIsActive(run.status)
                    ? 'Cases appear as the runner completes them.'
                    : 'No cases were recorded for this run.'
                  : filter === 'failed'
                    ? 'No failed cases in this filter.'
                    : filter === 'errors'
                      ? 'No transport errors in this filter.'
                      : 'No cases match this filter.'
              }
              footer={
                <TableFoot>
                  {visibleItems.length} of {allItems.length} case{allItems.length === 1 ? '' : 's'} shown · select a
                  row to inspect the answer and graders
                </TableFoot>
              }
            />
          )}
        </Card>
      </div>

      {selectedItem ? <RunItemModal item={selectedItem} onClose={() => setSelectedItem(null)} /> : null}

      {cancelOpen ? (
        <ConfirmModal
          title="Cancel this run?"
          confirmLabel="Cancel run"
          tone="danger"
          busy={cancelling}
          error={actionError}
          onClose={() => setCancelOpen(false)}
          onConfirm={() => void cancel()}
        >
          <p className="st-w-muted">
            Cancellation stops the runner at the next case boundary. Completed items and spend stay recorded; the run
            is marked cancelled.
          </p>
        </ConfirmModal>
      ) : null}

      {gateOpen ? (
        <GateModal
          run={run}
          baselines={baselineOptions}
          onClose={() => setGateOpen(false)}
          onCompleted={() => {
            gates.reload()
            setNotice('Gate evaluated.')
          }}
        />
      ) : null}
    </Page>
  )
}

const sliceColumns = (threshold: number): Column<{
  slice: string
  cases: number
  passRate: number
  costUsd: number
  p95LatencyMs: number
}>[] => [
  {
    key: 'slice',
    header: 'Slice',
    render: (row) => <span className="st-w-cell-strong">{row.slice}</span>,
  },
  {
    key: 'cases',
    header: 'Cases',
    width: 80,
    align: 'right',
    render: (row) => <span className="st-w-num">{row.cases}</span>,
  },
  {
    key: 'rate',
    header: 'Pass rate',
    width: 240,
    render: (row) => (
      <div className="st-w-inline-actions" style={{ flexWrap: 'nowrap' }}>
        <span className="st-w-slice-bar">
          <StellaBar compact value={row.passRate} threshold={threshold} />
        </span>
        <span className="st-w-num-strong">{percent(row.passRate)}</span>
      </div>
    ),
  },
  {
    key: 'p95',
    header: 'p95',
    width: 104,
    align: 'right',
    render: (row) => <span className="st-w-num">{formatDuration(row.p95LatencyMs)}</span>,
  },
  {
    key: 'cost',
    header: 'Cost',
    width: 92,
    align: 'right',
    render: (row) => <span className="st-w-num">{formatUsd(row.costUsd)}</span>,
  },
]

const RunItemModal = ({ item, onClose }: { item: RunItem; onClose: () => void }) => {
  const failed = item.graderResults.filter((grader) => !grader.pass)
  return (
    <Modal
      title={`Case ${shortId(item.caseId)}`}
      closable
      className="st-w-modal"
      mainClassName="st-w-modal-scroll"
      onClose={onClose}
      footer={<WorkButton onClick={onClose}>Close</WorkButton>}
    >
      <div className="st-w-stack-sm">
        <div className="st-w-run-head">
          <Badge tone={item.pass ? 'pass' : 'fail'}>{item.pass ? 'Pass' : 'Fail'}</Badge>
          <Badge tone="neutral" outline>
            {item.status}
          </Badge>
          <span className="st-hint">
            {item.slices.length > 0 ? item.slices.join(', ') : 'No slice'} · {formatUsd(item.costUsd)} ·{' '}
            {formatDuration(item.latencyMs)}
          </span>
        </div>
        {item.error ? <InlineNotice tone="error">{item.error}</InlineNotice> : null}
        <div className="st-w-markdown">
          {item.answer ? (
            <Markdown
              content={item.answer}
              loading={false}
              cacheKey={`run-item-${item.id}`}
              disableLink
            />
          ) : (
            <p className="st-muted st-small">No answer was recorded for this case.</p>
          )}
        </div>
        <div className="st-w-item-facts">
          <div className="st-w-metric">
            <span className="st-w-metric-label">Status</span>
            <span className="st-w-metric-value" style={{ fontSize: 14 }}>
              {item.status}
            </span>
          </div>
          <div className="st-w-metric">
            <span className="st-w-metric-label">Cost</span>
            <span className="st-w-metric-value">{formatUsd(item.costUsd)}</span>
          </div>
          <div className="st-w-metric">
            <span className="st-w-metric-label">Latency</span>
            <span className="st-w-metric-value">{formatDuration(item.latencyMs)}</span>
          </div>
        </div>
        <div>
          <div className="st-label" style={{ marginBottom: 6 }}>
            Graders · {failed.length} failed
          </div>
          {item.graderResults.length === 0 ? (
            <p className="st-hint">No grader results were recorded.</p>
          ) : (
            <div className="st-w-grader-list">
              {item.graderResults.map((grader) => (
                <div key={grader.graderId} className="st-w-grader-row" data-fail={!grader.pass}>
                  <Badge tone={grader.pass ? 'pass' : 'fail'}>{grader.pass ? 'Pass' : 'Fail'}</Badge>
                  <span className="st-w-grader-name">{grader.kind}</span>
                  {grader.score != null ? <span className="st-w-num">{grader.score.toFixed(2)}</span> : null}
                  <span className="st-w-grader-detail">{grader.error ?? grader.detail ?? ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {item.retrieval ? (
          <KeyValue
            items={[
              { label: 'Retrieval evaluated', value: String(item.retrieval.evaluated) },
              { label: 'Recall@k', value: item.retrieval.recallAtK == null ? '—' : percent(item.retrieval.recallAtK) },
              { label: 'MRR', value: item.retrieval.mrr == null ? '—' : item.retrieval.mrr.toFixed(3) },
            ]}
          />
        ) : null}
        <div>
          <div className="st-label" style={{ marginBottom: 6 }}>
            Sources
          </div>
          <SourceList sources={item.sources} />
        </div>
        <details className="st-w-details">
          <summary>Token usage</summary>
          <TokenBreakdown usage={item.usage} />
        </details>
      </div>
    </Modal>
  )
}

const GateModal = ({
  run,
  baselines,
  onClose,
  onCompleted,
}: {
  run: Run
  baselines: Run[]
  onClose: () => void
  onCompleted: () => void
}) => {
  const [baselineId, setBaselineId] = useState(baselines[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Gate | null>(null)

  useEffect(() => {
    if (!baselineId && baselines[0]) {setBaselineId(baselines[0].id)}
  }, [baselineId, baselines])

  const submit = async () => {
    if (!baselineId) {return}
    setBusy(true)
    setError(null)
    try {
      const gate = await api.post<Gate>('/api/gates', {
        baselineRunId: baselineId,
        candidateRunId: run.id,
      })
      setResult(gate)
      onCompleted()
    } catch (cause) {
      setError(describeApiError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Evaluate release gate"
      closable
      className="st-w-modal st-w-modal-sm"
      onClose={onClose}
      footer={
        result ? (
          <WorkButton onClick={onClose}>Close</WorkButton>
        ) : (
          <>
            <WorkButton onClick={onClose} disabled={busy}>
              Cancel
            </WorkButton>
            <WorkButton
              variant="primary"
              disabled={busy || !baselineId}
              title={!baselineId ? 'Choose a baseline run.' : undefined}
              onClick={() => void submit()}
            >
              {busy ? 'Evaluating…' : 'Evaluate gate'}
            </WorkButton>
          </>
        )
      }
    >
      <div className="st-w-stack-sm">
        <p className="st-w-muted st-small">
          The gate compares this completed run with a baseline using the server’s gate configuration. It records a
          result and artifact; it does not change the run.
        </p>
        {result ? (
          <>
            <InlineNotice
              tone={result.result.pass ? 'success' : 'error'}
              title={`${result.result.pass ? 'PASS' : 'BLOCKED'} · ${result.config.suite}`}
            >
              {result.result.failures.length > 0 ? (
                <ul className="st-w-issue-list">
                  {result.result.failures.map((failure) => (
                    <li key={failure.rule}>{failure.message}</li>
                  ))}
                </ul>
              ) : result.result.warnings.length > 0 ? (
                result.result.warnings.join(' · ')
              ) : (
                'No failures or warnings recorded.'
              )}
            </InlineNotice>
            <WorkLink
              href={gateArtifactUrl(result.id, 'md')}
              download={`gate-${result.id}.md`}
              variant="secondary"
            >
              Download gate artifact
            </WorkLink>
          </>
        ) : (
          <>
            <div className="st-field">
              <label className="st-label" htmlFor="gate-baseline-select">
                Baseline run
              </label>
              <select
                id="gate-baseline-select"
                className="st-w-select"
                value={baselineId}
                onChange={(event) => setBaselineId(event.target.value)}
                disabled={busy}
              >
                {baselines.map((baseline) => (
                  <option key={baseline.id} value={baseline.id}>
                    {shortId(baseline.id)} · {baseline.datasetName} v{baseline.datasetVersion} ·{' '}
                    {percent(baseline.summary?.passRate)}
                  </option>
                ))}
              </select>
            </div>
            <p className="st-hint">
              Candidate: {shortId(run.id)} · {run.datasetName} v{run.datasetVersion}
            </p>
          </>
        )}
        {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      </div>
    </Modal>
  )
}

/* ------------------------------ compare ------------------------------ */

export const ComparePage = ({
  initialBaseline = '',
  initialCandidate = '',
}: {
  initialBaseline?: string
  initialCandidate?: string
}) => {
  const runs = useApi<RunListResponse>('/api/runs')
  const [baseline, setBaseline] = useState(initialBaseline)
  const [candidate, setCandidate] = useState(initialCandidate)
  const initialized = useRef(false)

  const doneRuns = (runs.data?.items ?? []).filter((run) => run.status === 'done' && run.summary)

  useEffect(() => {
    if (initialized.current || !runs.data) {return}
    initialized.current = true
    let nextBaseline = baseline
    let nextCandidate = candidate
    if (!nextCandidate) {
      nextCandidate = doneRuns.find((run) => run.id !== nextBaseline)?.id ?? ''
    }
    if (!nextBaseline) {
      nextBaseline = doneRuns.find((run) => run.id !== nextCandidate)?.id ?? ''
    }
    if (nextBaseline !== baseline || nextCandidate !== candidate) {
      setBaseline(nextBaseline)
      setCandidate(nextCandidate)
      navigate(withQuery('/runs/compare', { baseline: nextBaseline, candidate: nextCandidate }), { replace: true })
    }
  }, [runs.data, baseline, candidate, doneRuns])

  // Keep the selects in step with browser back/forward or a pasted compare URL.
  useEffect(() => {
    if (initialBaseline !== baseline) {setBaseline(initialBaseline)}
    if (initialCandidate !== candidate) {setCandidate(initialCandidate)}
    // Only route-provided values should drive this sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialBaseline, initialCandidate])

  const choose = (nextBaseline: string, nextCandidate: string) => {
    setBaseline(nextBaseline)
    setCandidate(nextCandidate)
    navigate(withQuery('/runs/compare', { baseline: nextBaseline, candidate: nextCandidate }), { replace: true })
  }

  const same = Boolean(baseline && candidate && baseline === candidate)
  const comparePath =
    baseline && candidate && !same
      ? `/api/runs/compare?baseline=${encodeURIComponent(baseline)}&candidate=${encodeURIComponent(candidate)}`
      : null
  const comparison = useApi<CompareResponse>(comparePath)

  return (
    <Page className="st-w-page">
      <PageHeader
        back={{ label: 'Runs', onClick: () => navigate('/runs') }}
        title="Compare runs"
        description="Two completed runs, side by side. Pass-rate deltas are in percentage points; a regression is highlighted only when the numbers support it."
        actions={<WorkLink href={href('/runs')}>All runs</WorkLink>}
      />

      {runs.error && !runs.data ? (
        <LoadError message={runs.error} onRetry={runs.reload} />
      ) : runs.loading && !runs.data ? (
        <Card>
          <LoadingBlock />
        </Card>
      ) : (
        <div className="st-stack">
          <Card title="Choose runs" subtitle="Baseline is the reference; candidate is the change under review.">
            <div className="st-w-compare-selects">
              <div className="st-field">
                <label className="st-label" htmlFor="compare-baseline">
                  Baseline
                </label>
                <select
                  id="compare-baseline"
                  className="st-w-select"
                  value={baseline}
                  onChange={(event) => choose(event.target.value, candidate)}
                >
                  <option value="">Select a completed run</option>
                  {doneRuns.map((run) => (
                    <option key={run.id} value={run.id}>
                      {shortId(run.id)} · {run.datasetName} v{run.datasetVersion} · {percent(run.summary?.passRate)}
                    </option>
                  ))}
                </select>
              </div>
              <WorkButton
                onClick={() => choose(candidate, baseline)}
                disabled={!baseline || !candidate || same}
                title={same ? 'Choose two different runs to swap.' : undefined}
              >
                Swap
              </WorkButton>
              <div className="st-field">
                <label className="st-label" htmlFor="compare-candidate">
                  Candidate
                </label>
                <select
                  id="compare-candidate"
                  className="st-w-select"
                  value={candidate}
                  onChange={(event) => choose(baseline, event.target.value)}
                >
                  <option value="">Select a completed run</option>
                  {doneRuns.map((run) => (
                    <option key={run.id} value={run.id}>
                      {shortId(run.id)} · {run.datasetName} v{run.datasetVersion} · {percent(run.summary?.passRate)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {same ? (
              <div style={{ marginTop: 12 }}>
                <InlineNotice tone="warn">Baseline and candidate must be different runs.</InlineNotice>
              </div>
            ) : null}
            {doneRuns.length < 2 ? (
              <div style={{ marginTop: 12 }}>
                <InlineNotice tone="info">
                  Two completed runs are required. Queue another evaluation to enable a comparison.
                </InlineNotice>
              </div>
            ) : null}
          </Card>

          {!comparePath ? (
            <Card>
              <EmptyState
                title="Pick two completed runs"
                description="The comparison shows overall deltas and per-slice regressions. Both runs must have a summary."
              />
            </Card>
          ) : comparison.error && !comparison.data ? (
            <LoadError message={comparison.error} onRetry={comparison.reload} />
          ) : comparison.loading && !comparison.data ? (
            <Card>
              <LoadingBlock />
            </Card>
          ) : comparison.data ? (
            <CompareBody data={comparison.data} />
          ) : null}
        </div>
      )}
    </Page>
  )
}

const CompareBody = ({ data }: { data: CompareResponse }) => {
  const { baseline, candidate, overall } = data
  const slices = data.slices ?? []
  const regressedSlices = slices.filter((slice) => slice.regressed)
  const replay = baseline.mode === 'replay' || candidate.mode === 'replay'
  const passCi =
    overall.passRate.ciLowPp != null && overall.passRate.ciHighPp != null
      ? `95% CI ${overall.passRate.ciLowPp.toFixed(1)} to ${overall.passRate.ciHighPp.toFixed(1)} pp`
      : null

  return (
    <div className="st-stack">
      {replay ? (
        <InlineNotice tone="info" title="Replay evidence">
          At least one run was recorded in replay mode. Replay proves mechanics and comparability; it does not measure
          live model quality.
        </InlineNotice>
      ) : null}

      <div className="st-w-compare-heads">
        <a className="st-w-run-card" href={href(`/runs/${baseline.id}`)}>
          <div className="st-w-run-card-head">
            <span>Baseline</span>
            <RunStatusBadge status={baseline.status} />
          </div>
          <div className="st-w-run-card-title">
            {baseline.datasetName} <span className="st-faint">v{baseline.datasetVersion}</span>
          </div>
          <div className="st-w-run-card-metrics">
            <span>
              <span className="st-w-num-strong">{percent(baseline.summary?.passRate)}</span> pass rate
            </span>
            <span>{formatUsd(baseline.summary?.costUsd)} cost</span>
            <span>{formatDuration(baseline.summary?.p95LatencyMs)} p95</span>
          </div>
          <div className="st-w-sub">
            {shortId(baseline.id)} · {baseline.profileName} · {baseline.mode}
          </div>
        </a>
        <a className="st-w-run-card" href={href(`/runs/${candidate.id}`)}>
          <div className="st-w-run-card-head">
            <span>Candidate</span>
            <RunStatusBadge status={candidate.status} />
          </div>
          <div className="st-w-run-card-title">
            {candidate.datasetName} <span className="st-faint">v{candidate.datasetVersion}</span>
          </div>
          <div className="st-w-run-card-metrics">
            <span>
              <span className="st-w-num-strong">{percent(candidate.summary?.passRate)}</span> pass rate
            </span>
            <span>{formatUsd(candidate.summary?.costUsd)} cost</span>
            <span>{formatDuration(candidate.summary?.p95LatencyMs)} p95</span>
          </div>
          <div className="st-w-sub">
            {shortId(candidate.id)} · {candidate.profileName} · {candidate.mode}
          </div>
        </a>
      </div>

      <div className="st-w-stat-grid">
        <Stat
          label="Pass rate"
          value={percent(overall.passRate.candidate)}
          delta={<Delta value={overall.passRate.delta} suffix="pp" />}
          foot={`baseline ${percent(overall.passRate.baseline)}`}
        />
        <Stat
          label="Cost per successful answer"
          value={formatUsd(overall.costPerPassUsd.candidate)}
          delta={<Delta value={overall.costPerPassUsd.deltaPct} suffix="%" goodWhenPositive={false} />}
          foot={`baseline ${formatUsd(overall.costPerPassUsd.baseline)}`}
        />
        <Stat
          label="p95 latency"
          value={formatDuration(overall.p95LatencyMs.candidate)}
          delta={<Delta value={overall.p95LatencyMs.deltaPct} suffix="%" goodWhenPositive={false} />}
          foot={`baseline ${formatDuration(overall.p95LatencyMs.baseline)}`}
        />
        <Stat
          label="Cases changed"
          value={`${overall.improved} / ${overall.regressed}`}
          foot={`improved / regressed · ${overall.unchanged} unchanged · ${overall.cases} cases`}
        />
      </div>

      <Card
        title="Overall"
        subtitle={
          passCi
            ? `${passCi}${overall.passRate.probabilityNotBetter != null ? ` · P(not better) ${percent(overall.passRate.probabilityNotBetter)}` : ''}`
            : 'Paired comparison across the matched cases'
        }
      >
        <div className="st-w-run-head">
          <Badge tone={regressedSlices.length > 0 ? 'fail' : 'pass'}>
            {regressedSlices.length} regressed slice{regressedSlices.length === 1 ? '' : 's'}
          </Badge>
          <Badge tone="neutral" outline>
            {overall.cases} matched cases
          </Badge>
          <span className="st-hint">
            Judge agreement{' '}
            {overall.judgeAgreement == null ? '—' : percent(overall.judgeAgreement)}
          </span>
        </div>
        {regressedSlices.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <InlineNotice tone="warn" title="Review the regressions before shipping">
              <ul className="st-w-issue-list">
                {regressedSlices.map((slice) => (
                  <li key={slice.slice}>
                    {slice.slice}: {slice.passRate.delta == null ? 'no delta' : `${slice.passRate.delta.toFixed(1)} pp`}{' '}
                    across {slice.cases} cases
                  </li>
                ))}
              </ul>
            </InlineNotice>
          </div>
        ) : null}
      </Card>

      <Card title="Slices" subtitle="Regression highlighting uses the server's per-slice rules." flush>
        <DataTable
          columns={compareSliceColumns}
          rows={slices}
          getKey={(slice) => slice.slice}
          ariaLabel="Per-slice comparison"
          empty="No per-slice comparison was returned; the runs may use different cases."
          footer={
            <TableFoot>
              {slices.length} slice{slices.length === 1 ? '' : 's'} compared · baseline vs candidate pass rates
            </TableFoot>
          }
        />
      </Card>
    </div>
  )
}

const compareSliceColumns: Column<CompareResponse['slices'][number]>[] = [
  {
    key: 'slice',
    header: 'Slice',
    render: (slice) => <span className={slice.regressed ? 'st-w-regression-flag' : 'st-w-cell-strong'}>{slice.slice}</span>,
  },
  {
    key: 'cases',
    header: 'Cases',
    width: 80,
    align: 'right',
    render: (slice) => <span className="st-w-num">{slice.cases}</span>,
  },
  {
    key: 'baseline',
    header: 'Baseline',
    width: 110,
    align: 'right',
    render: (slice) => <span className="st-w-num">{percent(slice.passRate.baseline)}</span>,
  },
  {
    key: 'candidate',
    header: 'Candidate',
    width: 110,
    align: 'right',
    render: (slice) => <span className="st-w-num-strong">{percent(slice.passRate.candidate)}</span>,
  },
  {
    key: 'delta',
    header: 'Delta',
    width: 100,
    align: 'right',
    render: (slice) => <Delta value={slice.passRate.delta} suffix="pp" />,
  },
  {
    key: 'state',
    header: 'State',
    width: 120,
    render: (slice) => {
      if (slice.regressed) {
        return <Badge tone="fail">Regression</Badge>
      }
      if (slice.passRate.delta != null && slice.passRate.delta > 0) {
        return <Badge tone="pass">Improved</Badge>
      }
      if (slice.passRate.delta != null && slice.passRate.delta < 0) {
        return <Badge tone="warn">Dropped</Badge>
      }
      return <span className="st-faint">Flat</span>
    },
  },
]
