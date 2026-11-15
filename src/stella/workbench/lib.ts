import { ApiError } from '../api.js'
import { pluralize, shortId } from '../format.js'
import type {
  AnchorResolution,
  Comparison,
  DatasetCase,
  ExpectedBehavior,
  Feedback,
  FinetuneFormat,
  Gate,
  MetricDelta,
  Overview,
  ProfileSpec,
  RetrievalSpec,
  Run,
  RunItem,
  RunStatus,
  RunSummary,
  Trace,
  TraceStatus,
} from '../../../shared/types.js'
import type { Tone } from '../ui/index.js'
import type { FinetunePreflightResponse } from './api-types.js'

/**
 * Pure helpers for the workbench. Keep this module free of React and DOM
 * globals (apart from crypto-free formatting) so it stays easy to unit test.
 */

/** Mirrors the checked-in stella.gate.json default; a gate result always wins. */
export const DEFAULT_PASS_THRESHOLD = 0.85

export const isMissingEndpointMessage = (message: string | null | undefined): boolean =>
  Boolean(message && /not found|not implemented|404|501|unavailable/i.test(message))

export const describeApiError = (cause: unknown): string => {
  if (cause instanceof ApiError) {
    if (cause.status === 404 || cause.status === 501) {
      return `${cause.message} This endpoint is not available yet. The Stella backend is being built in parallel; try again once it lands.`
    }
    return cause.message
  }
  return cause instanceof Error ? cause.message : String(cause)
}

/* ------------------------------ numbers and money ------------------------------ */

export const formatInteger = (value: number | null | undefined): string =>
  value == null || !Number.isFinite(value) ? '—' : new Intl.NumberFormat('en-US').format(value)

export const formatCompact = (value: number | null | undefined): string =>
  value == null || !Number.isFinite(value)
    ? '—'
    : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)

export const formatUsd = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) {return '—'}
  if (value === 0) {return '$0.00'}
  const absolute = Math.abs(value)
  if (absolute < 0.01) {return `$${value.toFixed(4)}`}
  if (absolute < 1) {return `$${value.toFixed(3)}`}
  return `$${value.toFixed(2)}`
}

export const costPerAnswer = (run: Run): number | null =>
  run.summary && run.summary.cases > 0 ? run.summary.costUsd / run.summary.cases : null

/** Pass-rate delta in percentage points, derived from the two summaries. */
export const passRateDeltaPp = (run: Run | null, baseline: Run | null): number | null => {
  if (!run?.summary || !baseline?.summary) {
    return null
  }
  return (run.summary.passRate - baseline.summary.passRate) * 100
}

export const runElapsedMs = (run: Run, now = Date.now()): number | null => {
  if (run.startedAt == null) {return null}
  return Math.max(0, (run.finishedAt ?? now) - run.startedAt)
}

export const runIsActive = (status: RunStatus | null | undefined): boolean =>
  status === 'queued' || status === 'running'

/* ------------------------------ status labels ------------------------------ */

export const runStatusLabel: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export const runStatusTone = (status: RunStatus): Tone => {
  switch (status) {
    case 'done':
      return 'pass'
    case 'failed':
      return 'fail'
    case 'running':
      return 'info'
    case 'queued':
    case 'cancelled':
      return 'neutral'
  }
}

export const traceStatusLabel: Record<TraceStatus, string> = {
  ok: 'OK',
  error: 'Error',
  aborted: 'Aborted',
  interrupted: 'Interrupted',
}

export const traceStatusTone = (status: TraceStatus): Tone => {
  switch (status) {
    case 'ok':
      return 'pass'
    case 'error':
      return 'fail'
    case 'aborted':
    case 'interrupted':
      return 'warn'
  }
}

export const feedbackLabel = (feedback: Feedback | null): string =>
  feedback === 'up' ? 'Up' : feedback === 'down' ? 'Down' : 'No feedback'

