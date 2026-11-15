import { useApi } from '../api.js'
import { formatDate, formatDuration, percent, pluralize, shortId } from '../format.js'
import { href, navigate, withQuery } from '../router.js'
import type { Gate, Overview } from '../../../shared/types.js'
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
  Sparkline,
  Stat,
  StellaBar,
  type Column,
} from '../ui/index.js'
import { IconChat, IconRuns } from '../ui/icons.js'
import {
  FeedbackBadge,
  InlineNotice,
  LoadError,
  WorkButton,
  WorkLink,
} from '../workbench/components.js'
import {
  DEFAULT_PASS_THRESHOLD,
  formatUsd,
  gateArtifactUrl,
  cleanQuestionText,
  gateForRun,
  gateReadiness,
  overviewTrend,
  passRateDeltaPp,
} from '../workbench/lib.js'

type FailingCase = Overview['failingCases'][number]

const failingColumns: Column<FailingCase>[] = [
  {
    key: 'case',
    header: 'Case',
    render: (row) => (
      <div className="st-w-question-cell">
        <div className="st-w-cell-strong st-mono">{shortId(row.caseId)}</div>
        <div className="st-w-sub st-w-clamp">{row.answer || 'No answer recorded.'}</div>
      </div>
    ),
  },
  {
    key: 'slices',
    header: 'Slices',
    width: 180,
    render: (row) =>
      row.slices.length > 0 ? (
        <span className="st-w-muted st-small">{row.slices.join(', ')}</span>
      ) : (
        <span className="st-faint">—</span>
      ),
  },
  {
    key: 'graders',
    header: 'Failed graders',
    width: 220,
    render: (row) =>
      row.failedGraders.length > 0 ? (
        <div className="st-row st-wrap">
          {row.failedGraders.map((grader) => (
            <Badge key={grader} tone="fail" dot>
              {grader}
            </Badge>
          ))}
        </div>
      ) : (
        <span className="st-faint">—</span>
      ),
  },
]

export const QualityPage = () => {
  const overview = useApi<Overview>('/api/overview')
  const gates = useApi<{ items: Gate[] }>('/api/gates')

  return (
    <Page className="st-w-page">
      <PageHeader
        title="Quality"
        description="Release readiness for the active dataset and profile. The verdict comes from a recorded gate result; Stella never infers a pass from a threshold alone."
        actions={
          <>
            <WorkLink href={href('/chat')}>
              <IconChat size={15} />
              Open chat
            </WorkLink>
            <WorkButton variant="primary" onClick={() => navigate(withQuery('/runs', { new: 1 }))}>
              <IconRuns size={15} />
              Run evaluation
            </WorkButton>
          </>
        }
      />

      {overview.error && !overview.data ? (
        <LoadError message={overview.error} onRetry={overview.reload} />
      ) : overview.loading && !overview.data ? (
        <Card>
          <LoadingBlock />
        </Card>
      ) : overview.data ? (
        <QualityBody
          overview={overview.data}
          gates={gates.data?.items ?? null}
          error={overview.error}
          refresh={overview.reload}
        />
      ) : null}
    </Page>
  )
}

