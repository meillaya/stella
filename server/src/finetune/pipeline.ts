/**
 * Fine-tuning data pipeline: source resolution (dataset version cases + run
 * items), filters (length, PII, refusals, exact/MinHash dedupe, 13-gram
 * contamination), doc-based splits, schema validation, a provenance manifest,
 * and a preflight report that hard-blocks unsafe exports.
 *
 * Stella never claims a tuned model ran. This module produces validated data and
 * a plan; execution is external (see providers.ts).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { config } from '../config.ts'
import { getDb, parseJson, type Db } from '../db/index.ts'
import { newId, now } from '../../../shared/ids.ts'
import { estimateTokens } from '../../../shared/pricing.ts'
import type {
  DatasetCase,
  DatasetVersion,
  FinetuneExport,
  FinetuneExportStats,
  FinetuneFormat,
  RunItem,
} from '../../../shared/types.ts'
import {
  findDatasetRow,
  getDatasetVersion,
  latestDatasetVersion,
  listDraftCases,
  readVersionCases,
} from '../evals/datasets.ts'
import { BusinessError } from '../evals/errors.ts'
import { isRefusal } from '../evals/graders.ts'
import {
  CONTAMINATION_NGRAM_SIZE,
  DEFAULT_SPLIT_RATIOS,
  addPiiCounts,
  assignSplits,
  buildContaminationIndex,
  contentHash,
  findNearDuplicates,
  isContaminated,
  normalizeForDedupe,
  redactPii,
  type PiiCounts,
  type SplitName,
  type SplitRatios,
} from './filters.ts'

/* ------------------------------ config ------------------------------ */

export const FINETUNE_FORMATS: FinetuneFormat[] = ['sft', 'sharegpt', 'dpo']

export type FinetuneFilters = {
  minChars: number
  maxChars: number
  dedupe: boolean
  nearDupeThreshold: number
  redactPii: boolean
  dropRefusals: boolean
  split: SplitRatios
  contamination: 'fail' | 'drop'
  /** Eval suite dataset name for 13-gram contamination; null = auto-detect. */
  evalSuite: string | null
  /** Run ids whose items/annotations may supply answers or DPO rejects. */
  includeRunIds: string[]
  seed: number
}

export const DEFAULT_FINETUNE_FILTERS: FinetuneFilters = {
  minChars: 40,
  maxChars: 12_000,
  dedupe: true,
  nearDupeThreshold: 0.8,
  redactPii: true,
  dropRefusals: true,
  split: { ...DEFAULT_SPLIT_RATIOS },
  contamination: 'fail',
  evalSuite: null,
  includeRunIds: [],
  seed: 42,
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const asNumber = (
  value: unknown,
  fallback: number,
  bounds: { min?: number; max?: number }
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  if (bounds.min !== undefined && value < bounds.min) {
    return fallback
  }
  if (bounds.max !== undefined && value > bounds.max) {
    return fallback
  }
  return value
}

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const asRatio = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback

/** Normalize user filters over the defaults. Unknown fields are ignored. */
export const normalizeFinetuneFilters = (input: unknown): FinetuneFilters => {
  const record = isRecord(input) ? input : {}
  const splitRecord = isRecord(record.split) ? record.split : {}
  const split: SplitRatios = {
    train: asRatio(splitRecord.train, DEFAULT_FINETUNE_FILTERS.split.train),
    val: asRatio(splitRecord.val, DEFAULT_FINETUNE_FILTERS.split.val),
    holdout: asRatio(splitRecord.holdout, DEFAULT_FINETUNE_FILTERS.split.holdout),
  }
  if (split.train + split.val + split.holdout <= 0) {
    split.train = 0.8
  }
  const runIds = Array.isArray(record.includeRunIds)
    ? record.includeRunIds.filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      )
    : DEFAULT_FINETUNE_FILTERS.includeRunIds
  return {
    minChars: Math.floor(asNumber(record.minChars, DEFAULT_FINETUNE_FILTERS.minChars, { min: 0 })),
    maxChars: Math.floor(asNumber(record.maxChars, DEFAULT_FINETUNE_FILTERS.maxChars, { min: 1 })),
    dedupe: asBoolean(record.dedupe, DEFAULT_FINETUNE_FILTERS.dedupe),
    nearDupeThreshold: asNumber(
      record.nearDupeThreshold,
      DEFAULT_FINETUNE_FILTERS.nearDupeThreshold,
      {
        min: 0,
        max: 1,
      }
    ),
    redactPii: asBoolean(record.redactPii, DEFAULT_FINETUNE_FILTERS.redactPii),
    dropRefusals: asBoolean(record.dropRefusals, DEFAULT_FINETUNE_FILTERS.dropRefusals),
    split,
    contamination:
      record.contamination === 'drop' ? 'drop' : DEFAULT_FINETUNE_FILTERS.contamination,
    evalSuite:
      record.evalSuite === null
        ? null
        : typeof record.evalSuite === 'string' && record.evalSuite.trim().length > 0
          ? record.evalSuite.trim()
          : DEFAULT_FINETUNE_FILTERS.evalSuite,
    includeRunIds: runIds,
    seed: Math.floor(asNumber(record.seed, DEFAULT_FINETUNE_FILTERS.seed, { min: 0 })),
  }
}

