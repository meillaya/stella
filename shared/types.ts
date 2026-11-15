/** Shared domain contracts for the Stella app and server. Keep this file dependency-free. */

export type ModelId = 'deepseek-flash' | 'deepseek-v4-pro'
export type ThinkingMode = 'enabled' | 'disabled'
export type PricingBasis = 'peak' | 'off-peak'

export type TokenUsage = {
  /** Prompt tokens that missed the prefix cache. */
  inputTokens: number
  /** Prompt tokens served from the prefix cache. */
  cacheReadTokens: number
  /** Cache writes. The DeepSeek API currently reports 0. */
  cacheCreationTokens: number
  /** Completion tokens, including thinking tokens where applicable. */
  outputTokens: number
  thinkingTokens?: number
  /** True when the usage was estimated because the stream ended without usage. */
  estimated?: boolean
}

export type SourceRef = {
  /** Stable reference id inside a single request: "s1", "s2", ... */
  id: string
  chunkId: string
  documentId: string
  title: string
  heading: string | null
  page: number | null
  score: number
  snippet: string
}

export type TraceStatus = 'ok' | 'error' | 'aborted' | 'interrupted'
export type Feedback = 'up' | 'down'

export type TraceResponse = {
  text: string
  thinking?: string | null
  stopReason: string | null
  title?: string | null
  toolCalls: number
  citations: { url: string; title: string | null }[]
}

export type Trace = {
  id: string
  sessionId: string | null
  sessionKey: string
  createdAt: number
  status: TraceStatus
  model: string
  thinking: boolean
  profileId: string | null
  profileName: string | null
  retrievalEnabled: boolean
  latencyMs: number
  ttfbMs: number | null
  usage: TokenUsage
  costUsd: number
  pricingBasis: PricingBasis
  request: unknown
  response: TraceResponse
  sources: SourceRef[]
  injectedContext: string | null
  /** Set when retrieval was attempted but failed; chat continued without sources. */
  retrievalError: string | null
  error: string | null
  feedback: Feedback | null
  annotation: string | null
}

export type TraceSummary = Pick<
  Trace,
  | 'id'
  | 'sessionKey'
  | 'createdAt'
  | 'status'
  | 'model'
  | 'profileName'
  | 'retrievalEnabled'
  | 'latencyMs'
  | 'costUsd'
  | 'feedback'
> & {
  question: string
  answerPreview: string
  sourceCount: number
}

export type Collection = {
  id: string
  name: string
  description: string
  documentCount: number
  chunkCount: number
  createdAt: number
  updatedAt: number
}

export type DocumentRecord = {
  id: string
  collectionId: string
  title: string
  sourceType: 'file' | 'url' | 'text'
  uri: string | null
  bytes: number
  pageCount: number
  chunkCount: number
  contentHash: string
  createdAt: number
  meta: Record<string, unknown>
}

export type RetrievedChunk = SourceRef & { text: string }

/* ------------------------------ datasets ------------------------------ */

export type ExpectedBehavior = 'answer' | 'refuse' | 'any'

export type GoldAnchor = {
  /** Document path or title, e.g. "policies/refunds.md". */
  doc: string
  /** Matching heading breadcrumb fragment. */
  heading?: string
  /** Optional exact quote that must resolve inside the chunk. */
  quote?: string
}

export type DatasetCase = {
  id: string
  datasetId?: string
  slices: string[]
  messages: { role: 'user' | 'system'; content: string }[]
  expected: {
    answer?: string
    behavior: ExpectedBehavior
    mustContain: string[]
    mustNotContain: string[]
    anchors: GoldAnchor[]
    minCitations: number
  }
  notes?: string
  sourceTraceId?: string
  createdAt?: number
  updatedAt?: number
}

export type AnchorResolution = {
  resolved: number
  total: number
  missing: string[]
}

export type Dataset = {
  id: string
  name: string
  description: string
  createdAt: number
  caseCount: number
  latestVersion: number | null
}

export type DatasetVersion = {
  id: string
  datasetId: string
  version: number
  path: string
  contentHash: string
  caseCount: number
  notes: string
  createdAt: number
  anchorStatus: AnchorResolution
}

/* ------------------------------ profiles ------------------------------ */

export type ModelSpec = {
  id: ModelId
  thinking: boolean
  effort?: 'low' | 'high' | 'max'
  maxTokens: number
}

export type RetrievalSpec = {
  enabled: boolean
  collection: string | null
  k: number
  candidates: number
  rerank: 'off' | 'llm'
  contextBudgetTokens: number
  parentExpansion: boolean
}

export type PromptSpec = {
  template: 'plain' | 'rag-v1' | 'rag-v2'
  citationStyle: 'bracket'
}

export type JudgeSpec = {
  rubric: 'judge-v1'
  passScore: number
  model?: ModelId
}

export type ProfileSpec = {
  model: ModelSpec
  retrieval: RetrievalSpec
  prompt: PromptSpec
  judge: JudgeSpec
}

export type Profile = {
  id: string
  name: string
  version: number
  parentId: string | null
  spec: ProfileSpec
  createdAt: number
  publishedAt: number | null
}

/* ------------------------------ runs ------------------------------ */

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export type RunMode = 'live' | 'replay'
export type ProviderId = 'deepseek' | 'openai-compatible' | 'replay'

export type GraderKind =
  | 'contains'
  | 'not_contains'
  | 'regex'
  | 'json_valid'
  | 'citation_valid'
  | 'min_citations'
  | 'refusal_expected'
  | 'max_cost_usd'
  | 'max_latency_ms'
  | 'faithfulness'
  | 'answer_relevance'
  | 'rubric'

export type GraderConfig = {
  id: string
  kind: GraderKind
  name: string
  required: boolean
  config: Record<string, unknown>
}