export const behaviorLabel: Record<ExpectedBehavior, string> = {
  answer: 'Answer',
  refuse: 'Refuse',
  any: 'Any',
}

/* ------------------------------ traces ------------------------------ */

/** Remove the retrieval block the gateway appends to the final user turn. */
export const cleanQuestionText = (text: string): string =>
  text
    .replace(/<retrieved_sources>[\s\S]*?<\/retrieved_sources>/gi, ' ')
    .replace(/\s*Use these retrieved sources[\s\S]*$/i, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()

const contentText = (content: unknown): string => {
  if (typeof content === 'string') {return content}
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
          return block.text
        }
        return ''
      })
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

/**
 * Extract the last user message from a stored gateway request. The request is
 * intentionally opaque on the client, so this accepts the common message
 * shapes and returns an empty string rather than guessing.
 */
export const extractQuestion = (request: unknown): string => {
  if (!request || typeof request !== 'object') {return ''}
  const messages = (request as { messages?: unknown }).messages
  if (!Array.isArray(messages)) {return ''}
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || typeof message !== 'object') {continue}
    const record = message as { role?: unknown; content?: unknown }
    if (record.role !== 'user') {continue}
    const text = cleanQuestionText(contentText(record.content))
    if (text) {return text}
  }
  return ''
}

export const traceQuestion = (trace: Trace): string => extractQuestion(trace.request) || '(question not recorded)'

export type TraceFilterInput = {
  limit: number
  q?: string
  feedback?: Feedback | ''
  status?: TraceStatus | ''
  profileId?: string | ''
  cursor?: string | null
}

export const buildTracesPath = (input: TraceFilterInput): string => {
  const params = new URLSearchParams()
  params.set('limit', String(input.limit))
  if (input.q?.trim()) {params.set('q', input.q.trim())}
  if (input.feedback) {params.set('feedback', input.feedback)}
  if (input.status) {params.set('status', input.status)}
  if (input.profileId) {params.set('profileId', input.profileId)}
  if (input.cursor) {params.set('cursor', input.cursor)}
  return `/api/traces?${params.toString()}`
}

export const tracePromoteUrl = (traceId: string): string => `/api/traces/${encodeURIComponent(traceId)}/promote`

/* ------------------------------ release readiness ------------------------------ */

export type ReadinessVerdict = 'PASS' | 'BLOCKED' | 'NOT GATED' | 'NO RUNS'

export type Readiness = {
  verdict: ReadinessVerdict
  tone: Tone
  why: string
}

/**
 * Release readiness comes from a gate result, never from a guessed threshold.
 * A run with no matching gate is honestly reported as not gated.
 */
export const gateReadiness = (run: Run | null, gate: Gate | null): Readiness => {
  if (!run) {
    return {
      verdict: 'NO RUNS',
      tone: 'neutral',
      why: 'No evaluation run exists yet. Run the suite to establish a baseline.',
    }
  }
  if (!gate || gate.candidateRunId !== run.id) {
    return {
      verdict: 'NOT GATED',
      tone: 'warn',
      why: `Run ${shortId(run.id)} has not been evaluated against a release gate. Pick a baseline run and run the gate when this run finishes.`,
    }
  }
  const result = gate.result
  if (!result || typeof result.pass !== 'boolean') {
    return {
      verdict: 'NOT GATED',
      tone: 'warn',
      why: 'The latest gate record has no usable result. Re-run the gate to produce a release decision.',
    }
  }
  if (result.pass) {
    if (result.override) {
      return {
        verdict: 'PASS',
        tone: 'warn',
        why: `Released with an override: ${result.override.reason}`,
      }
    }
    if (result.verdict === 'warn') {
      return {
        verdict: 'PASS',
        tone: 'pass',
        why: result.warnings.length > 0 ? `Passed with warnings: ${result.warnings.join(' ')}` : 'The gate passed with warnings.',
      }
    }
    return {
      verdict: 'PASS',
      tone: 'pass',
      why: `${gate.config.suite || 'Gate'} passed with no blocking failures.`,
    }
  }
  const failure = result.failures[0]
  return {
    verdict: 'BLOCKED',
    tone: 'fail',
    why: failure ? failure.message : 'The gate reported a blocking failure.',
  }
}