/* ------------------------------ source resolution ------------------------------ */

export type FinetuneSourceItem = {
  caseId: string
  question: string
  answer: string
  system: string
  slices: string[]
  docKey: string
  source: 'case' | 'run_item' | 'trace'
  sourceTraceId: string | null
  runId: string | null
}

export type FinetuneSource = {
  dataset: { id: string; name: string }
  version: DatasetVersion
  cases: DatasetCase[]
  items: FinetuneSourceItem[]
  /** Failed answers (run items or down-voted traces) keyed by case id, used as DPO rejects. */
  rejects: Map<string, string>
  /** Annotation trace ids used to supply a preferred answer or a DPO reject. */
  annotationTraceIds: string[]
  runIds: string[]
  traceIds: string[]
  unbuildable: number
}

export type SourceInput = {
  datasetVersionId?: string
  datasetName?: string
  runIds?: string[]
}

const questionOf = (input: DatasetCase): string => {
  const messages = input.messages.filter((message) => message.role === 'user')
  const last = messages[messages.length - 1]
  return last ? last.content : ''
}

const systemOf = (input: DatasetCase): string =>
  input.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')

const docKeyOf = (input: DatasetCase): string =>
  input.expected.anchors[0]?.doc ?? `case:${input.id}`

const loadRunItems = (runIds: string[], db: Db): RunItem[] => {
  if (runIds.length === 0) {
    return []
  }
  const placeholders = runIds.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT id, run_id, case_id, status, answer, usage_json, cost_usd, latency_ms, sources_json,
              retrieval_json, grader_results_json, pass, error
       FROM run_items WHERE run_id IN (${placeholders}) ORDER BY rowid ASC`
    )
    .all(...runIds) as {
    id: string
    run_id: string
    case_id: string
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
  }[]
  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    caseId: row.case_id,
    slices: [],
    status: row.status as RunItem['status'],
    answer: row.answer,
    usage: { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 },
    costUsd: row.cost_usd,
    latencyMs: row.latency_ms,
    sources: [],
    graderResults: [],
    pass: row.pass === 1,
    retrieval: null,
    error: row.error,
  }))
}

type TraceRow = {
  id: string
  request_json: string
  response_json: string
  feedback: string | null
  annotation: string | null
  created_at: number
}

const traceQuestion = (request: unknown): string | null => {
  if (!isRecord(request)) {
    return null
  }
  const messages = Array.isArray(request.messages) ? request.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message) || message.role !== 'user') {
      continue
    }
    if (typeof message.content === 'string' && message.content.trim().length > 0) {
      return message.content
    }
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : ''))
        .filter((value) => value.length > 0)
        .join('\n')
      if (text.trim().length > 0) {
        return text
      }
    }
  }
  return null
}

type AnnotationAnswers = {
  approved: Map<string, { answer: string; traceId: string }>
  rejected: Map<string, { answer: string; traceId: string }>
  traceIds: string[]
}

/**
 * Human signal from captured traces: up-voted answers can fill missing SFT
 * targets, down-voted answers can serve as DPO rejects. Annotations are notes,
 * not corrected answers, so only the captured response text is used.
 */
const loadAnnotationAnswers = (db: Db): AnnotationAnswers => {
  const rows = db
    .prepare(
      `SELECT id, request_json, response_json, feedback, annotation, created_at
       FROM traces WHERE feedback IS NOT NULL OR annotation IS NOT NULL
       ORDER BY created_at DESC, id ASC LIMIT 500`
    )
    .all() as TraceRow[]
  const approved = new Map<string, { answer: string; traceId: string }>()
  const rejected = new Map<string, { answer: string; traceId: string }>()
  const traceIds: string[] = []
  for (const row of rows) {
    const question = traceQuestion(parseJson<unknown>(row.request_json, {}))
    const response = parseJson<{ text?: unknown }>(row.response_json, {})
    const answer = typeof response.text === 'string' ? response.text.trim() : ''
    if (!question || answer.length === 0) {
      continue
    }
    const key = normalizeForDedupe(question)
    const entry = { answer, traceId: row.id }
    if (row.feedback === 'up' && !approved.has(key)) {
      approved.set(key, entry)
    } else if (row.feedback === 'down' && !rejected.has(key)) {
      rejected.set(key, entry)
    } else if (row.annotation !== null && row.annotation.trim().length > 0 && !approved.has(key)) {
      approved.set(key, entry)
    }
    traceIds.push(row.id)
  }
  return { approved, rejected, traceIds }
}

/** Resolve the source dataset version (explicit id, dataset name, or error). */
export const resolveSourceVersion = (input: SourceInput, db: Db): DatasetVersion => {
  if (input.datasetVersionId) {
    return getDatasetVersion(input.datasetVersionId, db)
  }
  if (input.datasetName) {
    return latestDatasetVersion(input.datasetName, db)
  }
  throw new BusinessError(
    'datasetVersionId (or datasetName) is required',
    'invalid_finetune_input',
    400
  )
}

export const loadFinetuneSource = (
  input: SourceInput,
  options: { db?: Db } = {}
): FinetuneSource => {
  const db = options.db ?? getDb()
  const version = resolveSourceVersion(input, db)
  const datasetRow = findDatasetRow(version.datasetId, db)
  if (!datasetRow) {
    throw new BusinessError(`dataset not found: ${version.datasetId}`, 'dataset_not_found', 404)
  }
  const cases = readVersionCases(version)
  const runIds = [...new Set(input.runIds ?? [])]
  const runItems = loadRunItems(runIds, db)
  const annotations = loadAnnotationAnswers(db)
  const usedAnnotationTraceIds = new Set<string>()
  const passingAnswers = new Map<string, { answer: string; runId: string }>()
  const rejects = new Map<string, string>()
  for (const item of runItems) {
    if (item.status !== 'ok' || item.answer.trim().length === 0) {
      continue
    }
    if (item.pass) {
      if (!passingAnswers.has(item.caseId)) {
        passingAnswers.set(item.caseId, { answer: item.answer, runId: item.runId })
      }
    } else if (!rejects.has(item.caseId)) {
      rejects.set(item.caseId, item.answer)
    }
  }
  const items: FinetuneSourceItem[] = []
  let unbuildable = 0
  for (const caseValue of cases) {
    const question = questionOf(caseValue)
    if (question.trim().length === 0) {
      unbuildable += 1
      continue
    }
    const caseAnswer = caseValue.expected.answer?.trim() ?? ''
    const fromRun = caseAnswer.length === 0 ? passingAnswers.get(caseValue.id) : undefined
    const fromTrace =
      caseAnswer.length === 0 && !fromRun
        ? annotations.approved.get(normalizeForDedupe(question))
        : undefined
    const answer = caseAnswer.length > 0 ? caseAnswer : (fromRun?.answer ?? fromTrace?.answer ?? '')
    if (answer.trim().length === 0) {
      unbuildable += 1
      continue
    }
    if (fromTrace) {
      usedAnnotationTraceIds.add(fromTrace.traceId)
    }
    const annotationReject = annotations.rejected.get(normalizeForDedupe(question))
    if (annotationReject && !rejects.has(caseValue.id)) {
      rejects.set(caseValue.id, annotationReject.answer)
      usedAnnotationTraceIds.add(annotationReject.traceId)
    }
    items.push({
      caseId: caseValue.id,
      question,
      answer,
      system: systemOf(caseValue),
      slices: [...caseValue.slices],
      docKey: docKeyOf(caseValue),
      source: fromRun ? 'run_item' : fromTrace ? 'trace' : 'case',
      sourceTraceId: caseValue.sourceTraceId ?? fromTrace?.traceId ?? null,
      runId: fromRun?.runId ?? null,
    })
  }
  const traceIds = [
    ...new Set(items.map((item) => item.sourceTraceId).filter((id): id is string => Boolean(id))),
  ]
  return {
    dataset: { id: datasetRow.id, name: datasetRow.name },
    version,
    cases,
    items,
    runIds: [...new Set(items.map((item) => item.runId).filter((id): id is string => Boolean(id)))],
    traceIds,
    rejects,
    annotationTraceIds: [...usedAnnotationTraceIds],
    unbuildable,
  }
}

/* ------------------------------ examples ------------------------------ */

export type FinetuneExample = Record<string, unknown>

export type BuiltExample = {
  caseId: string
  docKey: string
  contentText: string
  example: FinetuneExample
  estimatedTokens: number
  sourceTraceId: string | null
  runId: string | null
}

const renderExample = (
  format: FinetuneFormat,
  item: { question: string; answer: string; system: string; rejected?: string }
): FinetuneExample => {
  if (format === 'sft') {
    const messages: { role: string; content: string }[] = []
    if (item.system.length > 0) {
      messages.push({ role: 'system', content: item.system })
    }
    messages.push({ role: 'user', content: item.question })
    messages.push({ role: 'assistant', content: item.answer })
    return { messages }
  }
  if (format === 'sharegpt') {
    const conversations: { from: string; value: string }[] = []
    if (item.system.length > 0) {
      conversations.push({ from: 'system', value: item.system })
    }
    conversations.push({ from: 'human', value: item.question })
    conversations.push({ from: 'gpt', value: item.answer })
    return { conversations }
  }
  return { prompt: item.question, chosen: item.answer, rejected: item.rejected ?? '' }
}

export type ExampleValidation = { ok: boolean; errors: string[] }

/** Strict shape validation for one exported example. */
export const validateFinetuneExample = (
  format: FinetuneFormat,
  example: unknown
): ExampleValidation => {
  const errors: string[] = []
  if (!isRecord(example)) {
    return { ok: false, errors: ['example must be an object'] }
  }
  const nonEmpty = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0
  if (format === 'sft') {
    if (!Array.isArray(example.messages) || example.messages.length < 2) {
      errors.push('sft example requires a messages array with user and assistant turns')
    } else {
      const roles = example.messages.map((message) =>
        isRecord(message) && typeof message.role === 'string' ? message.role : ''
      )
      if (!roles.includes('user')) {
        errors.push('sft messages must include a user turn')
      }
      if (!roles.includes('assistant')) {
        errors.push('sft messages must include an assistant turn')
      }
      for (const [index, message] of example.messages.entries()) {
        if (!isRecord(message) || !nonEmpty(message.content)) {
          errors.push(`sft messages[${index}].content must be non-empty`)
        }
      }
    }
  } else if (format === 'sharegpt') {
    if (!Array.isArray(example.conversations) || example.conversations.length < 2) {
      errors.push('sharegpt example requires a conversations array with human and gpt turns')
    } else {
      const froms = example.conversations.map((entry) =>
        isRecord(entry) && typeof entry.from === 'string' ? entry.from : ''
      )
      if (!froms.includes('human')) {
        errors.push('sharegpt conversations must include a human turn')
      }
      if (!froms.includes('gpt')) {
        errors.push('sharegpt conversations must include a gpt turn')
      }
      for (const [index, entry] of example.conversations.entries()) {
        if (!isRecord(entry) || !nonEmpty(entry.value)) {
          errors.push(`sharegpt conversations[${index}].value must be non-empty`)
        }
      }
    }
  } else {
    if (!nonEmpty(example.prompt)) {
      errors.push('dpo example requires a non-empty prompt')
    }
    if (!nonEmpty(example.chosen)) {
      errors.push('dpo example requires a non-empty chosen answer')
    }
    if (!nonEmpty(example.rejected)) {
      errors.push('dpo example requires a non-empty rejected answer')
    }
    if (
      nonEmpty(example.chosen) &&
      nonEmpty(example.rejected) &&
      example.chosen === example.rejected
    ) {
      errors.push('dpo chosen and rejected must differ')
    }
  }
  return { ok: errors.length === 0, errors }
}

/* ------------------------------ checks / report ------------------------------ */

export type FinetuneCheck = { id: string; ok: boolean; level: 'error' | 'warning'; message: string }

export type ContaminationReport = {
  suite: string | null
  checked: boolean
  self: boolean
  ngramSize: number
  examples: number
  policy: 'fail' | 'drop'
  indexSize: number
}

export type FinetuneManifest = {
  version: 1
  exportId: string
  createdAt: number
  format: FinetuneFormat
  dataset: { id: string; name: string; version: number; versionId: string; contentHash: string }
  filters: FinetuneFilters
  counts: FinetuneExportStats
  splits: Record<SplitName, { examples: number; path: string; contentHash: string }>
  provenance: {
    caseIds: string[]
    runIds: string[]
    traceIds: string[]
    datasetContentHash: string
    generator: string
    unbuildableCases: number
  }
  contamination: ContaminationReport
  pii: { redactions: number; byType: PiiCounts }
  dedupe: { exact: number; near: number; threshold: number }
  schemaChecks: string[]
  notes: string[]
}

export type FinetunePreflightReport = {
  ok: boolean
  format: FinetuneFormat
  dataset: { id: string; name: string; version: number; versionId: string }
  stats: FinetuneExportStats
  checks: FinetuneCheck[]
  failures: string[]
  warnings: string[]
  splits: Record<SplitName, BuiltExample[]>
  contamination: ContaminationReport
  pii: { redactions: number; byType: PiiCounts }
  dedupe: { exact: number; near: number; threshold: number }
  manifest: FinetuneManifest
}

export type BuildInput = SourceInput & { format: FinetuneFormat; filters?: unknown }

export type BuildOptions = { db?: Db }

const splitNames: SplitName[] = ['train', 'val', 'holdout']

const loadContaminationSuite = (
  filters: FinetuneFilters,
  source: FinetuneSource,
  db: Db
): {
  index: Set<string>
  suite: string | null
  self: boolean
  checked: boolean
  note: string | null
} => {
  const requested = filters.evalSuite
  const suiteName = requested ?? 'support'
  const suiteRow = findDatasetRow(suiteName, db)
  if (!suiteRow) {
    if (requested) {
      return {
        index: new Set(),
        suite: requested,
        self: false,
        checked: false,
        note: `eval suite "${requested}" was not found`,
      }
    }
    return {
      index: new Set(),
      suite: null,
      self: false,
      checked: false,
      note: 'no eval suite dataset found; contamination check skipped',
    }
  }
  if (suiteRow.id === source.dataset.id) {
    return {
      index: new Set(),
      suite: suiteName,
      self: true,
      checked: false,
      note: `export source is the eval suite itself (${suiteName}); 13-gram self-overlap is recorded as a warning, not a block`,
    }
  }
  let suiteCases: DatasetCase[] = []
  try {
    const version = latestDatasetVersion(suiteRow.id, db)
    suiteCases = readVersionCases(version)
  } catch {
    suiteCases = listDraftCases(suiteRow.id, db)
  }
  const texts = suiteCases.flatMap((caseValue) => [
    questionOf(caseValue),
    caseValue.expected.answer ?? '',
    ...caseValue.expected.mustContain,
  ])
  const index = buildContaminationIndex(texts)
  return { index, suite: suiteName, self: false, checked: true, note: null }
}

const serializeSplit = (examples: BuiltExample[]): string =>
  examples.length === 0
    ? ''
    : `${examples.map((entry) => JSON.stringify(entry.example)).join('\n')}\n`

export type BuildResult = FinetunePreflightReport & {
  examplesBySplit: Record<SplitName, BuiltExample[]>
  splitContents: Record<SplitName, string>
  splitHashes: Record<SplitName, string>
}

/** Run the whole pipeline in memory (no files written) and return a report. */
export const buildFinetuneDataset = (
  input: BuildInput,
  options: BuildOptions = {}
): BuildResult => {
  const db = options.db ?? getDb()
  if (!FINETUNE_FORMATS.includes(input.format)) {
    throw new BusinessError(
      `format must be one of ${FINETUNE_FORMATS.join(', ')}`,
      'invalid_finetune_format',
      400
    )
  }
  const format = input.format
  const filters = normalizeFinetuneFilters(input.filters)
  const source = loadFinetuneSource(
    {
      ...(input.datasetVersionId !== undefined ? { datasetVersionId: input.datasetVersionId } : {}),
      ...(input.datasetName !== undefined ? { datasetName: input.datasetName } : {}),
      runIds: filters.includeRunIds,
    },
    { db }
  )
  if (format === 'dpo' && source.rejects.size === 0) {
    // DPO needs rejects; run-level failures are the only honest source we have.
    // Report this as a schema/filter outcome rather than fabricating rejects.
  }
  const suite = loadContaminationSuite(filters, source, db)
  const checks: FinetuneCheck[] = []
  const warnings: string[] = []
  const failures: string[] = []
  const piiTotals: PiiCounts = { email: 0, phone: 0, card: 0, ip: 0, apiKey: 0 }
  let piiRedactions = 0
  let dropped = source.unbuildable
  let refusalDrops = 0
  let lengthDrops = 0
  let missingRejectDrops = 0
  let contaminatedCount = 0
  let exactDuplicates = 0
  let nearDuplicates = 0
  const built: BuiltExample[] = []
  const seenExact = new Map<string, number>()
  const docKeys: string[] = []

  const redact = (text: string): string => {
    if (!filters.redactPii) {
      // Still detect so preflight can hard-block unredacted PII.
      const detected = redactPii(text)
      if (detected.total > 0) {
        addPiiCounts(piiTotals, detected.counts)
        piiRedactions += detected.total
      }
      return text
    }
    const redacted = redactPii(text)
    addPiiCounts(piiTotals, redacted.counts)
    piiRedactions += redacted.total
    return redacted.text
  }

  for (const item of source.items) {
    const totalChars = item.question.length + item.answer.length + item.system.length
    if (totalChars < filters.minChars || totalChars > filters.maxChars) {
      dropped += 1
      lengthDrops += 1
      continue
    }
    if (filters.dropRefusals && isRefusal(item.answer)) {
      dropped += 1
      refusalDrops += 1
      continue
    }
    const rejected = format === 'dpo' ? (source.rejects.get(item.caseId) ?? '') : ''
    if (format === 'dpo' && rejected.trim().length === 0) {
      dropped += 1
      missingRejectDrops += 1
      continue
    }
    const question = redact(item.question)
    const system = redact(item.system)
    const answer = redact(item.answer)
    const rejectedText = format === 'dpo' ? redact(rejected) : ''
    const example = renderExample(format, {
      question,
      answer,
      system,
      ...(format === 'dpo' ? { rejected: rejectedText } : {}),
    })
    const validation = validateFinetuneExample(format, example)
    if (!validation.ok) {
      dropped += 1
      continue
    }
    const contentText = `${question}\n${answer}`
    if (filters.dedupe) {
      const exactKey = contentHash(normalizeForDedupe(`${system}\n${contentText}`))
      if (seenExact.has(exactKey)) {
        exactDuplicates += 1
        continue
      }
      seenExact.set(exactKey, built.length)
    }
    if (suite.checked && suite.index.size > 0 && isContaminated(contentText, suite.index)) {
      if (filters.contamination === 'drop') {
        contaminatedCount += 1
        continue
      }
      contaminatedCount += 1
    }
    built.push({
      caseId: item.caseId,
      docKey: item.docKey,
      contentText,
      example,
      estimatedTokens: estimateTokens(JSON.stringify(example)),
      sourceTraceId: item.sourceTraceId,
      runId: item.runId,
    })
    docKeys.push(item.docKey)
  }

  if (filters.dedupe && built.length > 1) {
    const near = findNearDuplicates(
      built.map((entry) => entry.contentText),
      filters.nearDupeThreshold
    )
    const dropIndexes = new Set<number>()
    for (const pair of near.pairs) {
      if (dropIndexes.has(pair.left) || dropIndexes.has(pair.right)) {
        continue
      }
      dropIndexes.add(pair.right)
    }
    if (dropIndexes.size > 0) {
      nearDuplicates = dropIndexes.size
      for (let index = built.length - 1; index >= 0; index -= 1) {
        if (dropIndexes.has(index)) {
          built.splice(index, 1)
          docKeys.splice(index, 1)
        }
      }
    }
  }

  const splitAssignment = assignSplits(docKeys, filters.split)
  const examplesBySplit: Record<SplitName, BuiltExample[]> = { train: [], val: [], holdout: [] }
  for (const [index, entry] of built.entries()) {
    const split = splitAssignment[index] ?? 'train'
    examplesBySplit[split].push(entry)
  }

  // --- checks ---
  const schemaNotes: string[] = []
  let schemaErrors = 0
  for (const split of splitNames) {
    for (const entry of examplesBySplit[split]) {
      const validation = validateFinetuneExample(format, entry.example)
      if (!validation.ok) {
        schemaErrors += 1
        schemaNotes.push(...validation.errors.slice(0, 2))
      }
    }
  }
  if (schemaErrors > 0) {
    checks.push({
      id: 'schema',
      ok: false,
      level: 'error',
      message: `${schemaErrors} example(s) failed ${format} schema validation: ${schemaNotes.slice(0, 3).join('; ')}`,
    })
    failures.push('format schema validation failed')
  } else {
    checks.push({
      id: 'schema',
      ok: true,
      level: 'error',
      message: `all examples match the ${format} schema`,
    })
  }

  if (
    piiTotals.email + piiTotals.phone + piiTotals.card + piiTotals.ip + piiTotals.apiKey > 0 &&
    !filters.redactPii
  ) {
    checks.push({
      id: 'pii',
      ok: false,
      level: 'error',
      message: `PII/secrets detected but redaction is disabled (${piiRedactions} match(es))`,
    })
    failures.push('PII detected without redaction')
  } else {
    checks.push({
      id: 'pii',
      ok: true,
      level: 'error',
      message: filters.redactPii
        ? `redacted ${piiRedactions} PII/secret match(es)`
        : 'PII redaction disabled by filter',
    })
  }

  const totalExamples = built.length
  if (totalExamples === 0) {
    checks.push({
      id: 'examples',
      ok: false,
      level: 'error',
      message: 'no usable examples after filters',
    })
    failures.push('no usable examples after filters')
  } else {
    checks.push({
      id: 'examples',
      ok: true,
      level: 'error',
      message: `${totalExamples} examples built`,
    })
  }

  const splitIntegrityProblems: string[] = []
  const docSplits = new Map<string, SplitName>()
  for (const split of splitNames) {
    for (const entry of examplesBySplit[split]) {
      const existing = docSplits.get(entry.docKey)
      if (existing && existing !== split) {
        splitIntegrityProblems.push(`doc ${entry.docKey} appears in ${existing} and ${split}`)
      }
      docSplits.set(entry.docKey, split)
    }
  }
  if (totalExamples >= 10) {
    for (const split of splitNames) {
      if (examplesBySplit[split].length === 0 && filters.split[split] > 0) {
        splitIntegrityProblems.push(`${split} split is empty`)
      }
    }
  } else if (totalExamples > 0) {
    for (const split of splitNames) {
      if (examplesBySplit[split].length === 0 && filters.split[split] > 0) {
        warnings.push(
          `${split} split is empty because the dataset is small (${totalExamples} examples)`
        )
      }
    }
  }
  if (splitIntegrityProblems.length > 0) {
    checks.push({
      id: 'splits',
      ok: false,
      level: 'error',
      message: splitIntegrityProblems.join('; '),
    })
    failures.push('split integrity failed')
  } else {
    checks.push({
      id: 'splits',
      ok: true,
      level: 'error',
      message: `doc-based split: train ${examplesBySplit.train.length}, val ${examplesBySplit.val.length}, holdout ${examplesBySplit.holdout.length}`,
    })
  }

  if (!suite.checked) {
    if (suite.suite !== null && suite.note !== null) {
      checks.push({ id: 'contamination', ok: false, level: 'warning', message: suite.note })
      warnings.push(suite.note)
    } else if (suite.self) {
      const message = suite.note ?? 'contamination self-check recorded as a warning'
      checks.push({ id: 'contamination', ok: true, level: 'warning', message })
      warnings.push(message)
    } else {
      checks.push({
        id: 'contamination',
        ok: true,
        level: 'warning',
        message: suite.note ?? 'contamination check skipped',
      })
      if (suite.note) {
        warnings.push(suite.note)
      }
    }
  } else if (contaminatedCount > 0 && filters.contamination === 'fail') {
    checks.push({
      id: 'contamination',
      ok: false,
      level: 'error',
      message: `${contaminatedCount} example(s) share a ${CONTAMINATION_NGRAM_SIZE}-gram with eval suite "${suite.suite}"`,
    })
    failures.push('eval-set contamination detected')
  } else if (contaminatedCount > 0) {
    checks.push({
      id: 'contamination',
      ok: true,
      level: 'warning',
      message: `dropped ${contaminatedCount} contaminated example(s) from eval suite "${suite.suite}"`,
    })
    warnings.push(`${contaminatedCount} example(s) dropped for eval-set contamination`)
  } else {
    checks.push({
      id: 'contamination',
      ok: true,
      level: 'error',
      message: `no ${CONTAMINATION_NGRAM_SIZE}-gram overlap with eval suite "${suite.suite}"`,
    })
  }

  const stats: FinetuneExportStats = {
    examples: built.length,
    dropped,
    duplicates: exactDuplicates + nearDuplicates,
    piiRedactions,
    train: examplesBySplit.train.length,
    val: examplesBySplit.val.length,
    holdout: examplesBySplit.holdout.length,
    contamination: contaminatedCount,
    estimatedTokens: built.reduce((sum, entry) => sum + entry.estimatedTokens, 0),
  }
  const splitContents = {
    train: serializeSplit(examplesBySplit.train),
    val: serializeSplit(examplesBySplit.val),
    holdout: serializeSplit(examplesBySplit.holdout),
  }
  const splitHashes = {
    train: contentHash(splitContents.train),
    val: contentHash(splitContents.val),
    holdout: contentHash(splitContents.holdout),
  }
  const provenances = {
    caseIds: [...new Set(built.map((entry) => entry.caseId))],
    runIds: [
      ...new Set(built.map((entry) => entry.runId).filter((id): id is string => Boolean(id))),
    ],
    traceIds: [
      ...new Set([
        ...built.map((entry) => entry.sourceTraceId).filter((id): id is string => Boolean(id)),
        ...source.annotationTraceIds,
      ]),
    ],
    datasetContentHash: source.version.contentHash,
    generator: `stella ${config.version} fine-tune pipeline`,
    unbuildableCases: source.unbuildable,
  }
  const contamination: ContaminationReport = {
    suite: suite.suite,
    checked: suite.checked,
    self: suite.self,
    ngramSize: CONTAMINATION_NGRAM_SIZE,
    examples: contaminatedCount,
    policy: filters.contamination,
    indexSize: suite.index.size,
  }
  const manifest: FinetuneManifest = {
    version: 1,
    exportId: '',
    createdAt: now(),
    format,
    dataset: {
      id: source.dataset.id,
      name: source.dataset.name,
      version: source.version.version,
      versionId: source.version.id,
      contentHash: source.version.contentHash,
    },
    filters,
    counts: stats,
    splits: {
      train: {
        examples: examplesBySplit.train.length,
        path: `${format}-train.jsonl`,
        contentHash: splitHashes.train,
      },
      val: {
        examples: examplesBySplit.val.length,
        path: `${format}-val.jsonl`,
        contentHash: splitHashes.val,
      },
      holdout: {
        examples: examplesBySplit.holdout.length,
        path: `${format}-holdout.jsonl`,
        contentHash: splitHashes.holdout,
      },
    },
    provenance: provenances,
    contamination,
    pii: { redactions: piiRedactions, byType: piiTotals },
    dedupe: { exact: exactDuplicates, near: nearDuplicates, threshold: filters.nearDupeThreshold },
    schemaChecks: [
      `format:${format}`,
      'non-empty content',
      format === 'dpo' ? 'chosen differs from rejected' : 'user+assistant turns',
    ],
    notes: [
      'DeepSeek does not offer a fine-tuning endpoint; this dataset is for external training (Unsloth, Axolotl, Together or an OpenAI-compatible endpoint).',
      ...warnings,
    ],
  }
  if (lengthDrops > 0) {
    manifest.notes.push(`${lengthDrops} example(s) dropped by the length filter`)
  }
  if (refusalDrops > 0) {
    manifest.notes.push(`${refusalDrops} refusal-only example(s) removed`)
  }
  if (missingRejectDrops > 0) {
    manifest.notes.push(
      `${missingRejectDrops} DPO pair(s) skipped for lack of a rejected answer (pass includeRunIds with a failed run)`
    )
  }
  const ok = failures.length === 0
  return {
    ok,
    format,
    dataset: {
      id: source.dataset.id,
      name: source.dataset.name,
      version: source.version.version,
      versionId: source.version.id,
    },
    stats,
    checks,
    failures,
    warnings,
    splits: examplesBySplit,
    contamination,
    pii: { redactions: piiRedactions, byType: piiTotals },
    dedupe: { exact: exactDuplicates, near: nearDuplicates, threshold: filters.nearDupeThreshold },
    manifest,
    examplesBySplit,
    splitContents,
    splitHashes,
  }
}

/** Preflight only: build in memory, write nothing, hard-block on error checks. */
export const preflightFinetune = (
  input: BuildInput,
  options: BuildOptions = {}
): FinetunePreflightReport => {
  const {
    examplesBySplit: _examples,
    splitContents: _contents,
    splitHashes: _hashes,
    ...report
  } = buildFinetuneDataset(input, options)
  void _examples
  void _contents
  void _hashes
  return report
}

/* ------------------------------ export persistence ------------------------------ */

type ExportRow = {
  id: string
  dataset_id: string
  dataset_version_id: string
  format: string
  path: string
  manifest_path: string
  stats_json: string
  filters_json: string
  created_at: number
}

export const mapFinetuneExportRow = (row: ExportRow, db: Db): FinetuneExport => {
  const dataset = db.prepare('SELECT name FROM datasets WHERE id = ?').get(row.dataset_id) as
    | { name: string }
    | undefined
  const version = db
    .prepare('SELECT version FROM dataset_versions WHERE id = ?')
    .get(row.dataset_version_id) as { version: number } | undefined
  return {
    id: row.id,
    datasetId: row.dataset_id,
    datasetName: dataset?.name ?? 'unknown',
    datasetVersion: version?.version ?? 0,
    format: row.format as FinetuneFormat,
    path: row.path,
    manifestPath: row.manifest_path,
    stats: parseJson<FinetuneExportStats>(row.stats_json, {
      examples: 0,
      dropped: 0,
      duplicates: 0,
      piiRedactions: 0,
      train: 0,
      val: 0,
      holdout: 0,
      contamination: 0,
      estimatedTokens: 0,
    }),
    createdAt: row.created_at,
  }
}

export type ExportFinetuneInput = BuildInput
export type ExportFinetuneOptions = BuildOptions & { dataDir?: string }

export type ExportFinetuneResult = {
  export: FinetuneExport
  manifest: FinetuneManifest
  report: FinetunePreflightReport
  files: Record<SplitName, string>
}

/** Build, validate, and write a fine-tuning export. Hard-blocks on preflight failures. */
export const exportFinetune = (
  input: ExportFinetuneInput,
  options: ExportFinetuneOptions = {}
): ExportFinetuneResult => {
  const db = options.db ?? getDb()
  const dataDir = options.dataDir ?? config.dataDir
  const built = buildFinetuneDataset(input, { db })
  if (!built.ok) {
    throw new BusinessError(
      `fine-tune preflight failed: ${built.failures.join('; ')}`,
      'finetune_preflight_failed',
      422
    )
  }
  const exportId = newId('ft')
  const directory = path.join(dataDir, 'finetune', exportId)
  mkdirSync(directory, { recursive: true })
  const files: Record<SplitName, string> = {
    train: path.join(directory, `${built.format}-train.jsonl`),
    val: path.join(directory, `${built.format}-val.jsonl`),
    holdout: path.join(directory, `${built.format}-holdout.jsonl`),
  }
  writeFileSync(files.train, built.splitContents.train, 'utf8')
  writeFileSync(files.val, built.splitContents.val, 'utf8')
  writeFileSync(files.holdout, built.splitContents.holdout, 'utf8')
  const manifest: FinetuneManifest = { ...built.manifest, exportId, createdAt: now() }
  const manifestPath = path.join(directory, 'manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const createdAt = now()
  db.prepare(
    `INSERT INTO finetune_exports(id, dataset_id, dataset_version_id, format, path, manifest_path, stats_json, filters_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    exportId,
    built.dataset.id,
    built.dataset.versionId,
    built.format,
    directory,
    manifestPath,
    JSON.stringify(built.stats),
    JSON.stringify(built.manifest.filters),
    createdAt
  )
  const exportRow: FinetuneExport = {
    id: exportId,
    datasetId: built.dataset.id,
    datasetName: built.dataset.name,
    datasetVersion: built.dataset.version,
    format: built.format,
    path: directory,
    manifestPath,
    stats: built.stats,
    createdAt,
  }
  return {
    export: exportRow,
    manifest,
    report: {
      ok: built.ok,
      format: built.format,
      dataset: built.dataset,
      stats: built.stats,
      checks: built.checks,
      failures: built.failures,
      warnings: built.warnings,
      splits: built.splits,
      contamination: built.contamination,
      pii: built.pii,
      dedupe: built.dedupe,
      manifest,
    },
    files,
  }
}

