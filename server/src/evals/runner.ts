/**
 * Eval runner: queued runs, in-process async execution, per-case answers via
 * provider adapters, retrieval via the RAG adapter, deterministic graders, the
 * LLM judge, retrieval metrics, and the run summary.
 *
 * Runs persist a `queued` row immediately and execute in the background (API)
 * or synchronously when awaited (CLI `--wait`, tests with `queue:false`).
 * Cancellation and budget are checked between cases; in-flight cases finish.
 */

import { pairedBootstrap, percentile, wilsonInterval } from '../../../shared/metrics.ts'
import { computeCost, isPeak, nextOffPeak, pricingBasis } from '../../../shared/pricing.ts'
import type {
  Comparison,
  DatasetCase,
  GraderConfig,
  GraderResult,
  MetricDelta,
  Profile,
  ProviderId,
  RetrievedChunk,
  RetrievalMetrics,
  Run,
  RunItem,
  RunMode,
  RunStatus,
  RunSummary,
  SliceComparison,
  SliceSummary,
  SourceRef,
  TokenUsage,
} from '../../../shared/types.ts'
import { newId, now } from '../../../shared/ids.ts'
import { config } from '../config.ts'
import { getDb, parseJson, type Db } from '../db/index.ts'
import { createAdapters, type AdapterOverrides, type EvalAdapters } from './adapters.ts'
import {
  getDatasetVersion,
  readVersionCases,
  requireDataset,
  createAnchorResolver,
  type AnchorResolver,
} from './datasets.ts'
import { BusinessError, errorMessage } from './errors.ts'
import {
  buildCaseGraders,
  countGraderErrors,
  itemPassed,
  runGraders,
  type GradeContext,
} from './graders.ts'
import {
  RUBRIC_GRADER_ID,
  judgeAnswer,
  judgeProvenance,
  loadCalibrationSet,
  runJudgeCalibration,
  type JudgeCalibration,
  type JudgeProvenance,
  type JudgeResultMeta,
} from './judge.ts'
import { buildPromptMessages, questionOf } from './prompts.ts'
import { getProfile } from './profiles.ts'

/* ------------------------------ run config ------------------------------ */

export type RunConfig = {
  /** Run the rubric judge per item. Default: live mode with a configured key. */
  judge: boolean
  /** Run judge calibration against datasets/calibration when available. */
  calibration: boolean
  maxCostPerCaseUsd: number | null
  maxLatencyMs: number | null
  concurrency: number
  offPeak: boolean
  /** Epoch ms when off-peak scheduling releases the run; null = immediately. */
  scheduledAt: number | null
  extraGraders: GraderConfig[]
  /** Reproducible bootstrap/PRNG seed for comparisons. */
  seed: number
  judgeMeta?: JudgeProvenance | null
  calibrationMeta?: {
    source: string | null
    items: number
    evaluated: number
    errors: number
    agreement: number | null
    kappa: number | null
  } | null
  warnings?: string[]
}

export const DEFAULT_RUN_CONFIG: Omit<RunConfig, 'concurrency'> = {
  judge: false,
  calibration: false,
  maxCostPerCaseUsd: null,
  maxLatencyMs: null,
  offPeak: false,
  scheduledAt: null,
  extraGraders: [],
  seed: 42,
  judgeMeta: null,
  calibrationMeta: null,
  warnings: [],
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const normalizeGraderConfig = (value: unknown, index: number): GraderConfig | null => {
  if (!isRecord(value)) {
    return null
  }
  if (typeof value.kind !== 'string') {
    return null
  }
  return {
    id: typeof value.id === 'string' && value.id.length > 0 ? value.id : `extra:${index}`,
    kind: value.kind as GraderConfig['kind'],
    name: typeof value.name === 'string' ? value.name : `${String(value.kind)} #${index + 1}`,
    required: value.required !== false,
    config: isRecord(value.config) ? { ...value.config } : {},
  }
}

export const mergeRunConfig = (partial: unknown): RunConfig => {
  const input = isRecord(partial) ? partial : {}
  const extra: GraderConfig[] = []
  if (Array.isArray(input.extraGraders)) {
    for (const [index, entry] of input.extraGraders.entries()) {
      const grader = normalizeGraderConfig(entry, index)
      if (grader) {
        extra.push(grader)
      }
    }
  }
  const concurrencyRaw = numberOrNull(input.concurrency)
  return {
    ...DEFAULT_RUN_CONFIG,
    judge: input.judge === true,
    calibration: input.calibration === true,
    maxCostPerCaseUsd: numberOrNull(input.maxCostPerCaseUsd),
    maxLatencyMs: numberOrNull(input.maxLatencyMs),
    concurrency:
      concurrencyRaw !== null && concurrencyRaw >= 1
        ? Math.min(64, Math.floor(concurrencyRaw))
        : config.runConcurrency,
    offPeak: input.offPeak === true,
    scheduledAt: numberOrNull(input.scheduledAt),
    extraGraders: extra,
    seed: numberOrNull(input.seed) !== null ? Math.floor(numberOrNull(input.seed) as number) : 42,
  }
}

export const parseRunConfig = (json: string | null | undefined): RunConfig =>
  mergeRunConfig(parseJson<unknown>(json, {}))

export const readRunConfig = (runId: string, db: Db = getDb()): RunConfig => {
  const row = db.prepare('SELECT config_json FROM runs WHERE id = ?').get(runId) as
    | { config_json: string }
    | undefined
  if (!row) {
    throw new BusinessError(`run not found: ${runId}`, 'run_not_found', 404)
  }
  return parseRunConfig(row.config_json)
}

/* ------------------------------ row mapping ------------------------------ */

type RunRow = {
  id: string
  dataset_id: string
  dataset_version_id: string
  profile_id: string
  provider: string
  mode: string
  status: string
  budget_usd: number
  config_json: string
  summary_json: string | null
  error: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

type RunItemRow = {
  id: string
  run_id: string
  case_id: string
  data_json: string | null
  status: string
  answer: string
  usage_json: string
  cost_usd: number
  latency_ms: number
  sources_json: string
  retrieval_json: string | null
  grader_results_json: string
  pass: number
  error: string | null
}

const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
})