/** The newest gate recorded for a run, if any. */
export const gateForRun = (runId: string | null | undefined, gates: Gate[] | null | undefined): Gate | null => {
  if (!runId || !gates || gates.length === 0) {return null}
  return (
    [...gates]
      .filter((gate) => gate.candidateRunId === runId)
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
  )
}

export const gateThreshold = (gate: Gate | null | undefined): number =>
  gate?.config?.thresholds?.passRate ?? DEFAULT_PASS_THRESHOLD

export const gateArtifactUrl = (gateId: string, format: 'md' | 'json' | 'html' = 'md'): string =>
  `/api/gates/${encodeURIComponent(gateId)}/artifact?format=${format}`

/* ------------------------------ runs ------------------------------ */

export type RunItemFilter = 'all' | 'failed' | 'errors'

export const filterRunItems = (items: RunItem[], filter: RunItemFilter): RunItem[] => {
  if (filter === 'failed') {return items.filter((item) => !item.pass)}
  if (filter === 'errors') {return items.filter((item) => item.status === 'error')}
  return items
}

export const sliceRows = (summary: RunSummary | null | undefined): { slice: string; cases: number; passRate: number }[] =>
  summary
    ? Object.entries(summary.slices)
        .map(([slice, value]) => ({ slice, cases: value.cases, passRate: value.passRate }))
        .sort((left, right) => left.slice.localeCompare(right.slice))
    : []

export const retrievalLabel = (retrieval: RunSummary['retrieval'] | null | undefined): string => {
  if (!retrieval || retrieval.evaluated === 0) {return '—'}
  const parts: string[] = []
  if (retrieval.recallAtK != null) {parts.push(`recall ${percentOf(retrieval.recallAtK)}`)}
  if (retrieval.mrr != null) {parts.push(`MRR ${retrieval.mrr.toFixed(2)}`)}
  return parts.length > 0 ? parts.join(' · ') : `${retrieval.evaluated} evaluated`
}

const percentOf = (value: number): string => `${(value * 100).toFixed(1)}%`

export const comparisonPassRate = (overall: Comparison): MetricDelta => overall.passRate

/** A delta is a regression when it is negative; `regressed` flags it for slices. */
export const deltaTone = (value: number | null | undefined): 'good' | 'bad' | 'flat' =>
  value == null || value === 0 ? 'flat' : value > 0 ? 'good' : 'bad'

/* ------------------------------ dataset cases ------------------------------ */

export const parseCommaList = (input: string): string[] => {
  const seen = new Set<string>()
  const values: string[] = []
  for (const part of input.split(',')) {
    const value = part.trim()
    if (!value || seen.has(value)) {continue}
    seen.add(value)
    values.push(value)
  }
  return values
}

export const formatCommaList = (values: string[] | null | undefined): string =>
  values && values.length > 0 ? values.join(', ') : ''

export const questionFromCase = (caseValue: DatasetCase): string => {
  const user = caseValue.messages.filter((message) => message.role === 'user').at(-1)
  return user?.content ?? ''
}

export type AnchorDraft = { doc: string; heading: string; quote?: string }

export type CaseDraft = {
  question: string
  answer: string
  behavior: ExpectedBehavior
  mustContain: string
  mustNotContain: string
  minCitations: string
  slices: string
  anchors: AnchorDraft[]
  notes: string
}

export const emptyCaseDraft = (): CaseDraft => ({
  question: '',
  answer: '',
  behavior: 'any',
  mustContain: '',
  mustNotContain: '',
  minCitations: '0',
  slices: '',
  anchors: [],
  notes: '',
})

