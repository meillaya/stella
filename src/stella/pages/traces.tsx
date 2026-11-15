import { useEffect, useState } from 'react'
import { Modal } from '../../components/base/Modal.js'
import { Markdown } from '../../components/markdown/Markdown.js'
import type { DatasetCase, Feedback, Profile, Trace, TraceStatus, TraceSummary } from '../../../shared/types.js'
import { api, useApi } from '../api.js'
import { formatDate, formatDuration, formatRelative, shortId } from '../format.js'
import { href, navigate } from '../router.js'
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  KeyValue,
  LoadingBlock,
  Page,
  PageHeader,
  type Column,
} from '../ui/index.js'
import {
  IconChat,
  IconSearch,
  IconThumbDown,
  IconThumbUp,
  IconTraces,
} from '../ui/icons.js'
import {
  FeedbackBadge,
  InlineNotice,
  LoadError,
  SelectField,
  SourceList,
  TableFoot,
  TextareaField,
  TokenBreakdown,
  TraceStatusBadge,
  WorkButton,
  WorkLink,
  useDebouncedValue,
} from '../workbench/components.js'
import type { DatasetListResponse, ProfileListResponse, TraceListResponse } from '../workbench/api-types.js'
import {
  buildTracesPath,
  cleanQuestionText,
  describeApiError,
  formatUsd,
  traceQuestion,
  tracePromoteUrl,
} from '../workbench/lib.js'

const STATUS_LABELS: Record<TraceStatus, string> = {
  ok: 'OK',
  error: 'Error',
  aborted: 'Aborted',
  interrupted: 'Interrupted',
}