const requireRunRow = (runId: string, db: Db): RunRow => {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined
  if (!row) {
    throw new BusinessError(`run not found: ${runId}`, 'run_not_found', 404)
  }
  return row
}

export const mapRunRow = (row: RunRow, db: Db = getDb()): Run => {
  const dataset = db.prepare('SELECT name FROM datasets WHERE id = ?').get(row.dataset_id) as
    | { name: string }
    | undefined
  const version = db
    .prepare('SELECT version FROM dataset_versions WHERE id = ?')
    .get(row.dataset_version_id) as { version: number } | undefined
  const profile = db.prepare('SELECT name FROM profiles WHERE id = ?').get(row.profile_id) as
    | { name: string }
    | undefined
  return {
    id: row.id,
    datasetId: row.dataset_id,
    datasetName: dataset?.name ?? 'unknown',
    datasetVersion: version?.version ?? 0,
    profileId: row.profile_id,
    profileName: profile?.name ?? 'unknown',
    provider: (row.provider === 'replay'
      ? 'replay'
      : row.provider === 'openai-compatible'
        ? 'openai-compatible'
        : 'deepseek') as ProviderId,
    mode: (row.mode === 'replay' ? 'replay' : 'live') as RunMode,
    status: row.status as RunStatus,
    budgetUsd: row.budget_usd,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    summary: parseJson<RunSummary | null>(row.summary_json, null),
    error: row.error,
  }
}

export const mapRunItemRow = (row: RunItemRow): RunItem => ({
  id: row.id,
  runId: row.run_id,
  caseId: row.case_id,
  slices: (() => {
    if (!row.data_json) {
      return []
    }
    const parsed = parseJson<Partial<DatasetCase>>(row.data_json, {})
    return Array.isArray(parsed.slices)
      ? parsed.slices.filter((slice): slice is string => typeof slice === 'string')
      : []
  })(),
  status: row.status as RunItem['status'],
  answer: row.answer,
  usage: parseJson<TokenUsage>(row.usage_json, emptyUsage()),
  costUsd: row.cost_usd,
  latencyMs: row.latency_ms,
  sources: parseJson<SourceRef[]>(row.sources_json, []),
  graderResults: parseJson<GraderResult[]>(row.grader_results_json, []),
  pass: row.pass === 1,
  retrieval: parseJson<RetrievalMetrics | null>(row.retrieval_json, null),
  error: row.error,
})