export const caseToDraft = (caseValue: DatasetCase): CaseDraft => ({
  question: questionFromCase(caseValue),
  answer: caseValue.expected.answer ?? '',
  behavior: caseValue.expected.behavior,
  mustContain: formatCommaList(caseValue.expected.mustContain),
  mustNotContain: formatCommaList(caseValue.expected.mustNotContain),
  minCitations: String(caseValue.expected.minCitations),
  slices: formatCommaList(caseValue.slices),
  anchors: caseValue.expected.anchors.map((anchor) => ({
    doc: anchor.doc,
    heading: anchor.heading ?? '',
    ...(anchor.quote === undefined ? {} : { quote: anchor.quote }),
  })),
  notes: caseValue.notes ?? '',
})

export const validateCaseDraft = (draft: CaseDraft): string | null => {
  if (!draft.question.trim()) {return 'A question is required.'}
  if (!['answer', 'refuse', 'any'].includes(draft.behavior)) {return 'Choose a valid expected behavior.'}
  const minCitations = Number(draft.minCitations)
  if (!Number.isInteger(minCitations) || minCitations < 0) {return 'Minimum citations must be a whole number of 0 or more.'}
  for (const anchor of draft.anchors) {
    if (anchor.heading.trim() && !anchor.doc.trim()) {return 'Every anchor needs a document path.'}
  }
  return null
}

export const draftToCase = (
  draft: CaseDraft,
  options: { id: string; datasetId: string; sourceTraceId?: string; existing?: DatasetCase }
): DatasetCase => {
  const anchors = draft.anchors
    .map((anchor) => {
      const doc = anchor.doc.trim()
      const heading = anchor.heading.trim()
      const quote = anchor.quote?.trim()
      return {
        doc,
        ...(heading ? { heading } : {}),
        ...(quote ? { quote } : {}),
      }
    })
    .filter((anchor) => anchor.doc.length > 0)
  const systemMessages = options.existing?.messages.filter((message) => message.role === 'system') ?? []
  const result: DatasetCase = {
    id: options.id,
    datasetId: options.datasetId,
    slices: parseCommaList(draft.slices),
    messages: [...systemMessages, { role: 'user', content: draft.question.trim() }],
    expected: {
      behavior: draft.behavior,
      mustContain: parseCommaList(draft.mustContain),
      mustNotContain: parseCommaList(draft.mustNotContain),
      anchors,
      minCitations: Number(draft.minCitations),
    },
  }
  const answer = draft.answer.trim()
  if (answer) {result.expected.answer = answer}
  const notes = draft.notes.trim()
  if (notes) {result.notes = notes}
  if (options.sourceTraceId) {result.sourceTraceId = options.sourceTraceId}
  return result
}

export const newCaseId = (): string => {
  const randomUuid = globalThis.crypto?.randomUUID?.()
  if (randomUuid) {return `case_${randomUuid.replaceAll('-', '').slice(0, 20)}`}
  return `case_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`
}

export const anchorDrift = (resolution: AnchorResolution | null | undefined): {
  tone: Tone
  label: string
  detail: string
} => {
  if (!resolution || resolution.total === 0) {
    return { tone: 'neutral', label: 'No anchors', detail: 'This version declares no gold anchors.' }
  }
  if (resolution.missing.length > 0) {
    return {
      tone: 'fail',
      label: `${resolution.resolved}/${resolution.total} resolve`,
      detail: `${resolution.missing.length} anchor${resolution.missing.length === 1 ? '' : 's'} no longer ${resolution.missing.length === 1 ? 'matches' : 'match'} the corpus: ${resolution.missing.join(', ')}`,
    }
  }
  return {
    tone: 'pass',
    label: `${resolution.resolved}/${resolution.total} resolve`,
    detail: 'All gold anchors resolve against the current corpus.',
  }
}

export const shortHash = (hash: string | null | undefined): string => {
  if (!hash) {return '—'}
  const value = hash.replace(/^sha256:/, '')
  return value.length > 12 ? value.slice(0, 12) : value
}

