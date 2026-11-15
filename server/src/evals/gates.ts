/**
 * Release gates: load/normalize `stella.gate.json`, evaluate a baseline run vs a
 * candidate run against thresholds + regression rules + judge trust rules, then
 * write reproducible artifacts: `gate.md`, `gate.json` and a self-contained
 * `review.html` (inline CSS, no external assets) for PM review.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { config } from '../config.ts'
import { getDb, parseJson, type Db } from '../db/index.ts'
import { newId, now } from '../../../shared/ids.ts'
import { formatPp, formatPercent, wilsonInterval } from '../../../shared/metrics.ts'
import { formatUsd } from '../../../shared/pricing.ts'
import type {
  DatasetCase,
  Gate,
  GateConfig,
  GateFailure,
  GateJudgeRules,
  GateRegressionRules,
  GateResult,
  GateThresholds,
  GraderResult,
  RetrievalMetrics,
  Run,
  RunItem,
  SliceComparison,
} from '../../../shared/types.ts'
import { errorMessage, BusinessError, UsageError } from './errors.ts'
import { getDatasetVersion, readVersionCases } from './datasets.ts'
import { getProfile } from './profiles.ts'
import { getRun, getRunItems, readRunConfig } from './runner.ts'

/* ------------------------------ config ------------------------------ */

export const GATE_CONFIG_FILENAME = 'stella.gate.json'