const traceColumns: Column<TraceSummary>[] = [
  {
    key: 'question',
    header: 'Question',
    render: (trace) => (
      <div className="st-w-question-cell">
        <div className="st-w-cell-strong st-w-clamp">{cleanQuestionText(trace.question)}</div>
        <div className="st-w-sub st-w-clamp">{trace.answerPreview || 'No answer preview.'}</div>
      </div>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    width: 118,
    render: (trace) => <TraceStatusBadge status={trace.status} />,
  },
  {
    key: 'sources',
    header: 'Sources',
    width: 84,
    align: 'right',
    render: (trace) => <span className="st-w-num">{trace.sourceCount}</span>,
  },
  {
    key: 'cost',
    header: 'Cost',
    width: 90,
    align: 'right',
    render: (trace) => <span className="st-w-num">{formatUsd(trace.costUsd)}</span>,
  },
  {
    key: 'latency',
    header: 'Latency',
    width: 100,
    align: 'right',
    render: (trace) => <span className="st-w-num">{formatDuration(trace.latencyMs)}</span>,
  },
  {
    key: 'feedback',
    header: 'Feedback',
    width: 124,
    render: (trace) => <FeedbackBadge value={trace.feedback} />,
  },
  {
    key: 'when',
    header: 'When',
    width: 130,
    align: 'right',
    render: (trace) => (
      <span className="st-w-sub" title={formatDate(trace.createdAt)} style={{ marginTop: 0 }}>
        {formatRelative(trace.createdAt)}
      </span>
    ),
  },
]

export const TracesPage = () => {
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebouncedValue(query, 250)
  const [feedback, setFeedback] = useState<Feedback | ''>('')
  const [status, setStatus] = useState<TraceStatus | ''>('')
  const [profileId, setProfileId] = useState('')
  const [limit, setLimit] = useState(50)

  const profiles = useApi<ProfileListResponse>('/api/profiles')
  const path = buildTracesPath({ limit, q: debouncedQuery, feedback, status, profileId })
  const traces = useApi<TraceListResponse>(path)

  const items = traces.data?.items ?? []
  const limitReached = limit >= 200
  const hasFilters = Boolean(debouncedQuery || feedback || status || profileId)
  const resetLimit = () => setLimit(50)
  const clearFilters = () => {
    setQuery('')
    setFeedback('')
    setStatus('')
    setProfileId('')
    resetLimit()
  }

  return (
    <Page className="st-w-page">
      <PageHeader
        title="Traces"
        description="Every gateway request with its answer, retrieved sources, cost, latency and human feedback. Select a trace to review the evidence."
        actions={
          <WorkLink href={href('/chat')}>
            <IconChat size={15} />
            Open chat
          </WorkLink>
        }
      />

      <div className="st-w-toolbar">
        <div className="st-search">
          <span className="st-search-icon">
            <IconSearch size={15} />
          </span>
          <input
            className="st-input"
            type="search"
            value={query}
            placeholder="Search questions and answers"
            aria-label="Search traces"
            onChange={(event) => {
              setQuery(event.target.value)
              resetLimit()
            }}
          />
        </div>
        <div className="st-w-seg" role="group" aria-label="Feedback filter">
          <button
            type="button"
            aria-pressed={feedback === ''}
            onClick={() => {
              setFeedback('')
              resetLimit()
            }}
          >
            All
          </button>
          <button
            type="button"
            aria-pressed={feedback === 'up'}
            onClick={() => {
              setFeedback('up')
              resetLimit()
            }}
          >
            Up
          </button>
          <button
            type="button"
            aria-pressed={feedback === 'down'}
            onClick={() => {
              setFeedback('down')
              resetLimit()
            }}
          >
            Down
          </button>
        </div>
        <select
          className="st-w-select"
          aria-label="Filter by status"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as TraceStatus | '')
            resetLimit()
          }}
        >
          <option value="">All statuses</option>
          {(Object.keys(STATUS_LABELS) as TraceStatus[]).map((value) => (
            <option key={value} value={value}>
              {STATUS_LABELS[value]}
            </option>
          ))}
        </select>
        <select
          className="st-w-select"
          aria-label="Filter by profile"
          value={profileId}
          disabled={!profiles.data}
          title={profiles.error ? `Profiles unavailable: ${profiles.error}` : undefined}
          onChange={(event) => {
            setProfileId(event.target.value)
            resetLimit()
          }}
        >
          <option value="">
            {profiles.data ? 'All profiles' : profiles.loading ? 'Loading profiles…' : 'Profiles unavailable'}
          </option>
          {(profiles.data?.items ?? []).map((profile: Profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} v{profile.version}
            </option>
          ))}
        </select>
        {hasFilters ? (
          <WorkButton variant="ghost" size="s" onClick={clearFilters}>
            Clear filters
          </WorkButton>
        ) : null}
        {profiles.error ? <span className="st-w-filter-note">Profile filter unavailable</span> : null}
      </div>

      {traces.error && traces.data ? (
        <div style={{ marginBottom: 14 }}>
          <InlineNotice
            tone="error"
            title="Showing the last loaded traces"
            action={
              <WorkButton size="s" onClick={traces.reload}>
                Retry
              </WorkButton>
            }
          >
            {traces.error}
          </InlineNotice>
        </div>
      ) : null}

      <Card flush>
        {traces.error && !traces.data ? (
          <div style={{ padding: 20 }}>
            <LoadError message={traces.error} onRetry={traces.reload} />
          </div>
        ) : traces.loading && !traces.data ? (
          <LoadingBlock />
        ) : items.length === 0 ? (
          <EmptyState
            icon={hasFilters ? <IconSearch size={18} /> : <IconTraces size={18} />}
            title={hasFilters ? 'No traces match these filters' : 'No traces yet'}
            description={
              hasFilters
                ? 'Try a broader search, or clear the feedback, status and profile filters.'
                : 'Conversations sent through the Stella gateway are recorded here with their sources, cost and feedback.'
            }
            action={
              hasFilters ? (
                <WorkButton onClick={clearFilters}>Clear filters</WorkButton>
              ) : (
                <WorkLink href={href('/chat')}>Open chat</WorkLink>
              )
            }
          />
        ) : (
          <DataTable
            columns={traceColumns}
            rows={items}
            getKey={(trace) => trace.id}
            onRowClick={(trace) => navigate(`/traces/${trace.id}`)}
            ariaLabel="Gateway traces"
            footer={
              <TableFoot
                actions={
                  traces.data?.nextCursor ? (
                    <WorkButton
                      size="s"
                      disabled={traces.loading || limitReached}
                      title={
                        limitReached
                          ? 'The traces API returns at most 200 per request. Narrow the search or filters to reach older traces.'
                          : undefined
                      }
                      onClick={() => setLimit((current) => Math.min(200, current + 50))}
                    >
                      {traces.loading ? 'Loading…' : limitReached ? '200-trace limit' : 'Load 50 more'}
                    </WorkButton>
                  ) : null
                }
              >
                Showing {items.length} trace{items.length === 1 ? '' : 's'}
                {traces.data?.nextCursor
                  ? limitReached
                    ? ' · at the 200-trace API limit; narrow the filters for older traces'
                    : ' · more available'
                  : ' · end of results'}
                {traces.loading ? ' · refreshing' : ''}
              </TableFoot>
            }
          />
        )}
      </Card>
      <p className="st-hint" style={{ marginTop: 10 }}>
        Search covers questions and answers stored by the gateway. Load more uses the same filter set.
      </p>
    </Page>
  )
}