export const datasetExportUrl = (datasetId: string, version?: number | null): string =>
  `/api/datasets/${encodeURIComponent(datasetId)}/export${version == null ? '' : `?version=${version}`}`

export const datasetDetailUrl = (datasetId: string): string => `/api/datasets/${encodeURIComponent(datasetId)}`

/* ------------------------------ profiles and sweeps ------------------------------ */

export type SweepRerank = 'off' | 'llm'

export type SweepVariant = {
  k: number
  rerank: SweepRerank
  label: string
}

export const buildSweepVariants = (ks: number[], reranks: SweepRerank[]): SweepVariant[] =>
  ks.flatMap((k) =>
    reranks.map((rerank) => ({
      k,
      rerank,
      label: `k=${k} · rerank ${rerank}`,
    }))
  )

/** Clone a profile spec for one retrieval variant, preserving every other knob. */
export const sweepVariantSpec = (spec: ProfileSpec, k: number, rerank: SweepRerank): ProfileSpec => {
  const retrieval: RetrievalSpec = {
    ...spec.retrieval,
    k,
    candidates: Math.max(spec.retrieval.candidates, k),
    rerank,
  }
  return {
    model: { ...spec.model },
    retrieval,
    prompt: { ...spec.prompt },
    judge: { ...spec.judge },
  }
}

export const profileRetrievalLabel = (spec: ProfileSpec): string => {
  if (!spec.retrieval.enabled) {return 'Retrieval off'}
  return `k ${spec.retrieval.k} · rerank ${spec.retrieval.rerank}`
}

export const finetuneFormatLabel: Record<FinetuneFormat, string> = {
  sft: 'SFT chat',
  sharegpt: 'ShareGPT',
  dpo: 'DPO pairs',
}

export const finetuneProviderOptions = [
  'unsloth',
  'axolotl',
  'together',
  'openai-compatible',
] as const

export const resolvePreflightStats = (
  report: FinetunePreflightResponse | null | undefined
): Partial<FinetunePreflightResponse> => {
  if (!report) {return {}}
  // Direct report fields (for example the contamination object) must not
  // overwrite the numeric counters in `stats`.
  const merged = { ...(report.report ?? {}), ...report, ...(report.stats ?? {}) }
  return merged as Partial<FinetunePreflightResponse>
}

export const preflightNotes = (report: FinetunePreflightResponse | null | undefined): string[] => {
  if (!report) {return []}
  const notes: string[] = []
  for (const item of [...(report.issues ?? []), ...(report.warnings ?? [])]) {
    if (typeof item === 'string') {
      notes.push(item)
      continue
    }
    if (item && typeof item === 'object') {
      const message = item.message ?? item.detail
      if (message) {notes.push(item.severity ? `${item.severity}: ${message}` : message)}
    }
  }
  for (const failure of report.failures ?? []) {notes.push(`failure: ${failure}`)}
  for (const check of report.checks ?? []) {
    const label = check.message ?? check.detail
    if (check.ok === false && label) {notes.push(`${check.level ?? 'error'}: ${label}`)}
    else if (check.ok === undefined && label) {notes.push(label)}
    else if (check.ok === undefined && check.name && check.status) {notes.push(`${check.name}: ${check.status}`)}
  }
  return notes
}

/* ------------------------------ misc ------------------------------ */

export const overviewTrend = (overview: Overview | null): number[] =>
  overview ? overview.trend.map((point) => point.passRate) : []

export const confidenceLabel = (summary: Pick<RunSummary, 'passRate' | 'ciLow' | 'ciHigh'>): string =>
  `${(summary.passRate * 100).toFixed(1)}% · 95% CI ${(summary.ciLow * 100).toFixed(1)}–${(summary.ciHigh * 100).toFixed(1)}%`

/** Re-exported for page call sites that already import lib helpers. */
export { pluralize, shortId }