export const listFinetuneExports = (
  options: { limit?: number } = {},
  db: Db = getDb()
): FinetuneExport[] => {
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)))
  const rows = db
    .prepare('SELECT * FROM finetune_exports ORDER BY created_at DESC, id ASC LIMIT ?')
    .all(limit) as ExportRow[]
  return rows.map((row) => mapFinetuneExportRow(row, db))
}

export const getFinetuneExport = (exportId: string, db: Db = getDb()): FinetuneExport => {
  const row = db.prepare('SELECT * FROM finetune_exports WHERE id = ?').get(exportId) as
    | ExportRow
    | undefined
  if (!row) {
    throw new BusinessError(`fine-tune export not found: ${exportId}`, 'export_not_found', 404)
  }
  return mapFinetuneExportRow(row, db)
}

/** Read the manifest written next to an export. */
export const readExportManifest = (
  input: FinetuneExport | string,
  db: Db = getDb()
): FinetuneManifest => {
  const exportValue = typeof input === 'string' ? getFinetuneExport(input, db) : input
  if (!existsSync(exportValue.manifestPath)) {
    throw new BusinessError(
      `export manifest missing: ${exportValue.manifestPath}`,
      'manifest_missing',
      500
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(exportValue.manifestPath, 'utf8'))
  } catch {
    throw new BusinessError(
      `export manifest is corrupt: ${exportValue.manifestPath}`,
      'corrupt_manifest',
      500
    )
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    throw new BusinessError(
      `export manifest is corrupt: ${exportValue.manifestPath}`,
      'corrupt_manifest',
      500
    )
  }
  return parsed as unknown as FinetuneManifest
}

/** Read one split file (used by tests and the CLI). */
export const readExportSplit = (input: FinetuneExport, split: SplitName): string => {
  const file = path.join(input.path, `${input.format}-${split}.jsonl`)
  if (!existsSync(file)) {
    throw new BusinessError(`export split missing: ${file}`, 'split_missing', 500)
  }
  return readFileSync(file, 'utf8')
}