const QualityBody = ({
  overview,
  gates,
  error,
  refresh,
}: {
  overview: Overview
  gates: Gate[] | null
  error: string | null
  refresh: () => void
}) => {
  const run = overview.latestRun
  const matchingGate =
    gateForRun(run?.id, gates) ??
    (overview.gate && run && overview.gate.candidateRunId === run.id ? overview.gate : null)
  const readiness = gateReadiness(run, matchingGate)
  const threshold = matchingGate?.config?.thresholds?.passRate ?? DEFAULT_PASS_THRESHOLD
  const summary = run?.summary ?? null
  const trend = overviewTrend(overview)
  const passDelta = passRateDeltaPp(run, overview.baselineRun)

  if (!run) {
    return (
      <div className="st-stack">
        <Card title="Release readiness" subtitle="No evaluation has been recorded yet">
          <div className="st-verdict" data-tone={readiness.tone}>
            <span className="st-verdict-label">Release verdict</span>
            <span className="st-verdict-title">{readiness.verdict}</span>
            <p className="st-w-verdict-why">{readiness.why}</p>
          </div>
        </Card>
        <Card>
          <EmptyState
            icon={<IconRuns size={18} />}
            title="No evaluation runs yet"
            description="Run the suite on the active dataset and profile to establish a baseline. Pass rate, cost, latency, failing cases and the release gate will appear here after the first run."
            action={
              <WorkButton variant="primary" onClick={() => navigate(withQuery('/runs', { new: 1 }))}>
                Run evaluation
              </WorkButton>
            }
          />
        </Card>
      </div>
    )
  }

  return (
    <div className="st-stack">
      {error ? (
        <InlineNotice
          tone="error"
          title="Showing the last loaded data"
          action={
            <WorkButton size="s" onClick={refresh}>
              Retry
            </WorkButton>
          }
        >
          {error}
        </InlineNotice>
      ) : null}

      <Card
        title="Release readiness"
        subtitle={run ? `${run.datasetName} v${run.datasetVersion} · ${run.profileName}` : undefined}
      >
        <div className="st-w-verdict-layout">
          <div className="st-w-stack-sm">
            <div className="st-verdict" data-tone={readiness.tone}>
              <span className="st-verdict-label">Release verdict</span>
              <span className="st-verdict-title">{readiness.verdict}</span>
              <p className="st-w-verdict-why">{readiness.why}</p>
            </div>
            <KeyValue
              items={[
                {
                  label: 'Latest run',
                  value: (
                    <a className="st-link" href={href(`/runs/${run.id}`)}>
                      {shortId(run.id)} · {formatDate(run.createdAt)}
                    </a>
                  ),
                },
                {
                  label: 'Baseline',
                  value: overview.baselineRun ? (
                    <a className="st-link" href={href(`/runs/${overview.baselineRun.id}`)}>
                      {shortId(overview.baselineRun.id)}
                    </a>
                  ) : (
                    'None'
                  ),
                },
                {
                  label: 'Gate checked',
                  value: matchingGate ? formatDate(matchingGate.result.checkedAt) : 'Not evaluated',
                },
                {
                  label: 'Dataset',
                  value: overview.dataset
                    ? `${overview.dataset.name} v${overview.dataset.version} · ${pluralize(overview.dataset.cases, 'case')}`
                    : '—',
                },
                {
                  label: 'Active profile',
                  value: overview.activeProfile
                    ? `${overview.activeProfile.name} v${overview.activeProfile.version}`
                    : '—',
                },
                {
                  label: 'Last 24 hours',
                  value: `${pluralize(overview.metrics.traces24h, 'trace')} · ${pluralize(overview.metrics.negativeFeedback24h, 'negative review')}`,
                },
              ]}
            />
          </div>

          <div className="st-w-signal">
            <div className="st-w-signal-head">
              <span>Pass rate against the gate threshold</span>
              <span className="st-w-signal-value">{summary ? percent(summary.passRate) : '—'}</span>
            </div>
            {summary ? (
              <StellaBar
                value={summary.passRate}
                low={summary.ciLow}
                high={summary.ciHigh}
                threshold={threshold}
                caption={
                  matchingGate
                    ? `Gate threshold ${percent(threshold, 0)}`
                    : `Default threshold ${percent(threshold, 0)} · no gate evaluated`
                }
              />
            ) : (
              <InlineNotice tone="info">
                This run is {run.status}; metrics appear when the runner finishes.
              </InlineNotice>
            )}
            <div className="st-w-verdict-actions">
              <WorkButton size="s" onClick={() => navigate(`/runs/${run.id}`)}>
                Open run
              </WorkButton>
              <WorkButton
                size="s"
                disabled={!overview.baselineRun || !summary}
                title={
                  !overview.baselineRun
                    ? 'A previous completed run is required to compare.'
                    : !summary
                      ? 'Comparison becomes available when this run completes.'
                      : undefined
                }
                onClick={() => {
                  if (!overview.baselineRun) {return}
                  navigate(
                    withQuery('/runs/compare', {
                      baseline: overview.baselineRun.id,
                      candidate: run.id,
                    })
                  )
                }}
              >
                Compare with baseline
              </WorkButton>
              {matchingGate ? (
                <WorkLink
                  href={gateArtifactUrl(matchingGate.id, 'md')}
                  download={`gate-${matchingGate.id}.md`}
                  variant="secondary"
                  className="st-w-btn-s"
                >
                  Download artifact
                </WorkLink>
              ) : null}
            </div>
            {!matchingGate ? (
              <p className="st-hint">
                A release gate compares this run with a baseline. Open the run to choose one and evaluate the gate.
              </p>
            ) : null}
          </div>
        </div>
      </Card>

      <div className="st-w-stat-grid">
        <Stat
          label="Pass rate"
          value={summary ? percent(summary.passRate) : '—'}
          delta={<Delta value={passDelta} suffix="pp" />}
          foot={
            summary
              ? `95% CI ${percent(summary.ciLow)}–${percent(summary.ciHigh)} · ${pluralize(summary.cases, 'case')}`
              : 'Waiting for the run summary'
          }
          spark={
            trend.length > 1 ? (
              <Sparkline values={trend} width={76} height={24} ariaLabel="Pass rate trend across recent completed runs" />
            ) : undefined
          }
        />
        <Stat
          label="Cost per successful answer"
          value={summary ? formatUsd(summary.costPerPassUsd) : '—'}
          delta={<Delta value={overview.metrics.costDeltaPct} suffix="%" goodWhenPositive={false} />}
          foot={summary ? `${formatUsd(summary.costUsd)} total for this run` : 'Waiting for the run summary'}
        />
        <Stat
          label="p95 latency"
          value={summary ? formatDuration(summary.p95LatencyMs) : '—'}
          delta={<Delta value={overview.metrics.latencyDeltaPct} suffix="%" goodWhenPositive={false} />}
          foot={summary ? `p50 ${formatDuration(summary.p50LatencyMs)}` : 'Waiting for the run summary'}
        />
        <Stat
          label="Cases"
          value={summary ? String(summary.cases) : '—'}
          foot={`${pluralize(overview.metrics.traces24h, 'trace')} · ${pluralize(overview.metrics.negativeFeedback24h, 'negative review')} in the last 24 h`}
        />
      </div>

      <div className="st-grid st-grid-main">
        <Card
          title="Failing cases"
          subtitle={`From run ${shortId(run.id)} · select a row to open the run`}
          flush
          actions={
            <WorkLink href={href(`/runs/${run.id}`)} variant="ghost" className="st-w-btn-s">
              Open run
            </WorkLink>
          }
        >
          <DataTable
            columns={failingColumns}
            rows={overview.failingCases}
            getKey={(row) => row.caseId}
            onRowClick={() => navigate(`/runs/${run.id}`)}
            ariaLabel="Failing cases in the latest run"
            empty={
              summary
                ? 'No failing cases in the latest run. Every case passed.'
                : 'Failing cases appear when the latest run completes.'
            }
          />
        </Card>

        <Card
          title="Review queue"
          subtitle="Negative feedback that needs a decision"
          flush
          actions={
            <WorkLink href={href('/traces')} variant="ghost" className="st-w-btn-s">
              All traces
            </WorkLink>
          }
        >
          {overview.reviewQueue.length === 0 ? (
            <EmptyState
              title="Queue is clear"
              description="No negative feedback is waiting for review. Down-voted answers appear here automatically."
            />
          ) : (
            <div className="st-w-queue">
              {overview.reviewQueue.map((trace) => (
                <a key={trace.id} className="st-w-queue-item" href={href(`/traces/${trace.id}`)}>
                  <span className="st-w-queue-question">{cleanQuestionText(trace.question)}</span>
                  <span className="st-w-queue-meta">
                    <FeedbackBadge value={trace.feedback} />
                    <span>{trace.model}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatDate(trace.createdAt)}</span>
                  </span>
                </a>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