export type GraderResult = {
  graderId: string
  kind: GraderKind
  pass: boolean
  score?: number
  detail?: string
  error?: string
  latencyMs?: number
}

export type RetrievalMetrics = {
  evaluated: number
  recallAtK?: number
  precisionAtK?: number
  mrr?: number
  ndcgAtK?: number
}

export type RunItem = {
  id: string
  runId: string
  caseId: string
  slices: string[]
  status: 'ok' | 'error' | 'skipped'
  answer: string
  usage: TokenUsage
  costUsd: number
  latencyMs: number
  sources: SourceRef[]
  graderResults: GraderResult[]
  pass: boolean
  retrieval: RetrievalMetrics | null
  error: string | null
}

export type SliceSummary = {
  cases: number
  pass: number
  passRate: number
  costUsd: number
  p95LatencyMs: number
}

export type RunSummary = {
  cases: number
  pass: number
  passRate: number
  ciLow: number
  ciHigh: number
  costUsd: number
  costPerPassUsd: number | null
  p50LatencyMs: number
  p95LatencyMs: number
  graderErrors: number
  judgeAgreement: number | null
  judgeKappa: number | null
  retrieval: RetrievalMetrics | null
  slices: Record<string, SliceSummary>
}

export type Run = {
  id: string
  datasetId: string
  datasetName: string
  datasetVersion: number
  profileId: string
  profileName: string
  provider: ProviderId
  mode: RunMode
  status: RunStatus
  budgetUsd: number
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  summary: RunSummary | null
  error: string | null
}

/** A metric with its baseline/candidate values. `delta` for pass-rate style metrics is in percentage points. */
export type MetricDelta = {
  baseline: number | null
  candidate: number | null
  delta: number | null
  deltaPct: number | null
  ciLowPp?: number | null
  ciHighPp?: number | null
  probabilityNotBetter?: number | null
}

export type Comparison = {
  baselineRunId: string
  candidateRunId: string
  cases: number
  passRate: MetricDelta
  costPerPassUsd: MetricDelta
  p95LatencyMs: MetricDelta
  improved: number
  regressed: number
  unchanged: number
  judgeAgreement: number | null
}

export type SliceComparison = {
  slice: string
  cases: number
  passRate: MetricDelta
  regressed: boolean
}


/* ------------------------------ gates ------------------------------ */

export type GateThresholds = {
  passRate: number
  faithfulness: number
  citationValidity: number
  refusalAccuracy: number
  maxCostPerCaseUsd: number
  maxP95LatencyMs: number
}

export type GateRegressionRules = {
  overallMaxDropPp: number
  sliceMaxDropPp: number
  minSliceCases: number
}

export type GateJudgeRules = {
  requireCalibration: boolean
  minAgreement: number
  maxGraderErrorsPct: number
}

export type GateConfig = {
  suite: string
  minCases: number
  thresholds: GateThresholds
  regression: GateRegressionRules
  judge: GateJudgeRules
  overrides: { allowed: boolean; requireReason: boolean }
}

export type GateFailure = {
  rule: string
  message: string
  actual: number | string | null
  expected: number | string | null
}

export type GateResult = {
  pass: boolean
  verdict: 'pass' | 'fail' | 'warn'
  failures: GateFailure[]
  warnings: string[]
  checkedAt: number
  override: { reason: string; by: string | null } | null
}

export type Gate = {
  id: string
  baselineRunId: string
  candidateRunId: string
  config: GateConfig
  result: GateResult
  createdAt: number
}

/* ------------------------------ fine-tuning ------------------------------ */

export type FinetuneFormat = 'sft' | 'sharegpt' | 'dpo'

export type FinetuneExportStats = {
  examples: number
  dropped: number
  duplicates: number
  piiRedactions: number
  train: number
  val: number
  holdout: number
  contamination: number
  estimatedTokens: number
}

export type FinetuneExport = {
  id: string
  datasetId: string
  datasetName: string
  datasetVersion: number
  format: FinetuneFormat
  path: string
  manifestPath: string
  stats: FinetuneExportStats
  createdAt: number
}

export type FinetuneJobStatus = 'queued' | 'submitted' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type FinetuneJob = {
  id: string
  provider: string
  baseModel: string
  exportId: string
  status: FinetuneJobStatus
  externalId: string | null
  error: string | null
  createdAt: number
  updatedAt: number
}

/* ------------------------------ jobs / events ------------------------------ */

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export type Job = {
  id: string
  kind: string
  status: JobStatus
  progress: number
  payload: Record<string, unknown>
  error: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

/* ------------------------------ UI payloads ------------------------------ */

export type StellaSettings = {
  activeProfileId: string | null
  traceRetentionDays: number
  defaultModel: ModelId
}

export type KeyStatus = {
  configured: boolean
  source: 'env' | 'file' | 'request' | 'none'
  lastFour: string | null
  baseUrl: string
}

export type Overview = {
  hasKey: boolean
  activeProfile: Profile | null
  dataset: { id: string; name: string; version: number; cases: number } | null
  latestRun: Run | null
  baselineRun: Run | null
  gate: Gate | null
  metrics: {
    passRate: number | null
    passRateDeltaPp: number | null
    costPerPassUsd: number | null
    costDeltaPct: number | null
    p95LatencyMs: number | null
    latencyDeltaPct: number | null
    cases: number
    traces24h: number
    negativeFeedback24h: number
  }
  trend: { runId: string; createdAt: number; passRate: number; costPerPassUsd: number }[]
  failingCases: { caseId: string; answer: string; slices: string[]; failedGraders: string[] }[]
  reviewQueue: TraceSummary[]
}

export type ApiError = { error: { message: string; code?: string } }