/* ------------------------------ detail ------------------------------ */

export const TraceDetailPage = ({ traceId }: { traceId?: string }) => {
  const trace = useApi<Trace>(traceId ? `/api/traces/${encodeURIComponent(traceId)}` : null)
  const [promoteOpen, setPromoteOpen] = useState(false)
  const [promotion, setPromotion] = useState<{ datasetId: string; datasetName: string } | null>(null)
  const [annotation, setAnnotation] = useState('')
  const [savedAnnotation, setSavedAnnotation] = useState<string | null>(null)
  const [savingAnnotation, setSavingAnnotation] = useState(false)
  const [savingFeedback, setSavingFeedback] = useState<Feedback | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [reviewMessage, setReviewMessage] = useState<string | null>(null)

  const detail = trace.data

  useEffect(() => {
    setAnnotation(detail?.annotation ?? '')
    setSavedAnnotation(detail?.annotation ?? null)
  }, [detail?.id, detail?.annotation])

  if (!traceId) {
    return (
      <Page className="st-w-page">
        <PageHeader title="Trace" back={{ label: 'Traces', onClick: () => navigate('/traces') }} />
        <Card>
          <EmptyState
            title="Trace not found"
            description="This route has no trace id."
            action={<WorkButton onClick={() => navigate('/traces')}>Back to traces</WorkButton>}
          />
        </Card>
      </Page>
    )
  }

  if (trace.error && !trace.data) {
    return (
      <Page className="st-w-page">
        <PageHeader title={`Trace ${shortId(traceId)}`} back={{ label: 'Traces', onClick: () => navigate('/traces') }} />
        <LoadError message={trace.error} onRetry={trace.reload} />
      </Page>
    )
  }

  if (trace.loading && !trace.data) {
    return (
      <Page className="st-w-page">
        <PageHeader title={`Trace ${shortId(traceId)}`} back={{ label: 'Traces', onClick: () => navigate('/traces') }} />
        <Card>
          <LoadingBlock />
        </Card>
      </Page>
    )
  }

  if (!detail) {return null}

  const question = traceQuestion(detail)
  const dirty = annotation !== (savedAnnotation ?? '')
  const usage = detail.usage
  const totalTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens + usage.outputTokens
  const citations = detail.response.citations ?? []
  const toolCalls = detail.response.toolCalls ?? 0

  const saveAnnotation = async () => {
    setReviewError(null)
    setReviewMessage(null)
    setSavingAnnotation(true)
    try {
      await api.patch<Trace>(`/api/traces/${encodeURIComponent(detail.id)}`, {
        annotation: annotation.trim() || null,
      })
      setSavedAnnotation(annotation.trim())
      setReviewMessage('Annotation saved.')
      trace.reload()
    } catch (cause) {
      setReviewError(describeApiError(cause))
    } finally {
      setSavingAnnotation(false)
    }
  }

  const setFeedback = async (next: Feedback) => {
    const value = detail.feedback === next ? null : next
    setReviewError(null)
    setReviewMessage(null)
    setSavingFeedback(next)
    try {
      await api.patch<Trace>(`/api/traces/${encodeURIComponent(detail.id)}`, { feedback: value })
      setReviewMessage(value ? `Feedback set to ${value}.` : 'Feedback cleared.')
      trace.reload()
    } catch (cause) {
      setReviewError(describeApiError(cause))
    } finally {
      setSavingFeedback(null)
    }
  }

  return (
    <Page className="st-w-page">
      <PageHeader
        back={{ label: 'Traces', onClick: () => navigate('/traces') }}
        title={`Trace ${shortId(detail.id)}`}
        description={<span className="st-w-clamp">{question}</span>}
        meta={
          <>
            <TraceStatusBadge status={detail.status} />
            <FeedbackBadge value={detail.feedback} />
            <Badge tone="neutral" outline>
              {detail.model}
            </Badge>
            {detail.retrievalEnabled ? (
              <Badge tone="info" outline>
                Retrieval on
              </Badge>
            ) : null}
            <span className="st-w-sub" style={{ marginTop: 0 }} title={formatDate(detail.createdAt)}>
              {formatRelative(detail.createdAt)}
            </span>
          </>
        }
        actions={
          <WorkButton variant="primary" onClick={() => setPromoteOpen(true)}>
            Promote to dataset
          </WorkButton>
        }
      />

      {promotion ? (
        <div style={{ marginBottom: 16 }}>
          <InlineNotice tone="success" title="Case promoted">
            A draft case was created in {promotion.datasetName}.{' '}
            <a className="st-link" href={href(`/datasets/${promotion.datasetId}`)}>
              Open dataset
            </a>
          </InlineNotice>
        </div>
      ) : null}

      <div className="st-grid st-grid-main">
        <div className="st-stack">
          <Card
            title="Transcript"
            subtitle="Question and answer exactly as recorded, rendered with the chat markdown renderer"
          >
            <div className="st-transcript">
              <div className="st-turn">
                <div className="st-w-turn-role">User · question</div>
                <div className="st-w-question">{question}</div>
              </div>
              <div className="st-turn">
                <div className="st-w-turn-role">
                  Assistant · {detail.model}
                  {detail.response.stopReason ? ` · stop ${detail.response.stopReason}` : ''}
                </div>
                {detail.error ? (
                  <InlineNotice tone="error" title="The gateway recorded an error">
                    {detail.error}
                  </InlineNotice>
                ) : null}
                {detail.response.text ? (
                  <div className="st-w-markdown">
                    <Markdown
                      content={detail.response.text}
                      loading={false}
                      cacheKey={`trace-${detail.id}`}
                      disableLink={false}
                    />
                  </div>
                ) : (
                  <p className="st-w-muted st-small">No answer text was recorded for this trace.</p>
                )}
                {detail.response.thinking ? (
                  <details className="st-w-details">
                    <summary>Thinking trace</summary>
                    <div className="st-w-markdown">
                      <Markdown
                        content={detail.response.thinking}
                        loading={false}
                        cacheKey={`trace-thinking-${detail.id}`}
                        disableLink
                      />
                    </div>
                  </details>
                ) : null}
                {citations.length > 0 ? (
                  <div className="st-w-inline-actions">
                    <span className="st-small st-faint">Web citations</span>
                    {citations.map((citation, index) => (
                      <a
                        key={`${citation.url}-${index}`}
                        className="st-link st-small"
                        href={citation.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {citation.title || citation.url}
                      </a>
                    ))}
                  </div>
                ) : null}
                {toolCalls > 0 ? <div className="st-hint">{toolCalls} tool call(s) recorded.</div> : null}
              </div>
            </div>
          </Card>

          <Card
            title="Sources"
            subtitle={`${detail.sources.length} retrieved chunk${detail.sources.length === 1 ? '' : 's'} attached to this answer`}
          >
            <SourceList sources={detail.sources} />
            <div style={{ marginTop: 16 }}>
              {detail.injectedContext ? (
                <details className="st-w-details">
                  <summary>Injected retrieval context · {detail.injectedContext.length.toLocaleString()} characters</summary>
                  <pre className="st-w-pre">{detail.injectedContext}</pre>
                </details>
              ) : (
                <p className="st-hint">No retrieval context was injected into this request.</p>
              )}
            </div>
          </Card>
        </div>

        <div className="st-stack">
          <Card title="Human review" subtitle="Feedback and notes are stored on the trace">
            <div className="st-w-annotation">
              <div className="st-w-review-bar">
                <WorkButton
                  size="s"
                  aria-pressed={detail.feedback === 'up'}
                  disabled={savingFeedback !== null}
                  onClick={() => void setFeedback('up')}
                >
                  <IconThumbUp size={13} />
                  {savingFeedback === 'up' ? 'Saving…' : 'Helpful'}
                </WorkButton>
                <WorkButton
                  size="s"
                  aria-pressed={detail.feedback === 'down'}
                  disabled={savingFeedback !== null}
                  onClick={() => void setFeedback('down')}
                >
                  <IconThumbDown size={13} />
                  {savingFeedback === 'down' ? 'Saving…' : 'Not helpful'}
                </WorkButton>
                <span className="st-hint">Click again to clear.</span>
              </div>
              {reviewError ? <InlineNotice tone="error">{reviewError}</InlineNotice> : null}
              {reviewMessage ? (
                <InlineNotice tone="success">{reviewMessage}</InlineNotice>
              ) : null}
              <TextareaField
                label="Annotation"
                value={annotation}
                rows={5}
                placeholder="What was wrong, what should the answer say, and which evidence is missing?"
                hint="Internal note for reviewers. Saved with the trace, not shown to chat users."
                onChange={(event) => setAnnotation(event.target.value)}
              />
              <div className="st-w-inline-actions">
                <WorkButton variant="primary" disabled={!dirty || savingAnnotation} onClick={() => void saveAnnotation()}>
                  {savingAnnotation ? 'Saving…' : 'Save annotation'}
                </WorkButton>
                {dirty ? <span className="st-hint">Unsaved changes</span> : null}
              </div>
            </div>
          </Card>

          <Card title="Provenance">
            <KeyValue
              items={[
                { label: 'Status', value: <TraceStatusBadge status={detail.status} /> },
                { label: 'Model', value: `${detail.model}${detail.thinking ? ' · thinking' : ''}` },
                { label: 'Profile', value: detail.profileName ?? '—' },
                {
                  label: 'Latency',
                  value: `${formatDuration(detail.latencyMs)}${detail.ttfbMs != null ? ` · first token ${formatDuration(detail.ttfbMs)}` : ''}`,
                },
                {
                  label: 'Cost',
                  value: `${formatUsd(detail.costUsd)} · ${detail.pricingBasis} pricing`,
                },
                { label: 'Tokens', value: `${totalTokens.toLocaleString()} total` },
                { label: 'Retrieval', value: detail.retrievalEnabled ? `on · ${detail.sources.length} sources` : 'off' },
                { label: 'Created', value: formatDate(detail.createdAt) },
                { label: 'Session', value: <span className="st-mono st-small">{detail.sessionKey}</span> },
                { label: 'Trace id', value: <span className="st-mono st-small">{detail.id}</span> },
                { label: 'Stop reason', value: detail.response.stopReason ?? '—' },
                { label: 'Tool calls', value: String(toolCalls) },
              ]}
            />
            <div style={{ marginTop: 14 }}>
              <details className="st-w-details">
                <summary>Token usage</summary>
                <TokenBreakdown usage={detail.usage} />
              </details>
            </div>
          </Card>
        </div>
      </div>

      {promoteOpen ? (
        <PromoteTraceModal
          traceId={detail.id}
          onClose={() => setPromoteOpen(false)}
          onPromoted={(datasetId, datasetName) => {
            setPromotion({ datasetId, datasetName })
            setPromoteOpen(false)
          }}
        />
      ) : null}
    </Page>
  )
}

const PromoteTraceModal = ({
  traceId,
  onClose,
  onPromoted,
}: {
  traceId: string
  onClose: () => void
  onPromoted: (datasetId: string, datasetName: string) => void
}) => {
  const datasets = useApi<DatasetListResponse>('/api/datasets')
  const [datasetId, setDatasetId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!datasetId && datasets.data?.items[0]) {setDatasetId(datasets.data.items[0].id)}
  }, [datasets.data, datasetId])

  const selected = datasets.data?.items.find((dataset) => dataset.id === datasetId) ?? null

  const submit = async () => {
    if (!selected) {return}
    setBusy(true)
    setError(null)
    try {
      await api.post<DatasetCase>(tracePromoteUrl(traceId), { datasetId: selected.id })
      onPromoted(selected.id, selected.name)
    } catch (cause) {
      setError(describeApiError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Promote trace to dataset"
      closable
      className="st-w-modal st-w-modal-sm"
      onClose={onClose}
      footer={
        <>
          <WorkButton onClick={onClose} disabled={busy}>
            Cancel
          </WorkButton>
          <WorkButton
            variant="primary"
            onClick={() => void submit()}
            disabled={busy || !selected}
            title={!selected ? 'Choose a dataset first.' : undefined}
          >
            {busy ? 'Promoting…' : 'Create draft case'}
          </WorkButton>
        </>
      }
    >
      <div className="st-w-stack-sm">
        <p className="st-w-muted st-small">
          The question, answer and retrieved sources become an editable draft case. Existing cases with the same
          source trace are updated by the server.
        </p>
        {datasets.error ? (
          <LoadError message={datasets.error} onRetry={datasets.reload} />
        ) : (
          <SelectField
            label="Dataset"
            value={datasetId}
            disabled={busy || datasets.loading}
            onChange={setDatasetId}
            placeholder={datasets.loading ? 'Loading datasets…' : 'Select a dataset'}
            options={(datasets.data?.items ?? []).map((dataset) => ({
              value: dataset.id,
              label: `${dataset.name} · ${dataset.caseCount} cases`,
            }))}
            hint="Only draft cases are edited; snapshots stay immutable."
          />
        )}
        {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      </div>
    </Modal>
  )
}