const persistRunItem = (db: Db, item: RunItem): void => {
  db.prepare(
    `INSERT INTO run_items(id, run_id, case_id, status, answer, usage_json, cost_usd, latency_ms,
       sources_json, retrieval_json, grader_results_json, pass, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    item.id,
    item.runId,
    item.caseId,
    item.status,
    item.answer,
    JSON.stringify(item.usage),
    item.costUsd,
    item.latencyMs,
    JSON.stringify(item.sources),
    item.retrieval === null ? null : JSON.stringify(item.retrieval),
    JSON.stringify(item.graderResults),
    item.pass ? 1 : 0,
    item.error
  )
}

/* ------------------------------ catalogue queries ------------------------------ */

export const getRun = (runId: string, db: Db = getDb()): Run =>
  mapRunRow(requireRunRow(runId, db), db)

export const listRuns = (
  options: { limit?: number; datasetId?: string; status?: RunStatus; mode?: RunMode } = {},
  db: Db = getDb()
): Run[] => {
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (options.datasetId) {
    clauses.push('dataset_id = ?')
    params.push(options.datasetId)
  }
  if (options.status) {
    clauses.push('status = ?')
    params.push(options.status)
  }
  if (options.mode) {
    clauses.push('mode = ?')
    params.push(options.mode)
  }
  const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 50)))
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db
    .prepare(`SELECT * FROM runs ${where} ORDER BY created_at DESC, id ASC LIMIT ?`)
    .all(...params, limit) as RunRow[]
  return rows.map((row) => mapRunRow(row, db))
}

export const getRunItems = (runId: string, db: Db = getDb()): RunItem[] => {
  requireRunRow(runId, db)
  const rows = db
    .prepare(
      `SELECT ri.*, c.data_json AS data_json
       FROM run_items ri
       JOIN runs r ON r.id = ri.run_id
       LEFT JOIN cases c ON c.dataset_id = r.dataset_id AND c.case_key = ri.case_id
       WHERE ri.run_id = ? ORDER BY ri.rowid ASC`
    )
    .all(runId) as RunItemRow[]
  return rows.map(mapRunItemRow)
}

/* ------------------------------ retrieval metrics ------------------------------ */

export type RetrievalMetricInput = {
  retrieved: SourceRef[]
  goldChunkIds: string[]
}

/**
 * Deterministic per-item retrieval metrics with binary relevance:
 * - recall@k    = |relevant ∩ retrieved| / |gold|
 * - precision@k = |relevant ∩ retrieved| / |retrieved|
 * - MRR         = 1 / rank of the first relevant chunk (0 when none)
 * - nDCG@k      = DCG / IDCG with DCG = Σ rel_i / log2(i+1), ideal = first |gold| ranks
 */
export const computeRetrievalMetrics = (input: RetrievalMetricInput): RetrievalMetrics | null => {
  const gold = new Set(input.goldChunkIds)
  if (gold.size === 0) {
    return null
  }
  const retrieved = input.retrieved.map((source) => source.chunkId)
  const relevance = retrieved.map((chunkId) => gold.has(chunkId))
  const relevant = relevance.filter(Boolean).length
  const recallAtK = relevant / gold.size
  const precisionAtK = retrieved.length === 0 ? 0 : relevant / retrieved.length
  const firstIndex = relevance.findIndex((entry) => entry)
  const mrr = firstIndex === -1 ? 0 : 1 / (firstIndex + 1)
  const k = retrieved.length
  let dcg = 0
  for (const [index, value] of relevance.entries()) {
    if (value) {
      dcg += 1 / Math.log2(index + 2)
    }
  }
  let idcg = 0
  for (let rank = 1; rank <= Math.min(gold.size, k); rank += 1) {
    idcg += 1 / Math.log2(rank + 1)
  }
  const ndcgAtK = idcg === 0 ? 0 : dcg / idcg
  return { evaluated: 1, recallAtK, precisionAtK, mrr, ndcgAtK }
}

const meanOf = (values: number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length

export const aggregateRetrieval = (items: RunItem[]): RetrievalMetrics | null => {
  const evaluated = items
    .map((item) => item.retrieval)
    .filter((retrieval): retrieval is RetrievalMetrics => retrieval !== null)
  if (evaluated.length === 0) {
    return null
  }
  const aggregate: RetrievalMetrics = { evaluated: evaluated.length }
  const recall = meanOf(
    evaluated
      .map((entry) => entry.recallAtK)
      .filter((value): value is number => value !== undefined)
  )
  const precision = meanOf(
    evaluated
      .map((entry) => entry.precisionAtK)
      .filter((value): value is number => value !== undefined)
  )
  const mrr = meanOf(
    evaluated.map((entry) => entry.mrr).filter((value): value is number => value !== undefined)
  )
  const ndcg = meanOf(
    evaluated.map((entry) => entry.ndcgAtK).filter((value): value is number => value !== undefined)
  )
  if (recall !== undefined) {
    aggregate.recallAtK = recall
  }
  if (precision !== undefined) {
    aggregate.precisionAtK = precision
  }
  if (mrr !== undefined) {
    aggregate.mrr = mrr
  }
  if (ndcg !== undefined) {
    aggregate.ndcgAtK = ndcg
  }
  return aggregate
}

/* ------------------------------ summary ------------------------------ */

export type SummaryInput = {
  cases: DatasetCase[]
  items: RunItem[]
  calibration: JudgeCalibration | null
}

export const summarizeRun = (input: SummaryInput): RunSummary => {
  const items = input.items
  const total = items.length
  const passCount = items.filter((item) => item.pass).length
  const interval = wilsonInterval(passCount, total)
  const costUsd = items.reduce((sum, item) => sum + item.costUsd, 0)
  const latencies = items
    .filter((item) => item.status !== 'skipped')
    .map((item) => item.latencyMs)
    .filter((value) => value >= 0)
  const p50 = percentile(latencies, 0.5) ?? 0
  const p95 = percentile(latencies, 0.95) ?? 0
  const graderErrors = items.reduce((sum, item) => sum + countGraderErrors(item.graderResults), 0)
  const caseById = new Map(input.cases.map((caseValue) => [caseValue.id, caseValue]))
  const slices: Record<string, SliceSummary> = {}
  for (const item of items) {
    const caseValue = caseById.get(item.caseId)
    const names = caseValue?.slices ?? item.slices
    for (const slice of names) {
      const current = slices[slice] ?? {
        cases: 0,
        pass: 0,
        passRate: 0,
        costUsd: 0,
        p95LatencyMs: 0,
      }
      current.cases += 1
      current.pass += item.pass ? 1 : 0
      current.costUsd += item.costUsd
      slices[slice] = current
    }
  }
  for (const [slice, entry] of Object.entries(slices)) {
    entry.passRate = entry.cases === 0 ? 0 : entry.pass / entry.cases
    const sliceLatencies = items
      .filter((item) => {
        const caseValue = caseById.get(item.caseId)
        return (caseValue?.slices ?? []).includes(slice) && item.status !== 'skipped'
      })
      .map((item) => item.latencyMs)
    entry.p95LatencyMs = percentile(sliceLatencies, 0.95) ?? 0
  }
  return {
    cases: total,
    pass: passCount,
    passRate: total === 0 ? 0 : passCount / total,
    ciLow: interval.low,
    ciHigh: interval.high,
    costUsd,
    costPerPassUsd: passCount === 0 ? null : costUsd / passCount,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    graderErrors,
    judgeAgreement: input.calibration?.agreement ?? null,
    judgeKappa: input.calibration?.kappa ?? null,
    retrieval: aggregateRetrieval(items),
    slices,
  }
}

/* ------------------------------ run execution ------------------------------ */

type ActiveRun = { cancelled: boolean }
const activeRuns = new Map<string, ActiveRun>()

export type CreateRunInput = {
  datasetVersionId: string
  profileId: string
  budgetUsd?: number
  offPeak?: boolean
  mode?: RunMode
  config?: Partial<RunConfig>
}

export type CreateRunOptions = {
  db?: Db
  adapters?: AdapterOverrides
  /** Queue the background execution (default true); CLI/tests pass false. */
  queue?: boolean
  /** Override judge execution (tests / CLI --judge). */
  judge?: boolean
}

const scheduleExecution = (runId: string, options: CreateRunOptions, delayMs: number): void => {
  const timer = setTimeout(
    () => {
      void executeRun(runId, options).catch(() => {
        // executeRun records failures on the run row; nothing to rethrow into.
      })
    },
    Math.max(0, delayMs)
  )
  timer.unref()
}

/** Create a queued run row and (optionally) start background execution. */
export const createRun = (input: CreateRunInput, options: CreateRunOptions = {}): Run => {
  const db = options.db ?? getDb()
  const version = getDatasetVersion(input.datasetVersionId, db)
  const dataset = requireDataset(version.datasetId, db)
  const profile = getProfile(input.profileId, db)
  const spec = profile.spec
  if (spec.retrieval.enabled && !spec.retrieval.collection) {
    throw new BusinessError(
      `profile "${profile.name}" enables retrieval but has no collection configured`,
      'invalid_profile_spec',
      400
    )
  }
  const mode: RunMode = input.mode ?? (config.mode === 'replay' ? 'replay' : 'live')
  if (mode === 'live' && !config.apiKey) {
    throw new BusinessError(
      'live eval runs require DEEPSEEK_API_KEY in .env.local. Without a key, run against recorded replay cassettes (`stella record`, then STELLA_MODE=replay / mode: "replay"). Stella never fabricates model calls.',
      'missing_api_key',
      400
    )
  }
  const budgetUsd =
    typeof input.budgetUsd === 'number' && Number.isFinite(input.budgetUsd) && input.budgetUsd > 0
      ? input.budgetUsd
      : 0
  const requested = mergeRunConfig(input.config ?? {})
  const liveJudgeDefault = mode === 'live' && Boolean(config.apiKey)
  const startedAt = now()
  let scheduledAt: number | null = null
  if (input.offPeak === true) {
    scheduledAt = isPeak(startedAt) ? nextOffPeak(startedAt).start : startedAt
  }
  const runConfig: RunConfig = {
    ...requested,
    judge: options.judge ?? requested.judge ?? liveJudgeDefault,
    calibration: requested.calibration || (options.judge ?? liveJudgeDefault),
    offPeak: input.offPeak === true,
    scheduledAt,
  }
  const id = newId('run')
  db.prepare(
    `INSERT INTO runs(id, dataset_id, dataset_version_id, profile_id, provider, mode, status, budget_usd, config_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`
  ).run(
    id,
    dataset.id,
    version.id,
    profile.id,
    mode === 'replay' ? 'replay' : 'deepseek',
    mode,
    budgetUsd,
    JSON.stringify(runConfig),
    startedAt
  )
  if (options.queue !== false) {
    scheduleExecution(id, options, scheduledAt === null ? 0 : scheduledAt - startedAt)
  }
  return getRun(id, db)
}

export type ExecuteRunOptions = CreateRunOptions & {
  /** Override calibration directory (tests). */
  calibrationDir?: string
  /** Override run concurrency (tests). */
  concurrency?: number
}

type CaseOutcome = {
  item: RunItem
  judgeMeta: JudgeResultMeta | null
}

type EvaluateCaseInput = {
  runId: string
  caseValue: DatasetCase
  profile: Profile
  adapters: EvalAdapters
  runConfig: RunConfig
  resolver: AnchorResolver
  judgeEnabled: boolean
}

const toSourceRef = (chunk: RetrievedChunk): SourceRef => ({
  id: chunk.id,
  chunkId: chunk.chunkId,
  documentId: chunk.documentId,
  title: chunk.title,
  heading: chunk.heading,
  page: chunk.page,
  score: chunk.score,
  snippet: chunk.snippet,
})

const errorItem = (input: {
  runId: string
  caseValue: DatasetCase
  error: string
  latencyMs: number
  partial?: { answer: string; usage: TokenUsage; costUsd: number; sources: SourceRef[] } | null
}): RunItem => ({
  id: newId('item'),
  runId: input.runId,
  caseId: input.caseValue.id,
  slices: [...input.caseValue.slices],
  status: 'error',
  answer: input.partial?.answer ?? '',
  usage: input.partial?.usage ?? emptyUsage(),
  costUsd: input.partial?.costUsd ?? 0,
  latencyMs: input.latencyMs,
  sources: input.partial?.sources ?? [],
  graderResults: [],
  pass: false,
  retrieval: null,
  error: input.error,
})

const evaluateCase = async (input: EvaluateCaseInput): Promise<CaseOutcome> => {
  const { caseValue, profile, adapters, runConfig, resolver, runId } = input
  const spec = profile.spec
  const startedAt = Date.now()
  const query = questionOf(caseValue)
  let retrievedChunks: RetrievedChunk[] = []
  let sources: SourceRef[] = []
  try {
    if (spec.retrieval.enabled && spec.retrieval.collection) {
      const retrieval = await adapters.retrieve({
        collection: spec.retrieval.collection,
        query,
        k: spec.retrieval.k,
        candidates: spec.retrieval.candidates,
        rerank: spec.retrieval.rerank,
        contextBudgetTokens: spec.retrieval.contextBudgetTokens,
        parentExpansion: spec.retrieval.parentExpansion,
      })
      retrievedChunks = retrieval.chunks
      sources = retrieval.chunks.map(toSourceRef)
    }
    const prompt = buildPromptMessages({
      case: caseValue,
      prompt: spec.prompt,
      chunks: retrievedChunks,
      contextBudgetTokens: spec.retrieval.contextBudgetTokens,
      retrievalEnabled: spec.retrieval.enabled,
    })
    const chat = await adapters.chat({
      model: spec.model.id,
      system: prompt.system,
      messages: prompt.messages,
      maxTokens: spec.model.maxTokens,
      thinking: spec.model.thinking,
      ...(spec.model.effort !== undefined ? { effort: spec.model.effort } : {}),
    })
    const usage = chat.usage
    const costUsd =
      typeof chat.costUsd === 'number' && Number.isFinite(chat.costUsd) && chat.costUsd >= 0
        ? chat.costUsd
        : computeCost(usage, spec.model.id).usd
    const latencyMs =
      typeof chat.latencyMs === 'number' && chat.latencyMs >= 0
        ? chat.latencyMs
        : Date.now() - startedAt
    const graders: GraderConfig[] = buildCaseGraders({
      case: caseValue,
      maxCostUsd: runConfig.maxCostPerCaseUsd,
      maxLatencyMs: runConfig.maxLatencyMs,
      extra: runConfig.extraGraders,
    })
    if (input.judgeEnabled) {
      graders.push({
        id: RUBRIC_GRADER_ID,
        kind: 'rubric',
        name: 'rubric judge judge-v1',
        required: true,
        config: {},
      })
    }
    const context: GradeContext = {
      case: caseValue,
      answer: chat.text,
      sources,
      usage,
      costUsd,
      latencyMs,
      model: spec.model.id,
    }
    const graderResults = runGraders(graders, context)
    let judgeMeta: JudgeResultMeta | null = null
    if (input.judgeEnabled) {
      const outcome = await judgeAnswer(
        { case: caseValue, answer: chat.text, sources, spec: spec.judge },
        adapters.json
      )
      judgeMeta = outcome.meta
      const index = graderResults.findIndex((result) => result.graderId === RUBRIC_GRADER_ID)
      if (index === -1) {
        graderResults.push(outcome.result)
      } else {
        graderResults[index] = outcome.result
      }
      // Extra graders of judge kinds are aliases of the rubric outcome: the run
      // config asked for them, but one judge call is used and mapped.
      for (const extra of runConfig.extraGraders) {
        if (
          extra.kind !== 'faithfulness' &&
          extra.kind !== 'answer_relevance' &&
          extra.kind !== 'rubric'
        ) {
          continue
        }
        if (extra.id === RUBRIC_GRADER_ID) {
          continue
        }
        if (graderResults.some((result) => result.graderId === extra.id)) {
          const aliasIndex = graderResults.findIndex((result) => result.graderId === extra.id)
          graderResults[aliasIndex] = {
            ...outcome.result,
            graderId: extra.id,
            kind: extra.kind,
            detail: `judge-v1 rubric proxy — ${outcome.result.detail ?? ''}`,
          }
        } else {
          graderResults.push({
            ...outcome.result,
            graderId: extra.id,
            kind: extra.kind,
            detail: `judge-v1 rubric proxy — ${outcome.result.detail ?? ''}`,
          })
        }
      }
    }
    const pass = itemPassed(graders, graderResults)
    const retrieval = resolver.resolveCase(caseValue)
    const gold = retrieval.chunkIds
    const retrievalMetrics =
      caseValue.expected.anchors.length > 0 && gold.length > 0
        ? computeRetrievalMetrics({ retrieved: sources, goldChunkIds: gold })
        : null
    return {
      item: {
        id: newId('item'),
        runId,
        caseId: caseValue.id,
        slices: [...caseValue.slices],
        status: 'ok',
        answer: chat.text,
        usage,
        costUsd,
        latencyMs,
        sources,
        graderResults,
        pass,
        retrieval: retrievalMetrics,
        error: null,
      },
      judgeMeta,
    }
  } catch (error) {
    return {
      item: errorItem({
        runId,
        caseValue,
        error: errorMessage(error),
        latencyMs: Date.now() - startedAt,
      }),
      judgeMeta: null,
    }
  }
}

const skippedItem = (runId: string, caseValue: DatasetCase, reason: string): RunItem => ({
  id: newId('item'),
  runId,
  caseId: caseValue.id,
  slices: [...caseValue.slices],
  status: 'skipped',
  answer: '',
  usage: emptyUsage(),
  costUsd: 0,
  latencyMs: 0,
  sources: [],
  graderResults: [],
  pass: false,
  retrieval: null,
  error: reason,
})

const aggregateJudgeProvenance = (
  judgments: JudgeResultMeta[]
): { provenance: JudgeProvenance; errors: number; attempts: number; evaluated: number } | null => {
  if (judgments.length === 0) {
    return null
  }
  return {
    provenance: judgments[0]?.provenance ?? judgeProvenance({ rubric: 'judge-v1', passScore: 2 }),
    errors: judgments.filter((entry) => entry.error !== null).length,
    attempts: judgments.reduce((sum, entry) => sum + entry.attempts, 0),
    evaluated: judgments.length,
  }
}

/** Execute a queued run to completion. Returns the final run row (never throws after starting). */
export const executeRun = async (runId: string, options: ExecuteRunOptions = {}): Promise<Run> => {
  const db = options.db ?? getDb()
  let row = requireRunRow(runId, db)
  if (row.status !== 'queued') {
    return mapRunRow(row, db)
  }
  const version = getDatasetVersion(row.dataset_version_id, db)
  const cases = readVersionCases(version)
  const profile = getProfile(row.profile_id, db)
  let runConfig = parseRunConfig(row.config_json)
  const adapters = createAdapters({
    ...(options.adapters ?? {}),
    mode: row.mode === 'replay' ? 'replay' : 'live',
  })
  const judgeEnabled = options.judge ?? runConfig.judge
  const concurrency = Math.min(
    64,
    Math.max(1, options.concurrency ?? runConfig.concurrency ?? config.runConcurrency)
  )
  const registry: ActiveRun = { cancelled: false }
  activeRuns.set(runId, registry)
  db.prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?").run(now(), runId)
  const resolver = createAnchorResolver({ db })
  const judgments: JudgeResultMeta[] = []
  const results: (CaseOutcome | null)[] = new Array(cases.length).fill(null)
  let spentUsd = 0
  let abortReason: 'cancelled' | 'budget' | null = null
  const budgetUsd = row.budget_usd
  let cursor = 0
  try {
    const workers = Array.from(
      { length: Math.min(concurrency, Math.max(cases.length, 1)) },
      async () => {
        for (;;) {
          if (abortReason !== null) {
            return
          }
          if (registry.cancelled) {
            abortReason = 'cancelled'
            return
          }
          if (budgetUsd > 0 && spentUsd >= budgetUsd) {
            abortReason = 'budget'
            return
          }
          const index = cursor
          cursor += 1
          const caseValue = cases[index]
          if (!caseValue) {
            return
          }
          const outcome = await evaluateCase({
            runId,
            caseValue,
            profile,
            adapters,
            runConfig,
            resolver,
            judgeEnabled,
          })
          spentUsd += outcome.item.costUsd
          results[index] = outcome
          if (outcome.judgeMeta) {
            judgments.push(outcome.judgeMeta)
          }
          persistRunItem(db, outcome.item)
        }
      }
    )
    await Promise.all(workers)
    for (const [index, outcome] of results.entries()) {
      if (outcome !== null) {
        continue
      }
      const caseValue = cases[index]
      if (!caseValue) {
        continue
      }
      const reason =
        abortReason === 'budget'
          ? `budget cap reached: spent $${spentUsd.toFixed(6)} of $${budgetUsd.toFixed(2)}`
          : abortReason === 'cancelled' || registry.cancelled
            ? 'run cancelled'
            : 'case was not executed'
      const item = skippedItem(runId, caseValue, reason)
      results[index] = { item, judgeMeta: null }
      persistRunItem(db, item)
    }
    const items = results
      .filter((entry): entry is CaseOutcome => entry !== null)
      .map((entry) => entry.item)
    let calibration: JudgeCalibration | null = null
    if (judgeEnabled && (options.judge === true || runConfig.calibration)) {
      try {
        const set = loadCalibrationSet(
          options.calibrationDir ? { dir: options.calibrationDir } : {}
        )
        if (set.items.length > 0) {
          calibration = await runJudgeCalibration({
            items: set.items,
            source: set.path,
            spec: profile.spec.judge,
            json: adapters.json,
          })
        }
      } catch {
        calibration = null
      }
    }
    const warnings: string[] = []
    const unresolvedAnchors = cases
      .map((caseValue) => ({ caseValue, resolution: resolver.resolveCase(caseValue) }))
      .filter(
        (entry) =>
          entry.caseValue.expected.anchors.length > 0 && entry.resolution.chunkIds.length === 0
      )
    if (unresolvedAnchors.length > 0) {
      warnings.push(
        `${unresolvedAnchors.length} case(s) have unresolved gold anchors; retrieval metrics skip them (${unresolvedAnchors
          .slice(0, 5)
          .map((entry) => entry.caseValue.id)
          .join(', ')}${unresolvedAnchors.length > 5 ? ', …' : ''})`
      )
    }
    if (judgments.length > 0) {
      warnings.push(
        `judge calls (${judgments.length} item + calibration) are not included in run cost`
      )
    }
    const summary = summarizeRun({ cases, items, calibration })
    const judgeAggregate = aggregateJudgeProvenance(judgments)
    runConfig = {
      ...runConfig,
      judge: judgeEnabled,
      calibration: calibration !== null,
      judgeMeta: judgeAggregate?.provenance ?? null,
      calibrationMeta: calibration
        ? {
            source: calibration.source,
            items: calibration.items,
            evaluated: calibration.evaluated,
            errors: calibration.errors,
            agreement: calibration.agreement,
            kappa: calibration.kappa,
          }
        : null,
      warnings,
    }
    const current = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as {
      status: string
    }
    const cancelled =
      registry.cancelled || current.status === 'cancelled' || abortReason === 'cancelled'
    const status: RunStatus = cancelled
      ? 'cancelled'
      : abortReason === 'budget'
        ? 'cancelled'
        : 'done'
    const error =
      status === 'cancelled'
        ? abortReason === 'budget'
          ? `budget cap reached: spent $${spentUsd.toFixed(6)} >= budget $${budgetUsd.toFixed(2)}`
          : 'run cancelled by request'
        : null
    db.prepare(
      'UPDATE runs SET status = ?, finished_at = ?, summary_json = ?, error = ?, config_json = ? WHERE id = ?'
    ).run(status, now(), JSON.stringify(summary), error, JSON.stringify(runConfig), runId)
    return getRun(runId, db)
  } catch (error) {
    const message = errorMessage(error)
    db.prepare("UPDATE runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?").run(
      now(),
      message,
      runId
    )
    return getRun(runId, db)
  } finally {
    activeRuns.delete(runId)
  }
}

/** Cancel a queued or running run. Running cases finish; no new cases are scheduled. */
export const cancelRun = (runId: string, options: { db?: Db } = {}): Run => {
  const db = options.db ?? getDb()
  const row = requireRunRow(runId, db)
  if (row.status === 'done' || row.status === 'failed' || row.status === 'cancelled') {
    return mapRunRow(row, db)
  }
  const registry = activeRuns.get(runId)
  if (registry) {
    registry.cancelled = true
  }
  db.prepare(
    "UPDATE runs SET status = 'cancelled', finished_at = ?, error = COALESCE(error, 'run cancelled by request') WHERE id = ?"
  ).run(now(), runId)
  return getRun(runId, db)
}

/* ------------------------------ comparison ------------------------------ */

export type RunComparison = {
  baseline: Run
  candidate: Run
  overall: Comparison
  slices: SliceComparison[]
}

const passRateOf = (items: RunItem[]): number => {
  if (items.length === 0) {
    return 0
  }
  return items.filter((item) => item.pass).length / items.length
}

const metricDelta = (input: {
  baseline: number | null
  candidate: number | null
  percentPoints?: boolean
}): MetricDelta => {
  const { baseline, candidate } = input
  const delta =
    baseline === null || candidate === null
      ? null
      : input.percentPoints === true
        ? (candidate - baseline) * 100
        : candidate - baseline
  const deltaPct =
    baseline === null || candidate === null || baseline === 0
      ? null
      : ((candidate - baseline) / Math.abs(baseline)) * 100
  return { baseline, candidate, delta, deltaPct }
}

/** Paired comparison of two runs on the cases both executed (skipped cases excluded). */
export const compareRuns = (
  baselineRunId: string,
  candidateRunId: string,
  options: { db?: Db; iterations?: number; seed?: number } = {}
): RunComparison => {
  const db = options.db ?? getDb()
  const baseline = getRun(baselineRunId, db)
  const candidate = getRun(candidateRunId, db)
  const baselineItems = getRunItems(baselineRunId, db).filter((item) => item.status !== 'skipped')
  const candidateItems = getRunItems(candidateRunId, db).filter((item) => item.status !== 'skipped')
  const baselineById = new Map(baselineItems.map((item) => [item.caseId, item]))
  const candidateById = new Map(candidateItems.map((item) => [item.caseId, item]))
  const commonIds = [...baselineById.keys()].filter((caseId) => candidateById.has(caseId)).sort()
  const baselineCommon = commonIds.map((caseId) => baselineById.get(caseId) as RunItem)
  const candidateCommon = commonIds.map((caseId) => candidateById.get(caseId) as RunItem)
  const deltas = commonIds.map((caseId) => {
    const before = baselineById.get(caseId) as RunItem
    const after = candidateById.get(caseId) as RunItem
    return ((after.pass ? 1 : 0) - (before.pass ? 1 : 0)) * 100
  })
  const bootstrap = pairedBootstrap(deltas, {
    iterations: options.iterations ?? 10_000,
    seed: options.seed ?? 42,
  })
  const baselinePass = passRateOf(baselineCommon)
  const candidatePass = passRateOf(candidateCommon)
  const passRateDelta = metricDelta({
    baseline: baselinePass,
    candidate: candidatePass,
    percentPoints: true,
  })
  passRateDelta.ciLowPp = bootstrap.ciLow
  passRateDelta.ciHighPp = bootstrap.ciHigh
  passRateDelta.probabilityNotBetter = bootstrap.probabilityNotBetter
  const overall: Comparison = {
    baselineRunId,
    candidateRunId,
    cases: commonIds.length,
    passRate: passRateDelta,
    costPerPassUsd: metricDelta({
      baseline: baseline.summary?.costPerPassUsd ?? null,
      candidate: candidate.summary?.costPerPassUsd ?? null,
    }),
    p95LatencyMs: metricDelta({
      baseline: baseline.summary?.p95LatencyMs ?? null,
      candidate: candidate.summary?.p95LatencyMs ?? null,
    }),
    improved: deltas.filter((delta) => delta > 0).length,
    regressed: deltas.filter((delta) => delta < 0).length,
    unchanged: deltas.filter((delta) => delta === 0).length,
    judgeAgreement: candidate.summary?.judgeAgreement ?? baseline.summary?.judgeAgreement ?? null,
  }
  const sliceNames = new Set<string>()
  for (const item of [...baselineCommon, ...candidateCommon]) {
    for (const slice of item.slices) {
      sliceNames.add(slice)
    }
  }
  const slices: SliceComparison[] = [...sliceNames]
    .sort()
    .map((slice) => {
      const baselineSlice = baselineCommon.filter((item) => item.slices.includes(slice))
      const candidateSlice = candidateCommon.filter((item) => item.slices.includes(slice))
      const baseRate = passRateOf(baselineSlice)
      const candidateRate = passRateOf(candidateSlice)
      return {
        slice,
        cases: Math.min(baselineSlice.length, candidateSlice.length),
        passRate: metricDelta({
          baseline: baseRate,
          candidate: candidateRate,
          percentPoints: true,
        }),
        regressed: candidateRate < baseRate,
      }
    })
    .filter((entry) => entry.cases > 0)
  return { baseline, candidate, overall, slices }
}

/** Pricing basis and off-peak schedule for gate provenance. */
export const runPricingContext = (
  runId: string,
  db: Db = getDb()
): { pricingBasis: string; scheduledAt: number | null } => {
  const run = getRun(runId, db)
  const runConfig = readRunConfig(runId, db)
  return {
    pricingBasis: pricingBasis(run.startedAt ?? run.createdAt),
    scheduledAt: runConfig.scheduledAt,
  }
}