export const DEFAULT_GATE_CONFIG: GateConfig = {
  suite: 'support',
  minCases: 20,
  thresholds: {
    passRate: 0.8,
    faithfulness: 0.7,
    citationValidity: 0.9,
    refusalAccuracy: 0.8,
    maxCostPerCaseUsd: 0.02,
    maxP95LatencyMs: 20_000,
  },
  regression: { overallMaxDropPp: 2, sliceMaxDropPp: 10, minSliceCases: 3 },
  judge: { requireCalibration: false, minAgreement: 0.6, maxGraderErrorsPct: 5 },
  overrides: { allowed: true, requireReason: true },
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const num = (
  value: unknown,
  fallback: number,
  field: string,
  issues: string[],
  bounds: { min?: number; max?: number } = {}
): number => {
  if (value === undefined || value === null) {
    return fallback
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(`${field} must be a number`)
    return fallback
  }
  if (bounds.min !== undefined && value < bounds.min) {
    issues.push(`${field} must be >= ${bounds.min}`)
    return fallback
  }
  if (bounds.max !== undefined && value > bounds.max) {
    issues.push(`${field} must be <= ${bounds.max}`)
    return fallback
  }
  return value
}

const integer = (
  value: unknown,
  fallback: number,
  field: string,
  issues: string[],
  bounds: { min?: number; max?: number } = {}
): number => {
  const parsed = num(value, fallback, field, issues, bounds)
  if (!Number.isInteger(parsed)) {
    issues.push(`${field} must be an integer`)
    return fallback
  }
  return parsed
}

const bool = (value: unknown, fallback: boolean, field: string, issues: string[]): boolean => {
  if (value === undefined || value === null) {
    return fallback
  }
  if (typeof value !== 'boolean') {
    issues.push(`${field} must be a boolean`)
    return fallback
  }
  return value
}

const normalizeThresholds = (input: unknown, issues: string[]): GateThresholds => {
  const record = isRecord(input) ? input : {}
  if (input !== undefined && !isRecord(input)) {
    issues.push('thresholds must be an object')
  }
  return {
    passRate: num(
      record.passRate,
      DEFAULT_GATE_CONFIG.thresholds.passRate,
      'thresholds.passRate',
      issues,
      {
        min: 0,
        max: 1,
      }
    ),
    faithfulness: num(
      record.faithfulness,
      DEFAULT_GATE_CONFIG.thresholds.faithfulness,
      'thresholds.faithfulness',
      issues,
      { min: 0, max: 1 }
    ),
    citationValidity: num(
      record.citationValidity,
      DEFAULT_GATE_CONFIG.thresholds.citationValidity,
      'thresholds.citationValidity',
      issues,
      { min: 0, max: 1 }
    ),
    refusalAccuracy: num(
      record.refusalAccuracy,
      DEFAULT_GATE_CONFIG.thresholds.refusalAccuracy,
      'thresholds.refusalAccuracy',
      issues,
      { min: 0, max: 1 }
    ),
    maxCostPerCaseUsd: num(
      record.maxCostPerCaseUsd,
      DEFAULT_GATE_CONFIG.thresholds.maxCostPerCaseUsd,
      'thresholds.maxCostPerCaseUsd',
      issues,
      { min: 0 }
    ),
    maxP95LatencyMs: num(
      record.maxP95LatencyMs,
      DEFAULT_GATE_CONFIG.thresholds.maxP95LatencyMs,
      'thresholds.maxP95LatencyMs',
      issues,
      { min: 1 }
    ),
  }
}

const normalizeRegression = (input: unknown, issues: string[]): GateRegressionRules => {
  const record = isRecord(input) ? input : {}
  if (input !== undefined && !isRecord(input)) {
    issues.push('regression must be an object')
  }
  return {
    overallMaxDropPp: num(
      record.overallMaxDropPp,
      DEFAULT_GATE_CONFIG.regression.overallMaxDropPp,
      'regression.overallMaxDropPp',
      issues,
      { min: 0 }
    ),
    sliceMaxDropPp: num(
      record.sliceMaxDropPp,
      DEFAULT_GATE_CONFIG.regression.sliceMaxDropPp,
      'regression.sliceMaxDropPp',
      issues,
      { min: 0 }
    ),
    minSliceCases: integer(
      record.minSliceCases,
      DEFAULT_GATE_CONFIG.regression.minSliceCases,
      'regression.minSliceCases',
      issues,
      { min: 1 }
    ),
  }
}

const normalizeJudge = (input: unknown, issues: string[]): GateJudgeRules => {
  const record = isRecord(input) ? input : {}
  if (input !== undefined && !isRecord(input)) {
    issues.push('judge must be an object')
  }
  return {
    requireCalibration: bool(
      record.requireCalibration,
      DEFAULT_GATE_CONFIG.judge.requireCalibration,
      'judge.requireCalibration',
      issues
    ),
    minAgreement: num(
      record.minAgreement,
      DEFAULT_GATE_CONFIG.judge.minAgreement,
      'judge.minAgreement',
      issues,
      {
        min: 0,
        max: 1,
      }
    ),
    maxGraderErrorsPct: num(
      record.maxGraderErrorsPct,
      DEFAULT_GATE_CONFIG.judge.maxGraderErrorsPct,
      'judge.maxGraderErrorsPct',
      issues,
      { min: 0, max: 100 }
    ),
  }
}

/** Normalize a user-provided gate config over defaults. Throws UsageError on invalid input. */
export const normalizeGateConfig = (input: unknown): GateConfig => {
  if (!isRecord(input)) {
    throw new UsageError('gate config must be a JSON object')
  }
  const issues: string[] = []
  const suite =
    input.suite === undefined
      ? DEFAULT_GATE_CONFIG.suite
      : typeof input.suite === 'string' && input.suite.trim().length > 0
        ? input.suite.trim()
        : (() => {
            issues.push('suite must be a non-empty string')
            return DEFAULT_GATE_CONFIG.suite
          })()
  const overrides = isRecord(input.overrides) ? input.overrides : {}
  if (input.overrides !== undefined && !isRecord(input.overrides)) {
    issues.push('overrides must be an object')
  }
  const config: GateConfig = {
    suite,
    minCases: integer(input.minCases, DEFAULT_GATE_CONFIG.minCases, 'minCases', issues, { min: 1 }),
    thresholds: normalizeThresholds(input.thresholds, issues),
    regression: normalizeRegression(input.regression, issues),
    judge: normalizeJudge(input.judge, issues),
    overrides: {
      allowed: bool(
        overrides.allowed,
        DEFAULT_GATE_CONFIG.overrides.allowed,
        'overrides.allowed',
        issues
      ),
      requireReason: bool(
        overrides.requireReason,
        DEFAULT_GATE_CONFIG.overrides.requireReason,
        'overrides.requireReason',
        issues
      ),
    },
  }
  if (issues.length > 0) {
    throw new UsageError(`invalid gate config: ${issues.join('; ')}`)
  }
  return config
}

export const gateConfigHash = (configValue: GateConfig): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(configValue)).digest('hex')}`

export type LoadedGateConfig = { config: GateConfig; path: string | null; hash: string }

/** Load `stella.gate.json` from the repo root (or an explicit path); defaults when absent. */
export const loadGateConfig = (
  options: { file?: string; root?: string } = {}
): LoadedGateConfig => {
  const root = options.root ?? config.root
  const file = options.file ? path.resolve(options.file) : path.join(root, GATE_CONFIG_FILENAME)
  let raw: unknown = {}
  let loadedPath: string | null = null
  if (options.file) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      throw new UsageError(`gate config not found: ${file}`)
    }
    loadedPath = file
    try {
      raw = JSON.parse(text)
    } catch (error) {
      throw new UsageError(`gate config is not valid JSON (${file}): ${errorMessage(error)}`)
    }
  } else if (existsSync(file)) {
    loadedPath = file
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      throw new UsageError(`gate config is not valid JSON (${file}): ${errorMessage(error)}`)
    }
  }
  const gateConfig = normalizeGateConfig(raw)
  return { config: gateConfig, path: loadedPath, hash: gateConfigHash(gateConfig) }
}

/* ------------------------------ metrics ------------------------------ */

export type GateRunMetrics = {
  runId: string
  status: Run['status']
  cases: number
  pass: number
  passRate: number
  ciLow: number
  ciHigh: number
  costUsd: number
  costPerCaseUsd: number
  costPerPassUsd: number | null
  p50LatencyMs: number
  p95LatencyMs: number
  skipped: number
  graderErrors: number
  graderErrorRate: number
  judgeAgreement: number | null
  judgeKappa: number | null
  judgeErrors: number
  faithfulness: number | null
  citationValidity: number | null
  refusalAccuracy: number | null
  retrieval: RetrievalMetrics | null
}

const passRateAmong = (values: boolean[]): number | null =>
  values.length === 0 ? null : values.filter(Boolean).length / values.length

/** Derive the numbers a gate checks from a run + its items (+ cases for behavior-aware metrics). */
export const gateMetricsFromRun = (
  run: Run,
  items: RunItem[],
  cases: DatasetCase[] = []
): GateRunMetrics => {
  const summary = run.summary
  const evaluated = items.filter((item) => item.status !== 'skipped')
  const passCount = evaluated.filter((item) => item.pass).length
  const interval = summary
    ? { low: summary.ciLow, high: summary.ciHigh }
    : wilsonInterval(passCount, evaluated.length)
  const costUsd = summary?.costUsd ?? evaluated.reduce((sum, item) => sum + item.costUsd, 0)
  const caseById = new Map(cases.map((caseValue) => [caseValue.id, caseValue]))
  const graderErrors = items.reduce(
    (sum, item) => sum + item.graderResults.filter((result) => Boolean(result.error)).length,
    0
  )
  const rubricScores: number[] = []
  const citationResults: boolean[] = []
  const refusalResults: boolean[] = []
  for (const item of items) {
    const caseValue = caseById.get(item.caseId)
    for (const result of item.graderResults) {
      if (result.kind === 'rubric' && typeof result.score === 'number') {
        rubricScores.push(result.score)
      }
      if (result.kind === 'citation_valid') {
        citationResults.push(result.pass)
      }
      if (
        result.kind === 'refusal_expected' &&
        (!caseValue || caseValue.expected.behavior === 'refuse')
      ) {
        refusalResults.push(result.pass)
      }
    }
  }
  const faithfulness =
    rubricScores.length === 0
      ? null
      : rubricScores.reduce((sum, value) => sum + value, 0) / rubricScores.length
  const latencyItems = items.filter((item) => item.status !== 'skipped')
  const p50 = summary?.p50LatencyMs ?? 0
  const p95 = summary?.p95LatencyMs ?? 0
  const totalCases = summary?.cases ?? items.length
  return {
    runId: run.id,
    status: run.status,
    cases: totalCases,
    pass: summary?.pass ?? passCount,
    passRate: summary?.passRate ?? (evaluated.length === 0 ? 0 : passCount / evaluated.length),
    ciLow: interval.low,
    ciHigh: interval.high,
    costUsd,
    costPerCaseUsd: totalCases === 0 ? 0 : costUsd / totalCases,
    costPerPassUsd: summary?.costPerPassUsd ?? (passCount === 0 ? null : costUsd / passCount),
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    skipped: items.length - latencyItems.length,
    graderErrors,
    graderErrorRate: totalCases === 0 ? 0 : graderErrors / totalCases,
    judgeAgreement: summary?.judgeAgreement ?? null,
    judgeKappa: summary?.judgeKappa ?? null,
    judgeErrors: items.reduce(
      (sum, item) =>
        sum +
        item.graderResults.filter((result) => result.kind === 'rubric' && result.error).length,
      0
    ),
    faithfulness,
    citationValidity: passRateAmong(citationResults),
    refusalAccuracy: passRateAmong(refusalResults),
    retrieval: summary?.retrieval ?? null,
  }
}

/* ------------------------------ comparison for rules ------------------------------ */

type PairedSlice = {
  slice: string
  cases: number
  baselinePassRate: number
  candidatePassRate: number
  deltaPp: number
}

type PairedComparison = {
  cases: number
  baselinePassRate: number
  candidatePassRate: number
  deltaPp: number
  slices: PairedSlice[]
}

const comparePair = (baselineItems: RunItem[], candidateItems: RunItem[]): PairedComparison => {
  const baselineById = new Map(
    baselineItems.filter((item) => item.status !== 'skipped').map((item) => [item.caseId, item])
  )
  const candidateById = new Map(
    candidateItems.filter((item) => item.status !== 'skipped').map((item) => [item.caseId, item])
  )
  const commonIds = [...baselineById.keys()].filter((caseId) => candidateById.has(caseId)).sort()
  const baselineCommon = commonIds.map((caseId) => baselineById.get(caseId) as RunItem)
  const candidateCommon = commonIds.map((caseId) => candidateById.get(caseId) as RunItem)
  const rate = (items: RunItem[]): number =>
    items.length === 0 ? 0 : items.filter((item) => item.pass).length / items.length
  const baselinePassRate = rate(baselineCommon)
  const candidatePassRate = rate(candidateCommon)
  const sliceNames = new Set<string>()
  for (const item of [...baselineCommon, ...candidateCommon]) {
    for (const slice of item.slices) {
      sliceNames.add(slice)
    }
  }
  const slices: PairedSlice[] = [...sliceNames].sort().map((slice) => {
    const before = baselineCommon.filter((item) => item.slices.includes(slice))
    const after = candidateCommon.filter((item) => item.slices.includes(slice))
    const cases = Math.min(before.length, after.length)
    const beforeRate = rate(before)
    const afterRate = rate(after)
    return {
      slice,
      cases,
      baselinePassRate: beforeRate,
      candidatePassRate: afterRate,
      deltaPp: (afterRate - beforeRate) * 100,
    }
  })
  return {
    cases: commonIds.length,
    baselinePassRate,
    candidatePassRate,
    deltaPp: (candidatePassRate - baselinePassRate) * 100,
    slices,
  }
}

/* ------------------------------ evaluation ------------------------------ */

export type GateFailingCase = {
  caseId: string
  slices: string[]
  answer: string
  error: string | null
  failedGraders: string[]
}

const failingGraderLabels = (results: GraderResult[]): string[] =>
  results
    .filter((result) => !result.pass)
    .map((result) => {
      if (result.error) {
        return `${result.kind}: error: ${result.error}`
      }
      const detail = result.detail ? ` (${result.detail})` : ''
      return `${result.kind}${detail}`
    })

export type EvaluateGateInput = {
  baselineRun: Run
  baselineItems: RunItem[]
  baselineCases: DatasetCase[]
  candidateRun: Run
  candidateItems: RunItem[]
  candidateCases: DatasetCase[]
  config: GateConfig
  override?: { reason?: string | null; by?: string | null } | null
  checkedAt?: number
}

export type EvaluateGateOutcome = {
  result: GateResult
  baseline: GateRunMetrics
  candidate: GateRunMetrics
  paired: PairedComparison
  slices: SliceComparison[]
  failingCases: GateFailingCase[]
}

const failure = (
  rule: string,
  message: string,
  actual: number | string | null,
  expected: number | string | null
): GateFailure => ({ rule, message, actual, expected })

export const evaluateGate = (input: EvaluateGateInput): EvaluateGateOutcome => {
  const checkedAt = input.checkedAt ?? now()
  const failures: GateFailure[] = []
  const warnings: string[] = []
  const config = input.config
  const baseline = gateMetricsFromRun(input.baselineRun, input.baselineItems, input.baselineCases)
  const candidate = gateMetricsFromRun(
    input.candidateRun,
    input.candidateItems,
    input.candidateCases
  )
  const paired = comparePair(input.baselineItems, input.candidateItems)

  if (input.baselineRun.status !== 'done') {
    failures.push(
      failure(
        'run_status',
        `baseline run ${input.baselineRun.id} is ${input.baselineRun.status}, expected done`,
        input.baselineRun.status,
        'done'
      )
    )
  }
  if (input.candidateRun.status !== 'done') {
    failures.push(
      failure(
        'run_status',
        `candidate run ${input.candidateRun.id} is ${input.candidateRun.status}, expected done${input.candidateRun.error ? `: ${input.candidateRun.error}` : ''}`,
        input.candidateRun.status,
        'done'
      )
    )
  }
  if (candidate.cases < config.minCases) {
    failures.push(
      failure(
        'min_cases',
        `candidate has ${candidate.cases} cases; gate requires ${config.minCases}`,
        candidate.cases,
        config.minCases
      )
    )
  }

  const thresholdChecks: {
    rule: string
    label: string
    actual: number | null
    expected: number
    compare: 'min' | 'max'
    percent?: boolean
  }[] = [
    {
      rule: 'threshold_pass_rate',
      label: 'pass rate',
      actual: candidate.passRate,
      expected: config.thresholds.passRate,
      compare: 'min',
      percent: true,
    },
    {
      rule: 'threshold_faithfulness',
      label: 'faithfulness (rubric)',
      actual: candidate.faithfulness,
      expected: config.thresholds.faithfulness,
      compare: 'min',
      percent: true,
    },
    {
      rule: 'threshold_citation_validity',
      label: 'citation validity',
      actual: candidate.citationValidity,
      expected: config.thresholds.citationValidity,
      compare: 'min',
      percent: true,
    },
    {
      rule: 'threshold_refusal_accuracy',
      label: 'refusal accuracy',
      actual: candidate.refusalAccuracy,
      expected: config.thresholds.refusalAccuracy,
      compare: 'min',
      percent: true,
    },
    {
      rule: 'threshold_cost_per_case',
      label: 'cost per case (USD)',
      actual: candidate.costPerCaseUsd,
      expected: config.thresholds.maxCostPerCaseUsd,
      compare: 'max',
    },
    {
      rule: 'threshold_p95_latency',
      label: 'p95 latency (ms)',
      actual: candidate.p95LatencyMs,
      expected: config.thresholds.maxP95LatencyMs,
      compare: 'max',
    },
  ]
  for (const check of thresholdChecks) {
    if (check.actual === null) {
      warnings.push(`${check.label} was not measured (no matching graded cases); threshold skipped`)
      continue
    }
    const ok =
      check.compare === 'min' ? check.actual >= check.expected : check.actual <= check.expected
    if (!ok) {
      failures.push(
        failure(
          check.rule,
          `${check.label} ${check.compare === 'min' ? 'below' : 'above'} threshold: ${check.percent ? formatPercent(check.actual, 2) : check.actual.toFixed(4)} vs ${check.percent ? formatPercent(check.expected, 0) : check.expected}`,
          check.actual,
          check.expected
        )
      )
    }
  }

  if (paired.cases > 0) {
    if (paired.deltaPp < -config.regression.overallMaxDropPp) {
      failures.push(
        failure(
          'regression_overall',
          `overall pass rate regressed ${formatPp(paired.deltaPp, 2)} on ${paired.cases} paired cases; allowed drop is ${config.regression.overallMaxDropPp} pp`,
          paired.deltaPp,
          -config.regression.overallMaxDropPp
        )
      )
    }
    for (const slice of paired.slices) {
      if (slice.cases < config.regression.minSliceCases) {
        continue
      }
      if (slice.deltaPp < -config.regression.sliceMaxDropPp) {
        failures.push(
          failure(
            `regression_slice:${slice.slice}`,
            `slice "${slice.slice}" regressed ${formatPp(slice.deltaPp, 2)} on ${slice.cases} cases; allowed drop is ${config.regression.sliceMaxDropPp} pp`,
            slice.deltaPp,
            -config.regression.sliceMaxDropPp
          )
        )
      }
    }
  } else {
    warnings.push('no paired cases between baseline and candidate; regression rules skipped')
  }

  if (config.judge.requireCalibration && candidate.judgeAgreement === null) {
    failures.push(
      failure(
        'judge_calibration',
        'judge calibration is required but no calibration set/result exists',
        null,
        config.judge.minAgreement
      )
    )
  }
  if (candidate.judgeAgreement !== null && candidate.judgeAgreement < config.judge.minAgreement) {
    failures.push(
      failure(
        'judge_agreement',
        `judge agreement ${formatPercent(candidate.judgeAgreement)} is below the minimum ${formatPercent(config.judge.minAgreement)}`,
        candidate.judgeAgreement,
        config.judge.minAgreement
      )
    )
  }
  const graderErrorPct = candidate.graderErrorRate * 100
  if (graderErrorPct > config.judge.maxGraderErrorsPct) {
    failures.push(
      failure(
        'grader_errors',
        `grader error rate ${graderErrorPct.toFixed(1)}% exceeds ${config.judge.maxGraderErrorsPct}%`,
        graderErrorPct,
        config.judge.maxGraderErrorsPct
      )
    )
  }

  let override: GateResult['override'] = null
  if (failures.length > 0 && input.override && (input.override.reason ?? '').trim().length > 0) {
    if (!config.overrides.allowed) {
      failures.push(
        failure('override', 'gate overrides are disabled by config', 'disabled', 'allowed')
      )
    } else {
      override = { reason: (input.override.reason as string).trim(), by: input.override.by ?? null }
      warnings.push(`gate overridden despite ${failures.length} failure(s): ${override.reason}`)
    }
  } else if (failures.length > 0 && config.overrides.allowed && config.overrides.requireReason) {
    // No (valid) override supplied; nothing extra to reject, the failures stand.
  }

  const pass = failures.length === 0 || override !== null
  const verdict: GateResult['verdict'] = pass
    ? warnings.length > 0 || override !== null
      ? 'warn'
      : 'pass'
    : 'fail'
  const result: GateResult = { pass, verdict, failures, warnings, checkedAt, override }

  const failingCases: GateFailingCase[] = input.candidateItems
    .filter((item) => !item.pass)
    .slice(0, 50)
    .map((item) => ({
      caseId: item.caseId,
      slices: item.slices,
      answer: item.answer.length > 400 ? `${item.answer.slice(0, 397)}…` : item.answer,
      error: item.error,
      failedGraders: failingGraderLabels(item.graderResults),
    }))
  const sliceComparisons: SliceComparison[] = paired.slices.map((slice) => ({
    slice: slice.slice,
    cases: slice.cases,
    passRate: {
      baseline: slice.baselinePassRate,
      candidate: slice.candidatePassRate,
      delta: slice.deltaPp,
      deltaPct:
        slice.baselinePassRate === 0
          ? null
          : (slice.deltaPp / (slice.baselinePassRate * 100)) * 100,
    },
    regressed:
      slice.deltaPp < -config.regression.sliceMaxDropPp &&
      slice.cases >= config.regression.minSliceCases,
  }))
  return { result, baseline, candidate, paired, slices: sliceComparisons, failingCases }
}

/* ------------------------------ provenance ------------------------------ */

export type GateRunProvenance = {
  runId: string
  profileId: string
  profileName: string
  profileSpecHash: string
  datasetId: string
  datasetName: string
  datasetVersion: number
  datasetVersionId: string
  datasetContentHash: string
  runConfigHash: string
  provider: string
  mode: string
  pricingBasis: string
  scheduledAt: number | null
  cases: number
}

export type GateJudgeProvenance = {
  model: string
  modelVersion: string
  promptHash: string
  passScore: number
  calibrationSource: string | null
  calibrationItems: number
  agreement: number | null
  kappa: number | null
  note: string
}

export type GateProvenance = {
  tool: 'stella'
  version: string
  generatedAt: number
  gateConfigPath: string | null
  gateConfigHash: string
  baseline: GateRunProvenance
  candidate: GateRunProvenance
  judge: GateJudgeProvenance | null
  notes: string[]
}

const hashOf = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

const runDatasetVersionId = (runId: string, db: Db): string => {
  const row = db.prepare('SELECT dataset_version_id FROM runs WHERE id = ?').get(runId) as
    | { dataset_version_id: string }
    | undefined
  return row?.dataset_version_id ?? ''
}

const describeRunForProvenance = (run: Run, db: Db): GateRunProvenance => {
  const versionRow = db
    .prepare('SELECT id, content_hash FROM dataset_versions WHERE id = ?')
    .get(runDatasetVersionId(run.id, db)) as { id: string; content_hash: string } | undefined
  const runRow = db.prepare('SELECT config_json FROM runs WHERE id = ?').get(run.id) as {
    config_json: string
  }
  const runConfig = parseJson<Record<string, unknown>>(runRow.config_json, {})
  let profileSpecHash = ''
  try {
    profileSpecHash = hashOf(JSON.stringify(getProfile(run.profileId, db).spec))
  } catch {
    profileSpecHash = 'missing'
  }
  const pricingMoment = run.startedAt ?? run.createdAt
  return {
    runId: run.id,
    profileId: run.profileId,
    profileName: run.profileName,
    profileSpecHash,
    datasetId: run.datasetId,
    datasetName: run.datasetName,
    datasetVersion: run.datasetVersion,
    datasetVersionId: versionRow?.id ?? '',
    datasetContentHash: versionRow?.content_hash ?? '',
    runConfigHash: hashOf(runRow.config_json),
    provider: run.provider,
    mode: run.mode,
    pricingBasis: pricingBasisFor(pricingMoment),
    scheduledAt:
      typeof runConfig.scheduledAt === 'number' && Number.isFinite(runConfig.scheduledAt)
        ? runConfig.scheduledAt
        : null,
    cases: run.summary?.cases ?? 0,
  }
}

const pricingBasisFor = (timestamp: number): string => {
  const date = new Date(timestamp)
  const day = date.getUTCDay()
  if (day === 0 || day === 6) {
    return 'off-peak'
  }
  const hour = date.getUTCHours()
  const peak = (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
  return peak ? 'peak' : 'off-peak'
}

/** Loads the run/dataset/profile facts needed for a reproducible review artifact. */
export const buildProvenance = (
  input: {
    baselineRun: Run
    candidateRun: Run
    configPath?: string | null
    configHash: string
    notes?: string[]
  },
  options: { db?: Db } = {}
): GateProvenance => {
  const db = options.db ?? getDb()
  const candidateConfig = readRunConfig(input.candidateRun.id, db)
  const judgeMeta = candidateConfig.judgeMeta ?? null
  const calibrationMeta = candidateConfig.calibrationMeta ?? null
  const judge: GateJudgeProvenance | null = judgeMeta
    ? {
        model: judgeMeta.model,
        modelVersion: judgeMeta.modelVersion,
        promptHash: judgeMeta.promptHash,
        passScore: judgeMeta.passScore,
        calibrationSource: calibrationMeta?.source ?? null,
        calibrationItems: calibrationMeta?.items ?? 0,
        agreement: calibrationMeta?.agreement ?? input.candidateRun.summary?.judgeAgreement ?? null,
        kappa: calibrationMeta?.kappa ?? input.candidateRun.summary?.judgeKappa ?? null,
        note: 'Judge calls are not included in run cost. Calibration labels are seed labels, not independent human labels.',
      }
    : null
  return {
    tool: 'stella',
    version: config.version,
    generatedAt: now(),
    gateConfigPath: input.configPath ?? null,
    gateConfigHash: input.configHash,
    baseline: describeRunForProvenance(input.baselineRun, db),
    candidate: describeRunForProvenance(input.candidateRun, db),
    judge,
    notes: [...(input.notes ?? [])],
  }
}

/* ------------------------------ artifact model ------------------------------ */

export type GateArtifact = {
  version: 1
  gate: Gate
  configHash: string
  configPath: string | null
  baseline: GateRunMetrics
  candidate: GateRunMetrics
  paired: PairedComparison
  slices: SliceComparison[]
  failingCases: GateFailingCase[]
  provenance: GateProvenance
}

export const buildGateArtifact = (input: {
  gate: Gate
  outcome: EvaluateGateOutcome
  provenance: GateProvenance
  configHash: string
  configPath: string | null
}): GateArtifact => ({
  version: 1,
  gate: input.gate,
  configHash: input.configHash,
  configPath: input.configPath,
  baseline: input.outcome.baseline,
  candidate: input.outcome.candidate,
  paired: input.outcome.paired,
  slices: input.outcome.slices,
  failingCases: input.outcome.failingCases,
  provenance: input.provenance,
})

export const gateArtifactJson = (artifact: GateArtifact): string =>
  `${JSON.stringify(artifact, null, 2)}\n`

const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const escapeMd = (value: unknown): string => String(value ?? '').replaceAll('|', '\\|')

const verdictLabel = (artifact: GateArtifact): string => {
  if (!artifact.gate.result.pass) {
    return 'FAIL'
  }
  return artifact.gate.result.verdict === 'warn' ? 'PASS (WARN)' : 'PASS'
}

const isoTime = (timestamp: number): string =>
  new Date(timestamp)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC')

const signedPp = (value: number | null): string => (value === null ? '—' : formatPp(value, 2))

const costCell = (value: number | null): string => formatUsd(value)

const thresholdRows = (
  artifact: GateArtifact
): { label: string; actual: string; expected: string; status: string }[] => {
  const config = artifact.gate.config
  const failures = new Set(artifact.gate.result.failures.map((entry) => entry.rule))
  const warnings = artifact.gate.result.warnings
  const missing = (label: string): boolean =>
    warnings.some((warning) => warning.startsWith(`${label} was not measured`))
  const rows: { label: string; actual: string; expected: string; status: string }[] = []
  const add = (
    rule: string,
    label: string,
    actual: string,
    expected: string,
    measured: boolean
  ): void => {
    if (!measured) {
      rows.push({ label, actual: 'not measured', expected, status: 'skipped' })
    } else {
      rows.push({ label, actual, expected, status: failures.has(rule) ? 'fail' : 'pass' })
    }
  }
  add(
    'threshold_pass_rate',
    'Pass rate',
    formatPercent(artifact.candidate.passRate, 2),
    `>= ${formatPercent(config.thresholds.passRate, 0)}`,
    true
  )
  add(
    'threshold_faithfulness',
    'Faithfulness (rubric 0-1)',
    artifact.candidate.faithfulness === null ? '—' : artifact.candidate.faithfulness.toFixed(3),
    `>= ${config.thresholds.faithfulness}`,
    !missing('Faithfulness (rubric)')
  )
  add(
    'threshold_citation_validity',
    'Citation validity',
    artifact.candidate.citationValidity === null
      ? '—'
      : formatPercent(artifact.candidate.citationValidity, 2),
    `>= ${formatPercent(config.thresholds.citationValidity, 0)}`,
    !missing('Citation validity')
  )
  add(
    'threshold_refusal_accuracy',
    'Refusal accuracy',
    artifact.candidate.refusalAccuracy === null
      ? '—'
      : formatPercent(artifact.candidate.refusalAccuracy, 2),
    `>= ${formatPercent(config.thresholds.refusalAccuracy, 0)}`,
    !missing('Refusal accuracy')
  )
  add(
    'threshold_cost_per_case',
    'Cost per case',
    costCell(artifact.candidate.costPerCaseUsd),
    `<= ${formatUsd(config.thresholds.maxCostPerCaseUsd)}`,
    true
  )
  add(
    'threshold_p95_latency',
    'p95 latency',
    `${Math.round(artifact.candidate.p95LatencyMs)} ms`,
    `<= ${config.thresholds.maxP95LatencyMs} ms`,
    true
  )
  return rows
}

/* ------------------------------ Markdown ------------------------------ */

export const renderGateMarkdown = (artifact: GateArtifact): string => {
  const { gate, baseline, candidate } = artifact
  const lines: string[] = []
  const verdict = verdictLabel(artifact)
  lines.push(`# Release gate — ${verdict}`)
  lines.push('')
  lines.push(`- Suite: \`${gate.config.suite}\``)
  lines.push(`- Checked: ${isoTime(gate.result.checkedAt)}`)
  lines.push(`- Gate: \`${gate.id}\``)
  lines.push(`- Baseline run: \`${baseline.runId}\` (${baseline.cases} cases)`)
  lines.push(`- Candidate run: \`${candidate.runId}\` (${candidate.cases} cases)`)
  lines.push(`- Gate config hash: \`${artifact.configHash}\``)
  lines.push('')
  if (!gate.result.pass) {
    lines.push('## Failures')
    lines.push('')
    for (const issue of gate.result.failures) {
      lines.push(`- **${issue.rule}** — ${issue.message}`)
    }
    lines.push('')
  }
  if (gate.result.override) {
    lines.push(
      `> Override applied by ${gate.result.override.by ?? 'unknown'}: ${gate.result.override.reason}`
    )
    lines.push('')
  }
  lines.push('## Overall')
  lines.push('')
  lines.push('| Metric | Baseline | Candidate | Delta |')
  lines.push('| --- | --- | --- | --- |')
  lines.push(
    `| Pass rate | ${formatPercent(baseline.passRate, 2)} (${formatPercent(baseline.ciLow, 1)}–${formatPercent(baseline.ciHigh, 1)}) | ${formatPercent(candidate.passRate, 2)} (${formatPercent(candidate.ciLow, 1)}–${formatPercent(candidate.ciHigh, 1)}) | ${signedPp(artifact.paired.deltaPp)} |`
  )
  lines.push(`| Cost | ${costCell(baseline.costUsd)} | ${costCell(candidate.costUsd)} | — |`)
  lines.push(
    `| Cost / successful answer | ${costCell(baseline.costPerPassUsd)} | ${costCell(candidate.costPerPassUsd)} | — |`
  )
  lines.push(
    `| p50 latency | ${Math.round(baseline.p50LatencyMs)} ms | ${Math.round(candidate.p50LatencyMs)} ms | — |`
  )
  lines.push(
    `| p95 latency | ${Math.round(baseline.p95LatencyMs)} ms | ${Math.round(candidate.p95LatencyMs)} ms | — |`
  )
  lines.push(`| Grader errors | ${baseline.graderErrors} | ${candidate.graderErrors} | — |`)
  lines.push('')
  lines.push('## Thresholds')
  lines.push('')
  lines.push('| Rule | Actual | Expected | Status |')
  lines.push('| --- | --- | --- | --- |')
  for (const row of thresholdRows(artifact)) {
    lines.push(
      `| ${escapeMd(row.label)} | ${escapeMd(row.actual)} | ${escapeMd(row.expected)} | ${row.status.toUpperCase()} |`
    )
  }
  lines.push('')
  lines.push('## Slices')
  lines.push('')
  if (artifact.slices.length === 0) {
    lines.push('_No paired slices._')
  } else {
    lines.push('| Slice | Cases | Baseline | Candidate | Delta |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const slice of artifact.slices) {
      lines.push(
        `| ${escapeMd(slice.slice)} | ${slice.cases} | ${formatPercent(slice.passRate.baseline ?? 0, 1)} | ${formatPercent(slice.passRate.candidate ?? 0, 1)} | ${signedPp(slice.passRate.delta)}${slice.regressed ? ' ⚠️' : ''} |`
      )
    }
  }
  lines.push('')
  lines.push('## Judge trust')
  lines.push('')
  if (!artifact.provenance.judge) {
    lines.push(
      '_Judge was not enabled for this run; rubric faithfulness and calibration are unmeasured._'
    )
  } else {
    const judge = artifact.provenance.judge
    lines.push('| Field | Value |')
    lines.push('| --- | --- |')
    lines.push(`| Model | ${escapeMd(judge.model)} (${escapeMd(judge.modelVersion)}) |`)
    lines.push(`| Prompt hash | \`${judge.promptHash}\` |`)
    lines.push(
      `| Calibration agreement | ${judge.agreement === null ? 'not measured' : formatPercent(judge.agreement, 1)} |`
    )
    lines.push(
      `| Cohen's kappa | ${judge.kappa === null ? 'not measured' : judge.kappa.toFixed(3)} |`
    )
    lines.push(`| Judge errors | ${candidate.judgeErrors} |`)
    lines.push('')
    lines.push(`_${judge.note}_`)
  }
  lines.push('')
  lines.push('## Failing cases (candidate)')
  lines.push('')
  if (artifact.failingCases.length === 0) {
    lines.push('_No failing cases._')
  } else {
    for (const item of artifact.failingCases.slice(0, 20)) {
      lines.push(
        `### \`${item.caseId}\`${item.slices.length > 0 ? ` — ${item.slices.join(', ')}` : ''}`
      )
      if (item.error) {
        lines.push(`- Error: ${item.error}`)
      }
      if (item.failedGraders.length > 0) {
        lines.push(`- Failed graders: ${item.failedGraders.join('; ')}`)
      }
      if (item.answer.length > 0) {
        lines.push(`- Answer: ${item.answer.replace(/\s+/g, ' ').slice(0, 300)}`)
      }
      lines.push('')
    }
    if (artifact.gate.result.failures.length === 0) {
      lines.push(
        '_Failing cases do not fail the gate individually; thresholds and regressions decide._'
      )
    }
  }
  lines.push('')
  lines.push('## Provenance')
  lines.push('')
  lines.push('| Field | Baseline | Candidate |')
  lines.push('| --- | --- | --- |')
  const base = artifact.provenance.baseline
  const cand = artifact.provenance.candidate
  lines.push(`| Run id | \`${base.runId}\` | \`${cand.runId}\` |`)
  lines.push(
    `| Profile | ${escapeMd(base.profileName)} (\`${base.profileId}\`) | ${escapeMd(cand.profileName)} (\`${cand.profileId}\`) |`
  )
  lines.push(`| Profile spec hash | \`${base.profileSpecHash}\` | \`${cand.profileSpecHash}\` |`)
  lines.push(
    `| Dataset | ${escapeMd(base.datasetName)} v${base.datasetVersion} | ${escapeMd(cand.datasetName)} v${cand.datasetVersion} |`
  )
  lines.push(`| Dataset version id | \`${base.datasetVersionId}\` | \`${cand.datasetVersionId}\` |`)
  lines.push(
    `| Dataset content hash | \`${base.datasetContentHash}\` | \`${cand.datasetContentHash}\` |`
  )
  lines.push(`| Run config hash | \`${base.runConfigHash}\` | \`${cand.runConfigHash}\` |`)
  lines.push(
    `| Provider / mode | ${base.provider} / ${base.mode} | ${cand.provider} / ${cand.mode} |`
  )
  lines.push(`| Pricing basis | ${base.pricingBasis} | ${cand.pricingBasis} |`)
  lines.push(
    `| Off-peak scheduled | ${base.scheduledAt === null ? 'no' : isoTime(base.scheduledAt)} | ${cand.scheduledAt === null ? 'no' : isoTime(cand.scheduledAt)} |`
  )
  lines.push('')
  lines.push(
    `_Generated by ${artifact.provenance.tool} ${artifact.provenance.version} at ${isoTime(artifact.provenance.generatedAt)}. Gate config: ${artifact.configPath ?? 'defaults (no stella.gate.json)'} (${artifact.configHash})._`
  )
  if (artifact.provenance.notes.length > 0) {
    lines.push('')
    for (const note of artifact.provenance.notes) {
      lines.push(`> ${note}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

/* ------------------------------ HTML ------------------------------ */

const statusClass = (status: string): string =>
  status === 'pass' ? 'pass' : status === 'fail' ? 'fail' : 'skip'

const htmlThresholdRows = (artifact: GateArtifact): string =>
  thresholdRows(artifact)
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.label)}</td><td class="mono">${escapeHtml(row.actual)}</td><td class="mono">${escapeHtml(row.expected)}</td><td><span class="pill ${statusClass(row.status)}">${escapeHtml(row.status.toUpperCase())}</span></td></tr>`
    )
    .join('\n')

const htmlSliceRows = (artifact: GateArtifact): string => {
  if (artifact.slices.length === 0) {
    return '<tr><td colspan="5" class="muted">No paired slices.</td></tr>'
  }
  return artifact.slices
    .map((slice) => {
      const delta = slice.passRate.delta ?? 0
      const trend = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
      return `<tr><td>${escapeHtml(slice.slice)}</td><td class="mono">${slice.cases}</td><td class="mono">${formatPercent(slice.passRate.baseline ?? 0, 1)}</td><td class="mono">${formatPercent(slice.passRate.candidate ?? 0, 1)}</td><td class="mono ${trend}">${signedPp(slice.passRate.delta)}${slice.regressed ? ' ⚠' : ''}</td></tr>`
    })
    .join('\n')
}

const htmlFailingCases = (artifact: GateArtifact): string => {
  if (artifact.failingCases.length === 0) {
    return '<p class="muted">No failing cases in the candidate run.</p>'
  }
  return artifact.failingCases
    .slice(0, 20)
    .map((item) => {
      const graders =
        item.failedGraders.length > 0
          ? `<div class="small"><strong>Failed graders:</strong> ${escapeHtml(item.failedGraders.join('; '))}</div>`
          : ''
      const error = item.error
        ? `<div class="small bad"><strong>Error:</strong> ${escapeHtml(item.error)}</div>`
        : ''
      return `<details class="case"><summary><span class="mono">${escapeHtml(item.caseId)}</span>${item.slices.length > 0 ? ` <span class="tag">${escapeHtml(item.slices.join(' · '))}</span>` : ''}</summary>${error}${graders}${item.answer ? `<div class="answer">${escapeHtml(item.answer)}</div>` : ''}</details>`
    })
    .join('\n')
}

/** Self-contained review artifact: inline CSS, no external assets, PM-readable. */
export const renderGateHtml = (artifact: GateArtifact): string => {
  const { gate, baseline, candidate, provenance } = artifact
  const pass = gate.result.pass
  const verdict = verdictLabel(artifact)
  const badgeClass = pass ? (gate.result.verdict === 'warn' ? 'warn' : 'pass') : 'fail'
  const ciDelta = artifact.paired.deltaPp
  const failures = gate.result.failures
    .map(
      (issue) =>
        `<li><strong>${escapeHtml(issue.rule)}</strong> — ${escapeHtml(issue.message)}</li>`
    )
    .join('\n')
  const warnings = gate.result.warnings
    .map((warning) => `<li>${escapeHtml(warning)}</li>`)
    .join('\n')
  const override = gate.result.override
    ? `<div class="banner override"><strong>Override applied</strong> by ${escapeHtml(gate.result.override.by ?? 'unknown')}: ${escapeHtml(gate.result.override.reason)}</div>`
    : ''
  const judge = provenance.judge
  const judgeBlock = judge
    ? `<dl class="kv">
        <div><dt>Model</dt><dd>${escapeHtml(judge.model)} <span class="muted">(${escapeHtml(judge.modelVersion)})</span></dd></div>
        <div><dt>Prompt hash</dt><dd class="mono small">${escapeHtml(judge.promptHash)}</dd></div>
        <div><dt>Calibration agreement</dt><dd>${judge.agreement === null ? '<span class="muted">not measured</span>' : formatPercent(judge.agreement, 1)}</dd></div>
        <div><dt>Cohen's kappa</dt><dd>${judge.kappa === null ? '<span class="muted">not measured</span>' : judge.kappa.toFixed(3)}</dd></div>
        <div><dt>Judge errors</dt><dd>${candidate.judgeErrors}</dd></div>
        <div><dt>Calibration items</dt><dd>${judge.calibrationItems}</dd></div>
      </dl><p class="muted small">${escapeHtml(judge.note)}</p>`
    : '<p class="muted">The rubric judge was not enabled for this run, so faithfulness and judge agreement are unmeasured. Gate thresholds for those metrics are skipped with a warning.</p>'
  const providerLine = `${escapeHtml(provenance.baseline.provider)} / ${escapeHtml(provenance.baseline.mode)}`
  const candidateProviderLine = `${escapeHtml(provenance.candidate.provider)} / ${escapeHtml(provenance.candidate.mode)}`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stella release gate — ${escapeHtml(verdict)} — ${escapeHtml(gate.config.suite)}</title>
<style>
  :root {
    --bg: #0f1115;
    --panel: #171a21;
    --panel-2: #1e222b;
    --text: #e8eaf0;
    --muted: #9aa3b2;
    --line: #2a303c;
    --pass: #2fbf71;
    --fail: #ef5350;
    --warn: #f2b84b;
    --accent: #6aa9ff;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px 64px; background: var(--bg); color: var(--text);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 1060px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 17px; margin: 0 0 14px; }
  .sub { color: var(--muted); margin: 0 0 24px; }
  .badge { display: inline-block; padding: 5px 13px; border-radius: 999px; font-weight: 700; font-size: 13px; letter-spacing: .06em; }
  .badge.pass { background: rgba(47,191,113,.14); color: var(--pass); border: 1px solid rgba(47,191,113,.4); }
  .badge.warn { background: rgba(242,184,75,.14); color: var(--warn); border: 1px solid rgba(242,184,75,.4); }
  .badge.fail { background: rgba(239,83,80,.14); color: var(--fail); border: 1px solid rgba(239,83,80,.4); }
  .banner { border-radius: 10px; padding: 12px 16px; margin: 18px 0; border: 1px solid var(--line); background: var(--panel); }
  .banner.fail { border-color: rgba(239,83,80,.45); background: rgba(239,83,80,.08); }
  .banner.warn { border-color: rgba(242,184,75,.35); background: rgba(242,184,75,.07); }
  .banner.override { border-color: rgba(106,169,255,.4); background: rgba(106,169,255,.08); }
  .banner ul { margin: 8px 0 0; padding-left: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin: 16px 0 8px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .card .label { color: var(--muted); font-size: 12px; letter-spacing: .01em; }
  .card .value { font-size: 24px; font-weight: 650; margin-top: 4px; }
  .card .note { color: var(--muted); font-size: 12px; margin-top: 2px; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px; margin: 16px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; letter-spacing: .01em; }
  tr:last-child td { border-bottom: none; }
  .mono { font-family: var(--mono); font-size: 13px; }
  .small { font-size: 12.5px; }
  .muted { color: var(--muted); }
  .bad { color: var(--fail); }
  .up { color: var(--pass); }
  .down { color: var(--fail); }
  .flat { color: var(--muted); }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: .05em; }
  .pill.pass { background: rgba(47,191,113,.14); color: var(--pass); }
  .pill.fail { background: rgba(239,83,80,.14); color: var(--fail); }
  .pill.skip { background: rgba(154,163,178,.14); color: var(--muted); }
  .tag { color: var(--muted); font-size: 12px; }
  .case { border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px; margin: 8px 0; background: var(--panel-2); }
  .case summary { cursor: pointer; }
  .case .answer { margin-top: 8px; font-size: 13.5px; color: #cfd5df; border-left: 3px solid var(--line); padding-left: 10px; white-space: pre-wrap; }
  dl.kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px 20px; margin: 0; }
  dl.kv div { border-bottom: 1px solid var(--line); padding-bottom: 6px; }
  dt { color: var(--muted); font-size: 11.5px; letter-spacing: .01em; }
  dd { margin: 2px 0 0; }
  footer { color: var(--muted); font-size: 12px; margin-top: 28px; line-height: 1.7; }
  .hashline { word-break: break-all; }
</style>
</head>
<body>
<main>
  <span class="badge ${badgeClass}">${escapeHtml(verdict)}</span>
  <h1>Release gate review — ${escapeHtml(gate.config.suite)}</h1>
  <p class="sub">Baseline <span class="mono">${escapeHtml(baseline.runId)}</span> → candidate <span class="mono">${escapeHtml(candidate.runId)}</span> · checked ${escapeHtml(isoTime(gate.result.checkedAt))} · gate <span class="mono">${escapeHtml(gate.id)}</span></p>
  ${override}
  ${failures.length > 0 ? `<div class="banner fail"><strong>${gate.result.failures.length} gate failure${gate.result.failures.length === 1 ? '' : 's'}</strong><ul>${failures}</ul></div>` : ''}
  ${warnings.length > 0 ? `<div class="banner warn"><strong>Warnings</strong><ul>${warnings}</ul></div>` : ''}

  <div class="grid">
    <div class="card"><div class="label">Pass rate (candidate)</div><div class="value">${formatPercent(candidate.passRate, 1)}</div><div class="note">CI ${formatPercent(candidate.ciLow, 1)}–${formatPercent(candidate.ciHigh, 1)} · ${candidate.pass}/${candidate.cases} cases</div></div>
    <div class="card"><div class="label">Δ vs baseline</div><div class="value ${ciDelta > 0 ? 'up' : ciDelta < 0 ? 'down' : 'flat'}">${signedPp(ciDelta)}</div><div class="note">${artifact.paired.cases} paired cases · ${artifact.paired.cases > 0 ? `${gate.result.pass ? 'no material regression' : 'see failures'}` : 'not paired'}</div></div>
    <div class="card"><div class="label">Cost / successful answer</div><div class="value">${costCell(candidate.costPerPassUsd)}</div><div class="note">${costCell(candidate.costUsd)} total · ${costCell(candidate.costPerCaseUsd)}/case</div></div>
    <div class="card"><div class="label">p95 latency</div><div class="value">${Math.round(candidate.p95LatencyMs)} ms</div><div class="note">p50 ${Math.round(candidate.p50LatencyMs)} ms · max ${artifact.gate.config.thresholds.maxP95LatencyMs} ms</div></div>
    <div class="card"><div class="label">Grader errors</div><div class="value">${candidate.graderErrors}</div><div class="note">${(candidate.graderErrorRate * 100).toFixed(1)}% of cases · limit ${artifact.gate.config.judge.maxGraderErrorsPct}%</div></div>
    <div class="card"><div class="label">Judge agreement</div><div class="value">${candidate.judgeAgreement === null ? '—' : formatPercent(candidate.judgeAgreement, 1)}</div><div class="note">κ ${candidate.judgeKappa === null ? '—' : candidate.judgeKappa.toFixed(2)} · min ${formatPercent(artifact.gate.config.judge.minAgreement, 0)}</div></div>
  </div>

  <section>
    <h2>Thresholds</h2>
    <table><thead><tr><th>Rule</th><th>Actual</th><th>Expected</th><th>Status</th></tr></thead><tbody>${htmlThresholdRows(artifact)}</tbody></table>
  </section>

  <section>
    <h2>Slices</h2>
    <table><thead><tr><th>Slice</th><th>Cases</th><th>Baseline</th><th>Candidate</th><th>Δ</th></tr></thead><tbody>${htmlSliceRows(artifact)}</tbody></table>
    <p class="muted small">Slice regression rules apply to slices with at least ${artifact.gate.config.regression.minSliceCases} paired cases; the allowed drop is ${artifact.gate.config.regression.sliceMaxDropPp} pp. Overall allowed drop: ${artifact.gate.config.regression.overallMaxDropPp} pp.</p>
  </section>

  <section>
    <h2>Judge trust</h2>
    ${judgeBlock}
  </section>

  <section>
    <h2>Failing cases (candidate)</h2>
    ${htmlFailingCases(artifact)}
  </section>

  <section>
    <h2>Provenance</h2>
    <table>
      <thead><tr><th>Field</th><th>Baseline</th><th>Candidate</th></tr></thead>
      <tbody>
        <tr><td>Run id</td><td class="mono">${escapeHtml(provenance.baseline.runId)}</td><td class="mono">${escapeHtml(provenance.candidate.runId)}</td></tr>
        <tr><td>Profile</td><td>${escapeHtml(provenance.baseline.profileName)}<br><span class="mono small">${escapeHtml(provenance.baseline.profileSpecHash)}</span></td><td>${escapeHtml(provenance.candidate.profileName)}<br><span class="mono small">${escapeHtml(provenance.candidate.profileSpecHash)}</span></td></tr>
        <tr><td>Dataset</td><td>${escapeHtml(provenance.baseline.datasetName)} v${provenance.baseline.datasetVersion}<br><span class="mono small hashline">${escapeHtml(provenance.baseline.datasetContentHash)}</span></td><td>${escapeHtml(provenance.candidate.datasetName)} v${provenance.candidate.datasetVersion}<br><span class="mono small hashline">${escapeHtml(provenance.candidate.datasetContentHash)}</span></td></tr>
        <tr><td>Dataset version id</td><td class="mono small hashline">${escapeHtml(provenance.baseline.datasetVersionId)}</td><td class="mono small hashline">${escapeHtml(provenance.candidate.datasetVersionId)}</td></tr>
        <tr><td>Run config hash</td><td class="mono small hashline">${escapeHtml(provenance.baseline.runConfigHash)}</td><td class="mono small hashline">${escapeHtml(provenance.candidate.runConfigHash)}</td></tr>
        <tr><td>Provider / mode</td><td>${providerLine}</td><td>${candidateProviderLine}</td></tr>
        <tr><td>Pricing basis</td><td>${escapeHtml(provenance.baseline.pricingBasis)}</td><td>${escapeHtml(provenance.candidate.pricingBasis)}</td></tr>
        <tr><td>Off-peak scheduled</td><td>${provenance.baseline.scheduledAt === null ? 'no' : escapeHtml(isoTime(provenance.baseline.scheduledAt))}</td><td>${provenance.candidate.scheduledAt === null ? 'no' : escapeHtml(isoTime(provenance.candidate.scheduledAt))}</td></tr>
      </tbody>
    </table>
    <footer>
      <div>Gate config: ${escapeHtml(artifact.configPath ?? 'built-in defaults (no stella.gate.json)')} · <span class="mono hashline">${escapeHtml(artifact.configHash)}</span></div>
      <div>Generated by ${escapeHtml(provenance.tool)} ${escapeHtml(provenance.version)} at ${escapeHtml(isoTime(provenance.generatedAt))}. Thresholds, regression rules, judge rules and failing cases are recorded in gate.json next to this file. Re-run the gate against the same run ids and config hash to reproduce this review.</div>
      ${provenance.notes.length > 0 ? provenance.notes.map((note) => `<div>${escapeHtml(note)}</div>`).join('') : ''}
    </footer>
  </section>
</main>
</body>
</html>
`
}

/* ------------------------------ persistence ------------------------------ */

export type GateArtifactPaths = { dir: string; mdPath: string; jsonPath: string; htmlPath: string }

export const gateArtifactPaths = (
  candidateRunId: string,
  dataDir = config.dataDir
): GateArtifactPaths => {
  const dir = path.join(dataDir, 'runs', candidateRunId)
  return {
    dir,
    mdPath: path.join(dir, 'gate.md'),
    jsonPath: path.join(dir, 'gate.json'),
    htmlPath: path.join(dir, 'review.html'),
  }
}

export const writeGateArtifacts = (
  artifact: GateArtifact,
  options: { dataDir?: string } = {}
): GateArtifactPaths => {
  const paths = gateArtifactPaths(artifact.gate.candidateRunId, options.dataDir ?? config.dataDir)
  mkdirSync(paths.dir, { recursive: true })
  writeFileSync(paths.mdPath, renderGateMarkdown(artifact), 'utf8')
  writeFileSync(paths.jsonPath, gateArtifactJson(artifact), 'utf8')
  writeFileSync(paths.htmlPath, renderGateHtml(artifact), 'utf8')
  return paths
}

/* ------------------------------ rows / API ------------------------------ */

type GateRow = {
  id: string
  baseline_run_id: string
  candidate_run_id: string
  config_json: string
  result_json: string
  artifact_md: string | null
  artifact_html: string | null
  created_at: number
}

const mapGateRow = (row: GateRow): Gate => ({
  id: row.id,
  baselineRunId: row.baseline_run_id,
  candidateRunId: row.candidate_run_id,
  config: parseJson<GateConfig>(row.config_json, DEFAULT_GATE_CONFIG),
  result: parseJson<GateResult>(row.result_json, {
    pass: false,
    verdict: 'fail',
    failures: [],
    warnings: [],
    checkedAt: row.created_at,
    override: null,
  }),
  createdAt: row.created_at,
})

export const getGate = (gateId: string, db: Db = getDb()): Gate => {
  const row = db.prepare('SELECT * FROM gates WHERE id = ?').get(gateId) as GateRow | undefined
  if (!row) {
    throw new BusinessError(`gate not found: ${gateId}`, 'gate_not_found', 404)
  }
  return mapGateRow(row)
}

export const listGates = (options: { limit?: number } = {}, db: Db = getDb()): Gate[] => {
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)))
  const rows = db
    .prepare('SELECT * FROM gates ORDER BY created_at DESC, id ASC LIMIT ?')
    .all(limit) as GateRow[]
  return rows.map(mapGateRow)
}

export type CreateGateInput = {
  baselineRunId: string
  candidateRunId: string
  /** Explicit config (API body); otherwise stella.gate.json / defaults are loaded. */
  config?: unknown
  override?: { reason?: string | null; by?: string | null } | null
  /** Explicit config file path (CLI --config). */
  configFile?: string
  dataDir?: string
  /** Resolved config path/hash, used internally when config was loaded earlier. */
  configPath?: string | null
  configHash?: string
}

export type CreateGateResult = Gate & { artifacts: GateArtifactPaths; artifact: GateArtifact }

const loadRunsForGate = (
  baselineRunId: string,
  candidateRunId: string,
  db: Db
): {
  baselineRun: Run
  baselineItems: RunItem[]
  baselineCases: DatasetCase[]
  candidateRun: Run
  candidateItems: RunItem[]
  candidateCases: DatasetCase[]
} => {
  if (baselineRunId === candidateRunId) {
    throw new BusinessError(
      'baseline and candidate runs must be different',
      'invalid_gate_input',
      400
    )
  }
  const load = (runId: string) => {
    const run = getRun(runId, db)
    const items = getRunItems(runId, db)
    const versionId = runDatasetVersionId(runId, db)
    const version = getDatasetVersion(versionId, db)
    const cases = readVersionCases(version)
    return { run, items, cases }
  }
  const baseline = load(baselineRunId)
  const candidate = load(candidateRunId)
  return {
    baselineRun: baseline.run,
    baselineItems: baseline.items,
    baselineCases: baseline.cases,
    candidateRun: candidate.run,
    candidateItems: candidate.items,
    candidateCases: candidate.cases,
  }
}

/** Evaluate a gate and persist the row + artifacts. */
export const createGate = (input: CreateGateInput, options: { db?: Db } = {}): CreateGateResult => {
  const db = options.db ?? getDb()
  let configValue: GateConfig
  let configPath: string | null
  let configHash: string
  if (input.config !== undefined && input.config !== null) {
    configValue = normalizeGateConfig(input.config)
    configPath = input.configPath ?? null
    configHash = input.configHash ?? gateConfigHash(configValue)
  } else if (input.configPath !== undefined || input.configFile !== undefined) {
    const loaded = loadGateConfig(input.configFile !== undefined ? { file: input.configFile } : {})
    configValue = loaded.config
    configPath = loaded.path
    configHash = input.configHash ?? loaded.hash
  } else {
    const loaded = loadGateConfig()
    configValue = loaded.config
    configPath = loaded.path
    configHash = input.configHash ?? loaded.hash
  }
  const runs = loadRunsForGate(input.baselineRunId, input.candidateRunId, db)
  const outcome = evaluateGate({ ...runs, config: configValue, override: input.override ?? null })
  const gateId = newId('gate')
  const createdAt = now()
  const gate: Gate = {
    id: gateId,
    baselineRunId: input.baselineRunId,
    candidateRunId: input.candidateRunId,
    config: configValue,
    result: outcome.result,
    createdAt,
  }
  const provenance = buildProvenance(
    {
      baselineRun: runs.baselineRun,
      candidateRun: runs.candidateRun,
      configPath,
      configHash,
      notes: outcome.result.warnings,
    },
    { db }
  )
  const artifact = buildGateArtifact({ gate, outcome, provenance, configPath, configHash })
  const artifacts = writeGateArtifacts(artifact, {
    ...(input.dataDir !== undefined ? { dataDir: input.dataDir } : {}),
  })
  db.prepare(
    `INSERT INTO gates(id, baseline_run_id, candidate_run_id, config_json, result_json, artifact_md, artifact_html, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    gate.id,
    gate.baselineRunId,
    gate.candidateRunId,
    JSON.stringify(gate.config),
    JSON.stringify(gate.result),
    renderGateMarkdown(artifact),
    renderGateHtml(artifact),
    gate.createdAt
  )
  return { ...gate, artifacts, artifact }
}

export type GateArtifactFormat = 'md' | 'json' | 'html'

export type GateArtifactPayload = {
  format: GateArtifactFormat
  contentType: string
  filename: string
  body: string
}

/** Read a stored artifact. HTML/Markdown come from the DB; JSON from the on-disk gate.json. */
export const getGateArtifact = (
  gateId: string,
  format: GateArtifactFormat = 'md',
  options: { db?: Db; dataDir?: string } = {}
): GateArtifactPayload => {
  const db = options.db ?? getDb()
  const row = db.prepare('SELECT * FROM gates WHERE id = ?').get(gateId) as GateRow | undefined
  if (!row) {
    throw new BusinessError(`gate not found: ${gateId}`, 'gate_not_found', 404)
  }
  const paths = gateArtifactPaths(row.candidate_run_id, options.dataDir ?? config.dataDir)
  if (format === 'html') {
    const body = row.artifact_html ?? renderGateHtmlFallback(mapGateRow(row))
    return { format, contentType: 'text/html; charset=utf-8', filename: 'review.html', body }
  }
  if (format === 'md') {
    const body = row.artifact_md ?? renderGateMarkdownFallback(mapGateRow(row))
    return { format, contentType: 'text/markdown; charset=utf-8', filename: 'gate.md', body }
  }
  if (existsSync(paths.jsonPath)) {
    const body = readFileSync(paths.jsonPath, 'utf8')
    return { format, contentType: 'application/json; charset=utf-8', filename: 'gate.json', body }
  }
  return {
    format,
    contentType: 'application/json; charset=utf-8',
    filename: 'gate.json',
    body: `${JSON.stringify({ version: 1, gate: mapGateRow(row) }, null, 2)}\n`,
  }
}

const renderGateHtmlFallback = (gate: Gate): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Stella gate ${escapeHtml(gate.id)}</title><style>body{font:15px/1.5 system-ui,sans-serif;background:#0f1115;color:#e8eaf0;padding:32px;max-width:900px;margin:0 auto}</style></head><body><h1>Stella release gate — ${gate.result.pass ? 'PASS' : 'FAIL'}</h1><p>Baseline <code>${escapeHtml(gate.baselineRunId)}</code> → candidate <code>${escapeHtml(gate.candidateRunId)}</code></p><p>Checked ${escapeHtml(isoTime(gate.result.checkedAt))}. Full artifact is regenerated on the next gate run.</p></body></html>`

const renderGateMarkdownFallback = (gate: Gate): string =>
  `# Release gate — ${gate.result.pass ? 'PASS' : 'FAIL'}\n\n- Baseline: \`${gate.baselineRunId}\`\n- Candidate: \`${gate.candidateRunId}\`\n- Checked: ${isoTime(gate.result.checkedAt)}\n`
