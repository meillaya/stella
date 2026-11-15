/**
 * LLM rubric judge (`judge-v1`) and judge calibration.
 *
 * The judge is a Responses-API JSON-schema call through the provider adapter:
 * thinking disabled, temperature 0, deterministic prompt + schema (both hashed
 * into the provenance). Invalid JSON is retried twice, then the grader is
 * recorded as an **error**, which never passes. Calibration compares judge
 * pass/fail labels with a seed-labelled calibration set and reports agreement
 * plus Cohen's kappa.
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { config } from '../config.ts'
import { cohensKappa } from '../../../shared/metrics.ts'
import { MODEL_VERSION } from '../../../shared/pricing.ts'
import type {
  DatasetCase,
  GraderResult,
  JudgeSpec,
  ModelId,
  SourceRef,
} from '../../../shared/types.ts'
import type { EvalJsonSchemaFn } from './adapters.ts'
import { errorCode, errorMessage } from './errors.ts'
import { normalizeForMatch } from './graders.ts'

export const JUDGE_RUBRIC_ID = 'judge-v1' as const
export const JUDGE_MAX_ATTEMPTS = 3
export const JUDGE_PASS_SCORE = 2

export const JUDGE_SYSTEM_PROMPT = `You are a strict evaluation judge for a retrieval-grounded assistant.

Score the candidate answer against the reference expectations on this 0-3 rubric:
- 3: fully correct, directly answers the question, grounded in the evidence, no contradictions.
- 2: mostly correct; small omission or imprecision that does not change the decision.
- 1: partially correct; a significant omission, an unsupported claim, or a wrong detail.
- 0: wrong, contradicts the evidence, ignores the question, or fabricates.

Rules:
- If the expected behavior is "refuse", a confident answer is a 0 and a clear grounded refusal is a 3.
- If expected mustContain items are missing, the score cannot be 3.
- If a mustNotContain item appears, the score cannot be 3 and should usually be 0-1.
- Judge only the candidate answer, not the writing style.
- "pass" must be true exactly when score >= the passScore given in the user message.

Return a single JSON object, no markdown:
{"score": 0-3 integer, "pass": boolean, "reason": "one or two sentences", "unsupported_claims": ["short quote", ...]}`

export const JUDGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 3 },
    pass: { type: 'boolean' },
    reason: { type: 'string', minLength: 1, maxLength: 1200 },
    unsupported_claims: { type: 'array', items: { type: 'string' }, maxItems: 8 },
  },
  required: ['score', 'pass', 'reason'],
}

/** sha256 over rubric version + system prompt + schema; stable judge provenance. */
export const JUDGE_PROMPT_HASH = `sha256:${createHash('sha256')
  .update(`${JUDGE_RUBRIC_ID}\n${JUDGE_SYSTEM_PROMPT}\n${JSON.stringify(JUDGE_SCHEMA)}`)
  .digest('hex')}`

export type JudgeProvenance = {
  rubric: 'judge-v1'
  model: ModelId
  modelVersion: string
  promptHash: string
  passScore: number
  temperature: 0
  thinking: false
}

export const judgeProvenance = (spec: JudgeSpec): JudgeProvenance => {
  const model = spec.model ?? 'deepseek-flash'
  return {
    rubric: 'judge-v1',
    model,
    modelVersion: MODEL_VERSION[model],
    promptHash: JUDGE_PROMPT_HASH,
    passScore: spec.passScore,
    temperature: 0,
    thinking: false,
  }
}

/* ------------------------------ prompt input ------------------------------ */

export type JudgeInput = {
  case: DatasetCase
  answer: string
  sources: SourceRef[]
  spec: JudgeSpec
}

const MAX_SOURCE_CHARS = 1600
const MAX_TOTAL_SOURCE_CHARS = 7000

const evidenceBlock = (sources: SourceRef[]): string => {
  if (sources.length === 0) {
    return '(no retrieved evidence was injected)'
  }
  const lines: string[] = []
  let used = 0
  for (const source of sources) {
    if (used >= MAX_TOTAL_SOURCE_CHARS) {
      break
    }
    const snippet = source.snippet.slice(0, MAX_SOURCE_CHARS)
    used += snippet.length
    const heading = source.heading ? ` — ${source.heading}` : ''
    lines.push(`[${source.id}] ${source.title}${heading}\n${snippet}`)
  }
  return lines.join('\n\n')
}

const questionOf = (input: DatasetCase): string => {
  const userMessages = input.messages.filter((message) => message.role === 'user')
  return userMessages.length > 0
    ? (userMessages[userMessages.length - 1] as { content: string }).content
    : ''
}

/** The deterministic judge user message, including passScore. */
export const buildJudgeInput = (input: JudgeInput): string => {
  const { case: caseValue, answer, sources, spec } = input
  const parts: string[] = []
  parts.push(`Question:\n${questionOf(caseValue)}`)
  parts.push(`Expected behavior: ${caseValue.expected.behavior}`)
  if (caseValue.expected.answer) {
    parts.push(`Reference answer:\n${caseValue.expected.answer}`)
  }
  if (caseValue.expected.mustContain.length > 0) {
    parts.push(`Must contain:\n- ${caseValue.expected.mustContain.join('\n- ')}`)
  }
  if (caseValue.expected.mustNotContain.length > 0) {
    parts.push(`Must not contain:\n- ${caseValue.expected.mustNotContain.join('\n- ')}`)
  }
  parts.push(`Retrieved evidence:\n${evidenceBlock(sources)}`)
  parts.push(`Candidate answer:\n${answer.length > 0 ? answer : '(empty)'}`)
  parts.push(`passScore = ${spec.passScore}`)
  parts.push('Return the JSON object now.')
  return parts.join('\n\n')
}

/* ------------------------------ judge call ------------------------------ */

export type JudgeResultMeta = {
  provenance: JudgeProvenance
  attempts: number
  latencyMs: number
  error: string | null
  rawScore: number | null
  reason: string | null
  unsupportedClaims: string[]
}

export type JudgeOutcome = { result: GraderResult; meta: JudgeResultMeta }

type NormalizedJudgeJson = {
  score: number
  pass: boolean
  reason: string
  unsupportedClaims: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const parseJudgeJson = (value: unknown, passScore: number): NormalizedJudgeJson => {
  let parsed: unknown = value
  if (typeof value === 'string') {
    const first = value.indexOf('{')
    const last = value.lastIndexOf('}')
    if (first === -1 || last <= first) {
      throw new Error('judge response is not a JSON object')
    }
    parsed = JSON.parse(value.slice(first, last + 1))
  }
  if (!isRecord(parsed)) {
    throw new Error('judge response is not a JSON object')
  }
  const score = parsed.score
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 3) {
    throw new Error(`judge score must be an integer 0-3 (got ${JSON.stringify(parsed.score)})`)
  }
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : ''
  if (reason.length === 0) {
    throw new Error('judge reason is missing')
  }
  const unsupportedClaims = Array.isArray(parsed.unsupported_claims)
    ? parsed.unsupported_claims
        .filter((claim): claim is string => typeof claim === 'string')
        .slice(0, 8)
    : []
  return {
    score,
    pass: score >= passScore,
    reason,
    unsupportedClaims,
  }
}

export const RUBRIC_GRADER_ID = `judge:${JUDGE_RUBRIC_ID}`

export const judgeGraderId = (
  kind: 'rubric' | 'faithfulness' | 'answer_relevance' = 'rubric'
): string => (kind === 'rubric' ? RUBRIC_GRADER_ID : `${RUBRIC_GRADER_ID}:${kind}`)

/**
 * Call the judge once (retrying up to {@link JUDGE_MAX_ATTEMPTS} times on
 * invalid JSON or transport errors), returning a GraderResult that never passes
 * when the judge failed.
 */
export const judgeAnswer = async (
  input: JudgeInput,
  json: EvalJsonSchemaFn,
  options: { kind?: 'rubric' | 'faithfulness' | 'answer_relevance'; graderId?: string } = {}
): Promise<JudgeOutcome> => {
  const kind = options.kind ?? 'rubric'
  const graderId = options.graderId ?? judgeGraderId(kind)
  const provenance = judgeProvenance(input.spec)
  const startedAt = Date.now()
  const userInput = buildJudgeInput(input)
  let lastError: string | null = null
  let attempts = 0
  for (let attempt = 1; attempt <= JUDGE_MAX_ATTEMPTS; attempt += 1) {
    attempts = attempt
    try {
      const response = await json({
        model: provenance.model,
        system: JUDGE_SYSTEM_PROMPT,
        input: userInput,
        schema: JUDGE_SCHEMA,
        maxTokens: 700,
        temperature: 0,
        thinking: false,
      })
      const parsed = parseJudgeJson(response, input.spec.passScore)
      const latencyMs = Date.now() - startedAt
      const normalizedScore = parsed.score / 3
      const detail = `${JUDGE_RUBRIC_ID} score=${parsed.score}/3 (pass>=${input.spec.passScore}) model=${provenance.model} ${provenance.modelVersion} prompt=${provenance.promptHash.slice(0, 19)} attempts=${attempts}${parsed.reason ? ` — ${parsed.reason}` : ''}`
      return {
        result: {
          graderId,
          kind,
          pass: parsed.pass,
          score: normalizedScore,
          detail,
          latencyMs,
        },
        meta: {
          provenance,
          attempts,
          latencyMs,
          error: null,
          rawScore: parsed.score,
          reason: parsed.reason,
          unsupportedClaims: parsed.unsupportedClaims,
        },
      }
    } catch (error) {
      lastError = errorMessage(error)
      const code = errorCode(error)
      // Replay misses and missing keys are not transient: fail fast with an
      // actionable error instead of repeating an identical failing call.
      if (code === 'replay_miss' || code === 'missing_api_key') {
        break
      }
    }
  }
  const latencyMs = Date.now() - startedAt
  const detail = `judge failed after ${attempts} attempt(s): ${lastError ?? 'unknown error'} (prompt=${provenance.promptHash.slice(0, 19)})`
  return {
    result: { graderId, kind, pass: false, detail, error: lastError ?? 'judge failed', latencyMs },
    meta: {
      provenance,
      attempts,
      latencyMs,
      error: lastError ?? 'judge failed',
      rawScore: null,
      reason: null,
      unsupportedClaims: [],
    },
  }
}

/* ------------------------------ calibration ------------------------------ */

export type CalibrationItem = {
  id: string
  question: string
  answer: string
  label: 'pass' | 'fail'
  notes?: string
}

export type CalibrationIssue = { line: number; message: string }

export type CalibrationSet = {
  items: CalibrationItem[]
  issues: CalibrationIssue[]
  path: string | null
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

export const calibrationDirectory = (datasetsDir?: string): string =>
  path.join(datasetsDir ?? config.datasetsDir, 'calibration')

/**
 * Load the newest `*.jsonl` calibration file. `dir` may point directly at a
 * calibration directory (tests, --calibration-dir); by default the newest file
 * in datasets/calibration is used.
 */
export const loadCalibrationSet = (
  options: { dir?: string; datasetsDir?: string } = {}
): CalibrationSet => {
  const directory = options.dir ?? calibrationDirectory(options.datasetsDir)
  if (!existsSync(directory)) {
    return { items: [], issues: [], path: null }
  }
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.jsonl'))
    .sort()
  if (files.length === 0) {
    return { items: [], issues: [], path: null }
  }
  const file = path.join(directory, files[files.length - 1] as string)
  const text = readFileSync(file, 'utf8')
  const items: CalibrationItem[] = []
  const issues: CalibrationIssue[] = []
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = index + 1
    const trimmed = rawLine.trim()
    if (trimmed.length === 0) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      issues.push({ line, message: `invalid JSON: ${errorMessage(error)}` })
      continue
    }
    if (!isRecord(parsed)) {
      issues.push({ line, message: 'item must be a JSON object' })
      continue
    }
    if (
      !isNonEmptyString(parsed.id) ||
      !isNonEmptyString(parsed.question) ||
      !isNonEmptyString(parsed.answer)
    ) {
      issues.push({ line, message: 'id, question and answer are required strings' })
      continue
    }
    if (parsed.label !== 'pass' && parsed.label !== 'fail') {
      issues.push({ line, message: 'label must be "pass" or "fail"' })
      continue
    }
    items.push({
      id: parsed.id,
      question: parsed.question,
      answer: parsed.answer,
      label: parsed.label,
      ...(typeof parsed.notes === 'string' ? { notes: parsed.notes } : {}),
    })
  }
  return { items, issues, path: file }
}

export type CalibrationPair = {
  id: string
  expected: 'pass' | 'fail'
  predicted: 'pass' | 'fail' | 'error'
  score: number | null
}

export type JudgeCalibration = {
  source: string | null
  items: number
  evaluated: number
  errors: number
  agreement: number | null
  kappa: number | null
  pairs: CalibrationPair[]
  provenance: JudgeProvenance
}

const calibrationCase = (item: CalibrationItem): DatasetCase => ({
  id: item.id,
  slices: ['calibration'],
  messages: [{ role: 'user', content: item.question }],
  expected: {
    behavior: 'any',
    mustContain: [],
    mustNotContain: [],
    anchors: [],
    minCitations: 0,
  },
})

/**
 * Judge the calibration set and compare with its seed labels. Agreement is the
 * raw match rate; kappa corrects for chance. Judge errors count as errors and
 * are excluded from the agreement/kappa pairs.
 */
export const runJudgeCalibration = async (
  input: {
    items: CalibrationItem[]
    source?: string | null
    spec: JudgeSpec
    json: EvalJsonSchemaFn
  },
  onItem?: (item: CalibrationItem, outcome: JudgeOutcome) => void
): Promise<JudgeCalibration> => {
  const pairs: CalibrationPair[] = []
  let errors = 0
  for (const item of input.items) {
    const outcome = await judgeAnswer(
      { case: calibrationCase(item), answer: item.answer, sources: [], spec: input.spec },
      input.json
    )
    onItem?.(item, outcome)
    if (outcome.meta.error) {
      errors += 1
      pairs.push({ id: item.id, expected: item.label, predicted: 'error', score: null })
      continue
    }
    pairs.push({
      id: item.id,
      expected: item.label,
      predicted: outcome.result.pass ? 'pass' : 'fail',
      score: outcome.meta.rawScore,
    })
  }
  const comparable = pairs.filter(
    (pair): pair is CalibrationPair & { predicted: 'pass' | 'fail' } => pair.predicted !== 'error'
  )
  const agreement =
    comparable.length === 0
      ? null
      : comparable.filter((pair) => pair.expected === pair.predicted).length / comparable.length
  const kappa =
    comparable.length === 0
      ? null
      : cohensKappa(comparable.map((pair) => [pair.expected, pair.predicted]))
  return {
    source: input.source ?? null,
    items: input.items.length,
    evaluated: comparable.length,
    errors,
    agreement,
    kappa,
    pairs,
    provenance: judgeProvenance(input.spec),
  }
}

/** Normalize text for calibration label matching (kept for future fuzzy labels). */
export const calibrationLabelMatches = (expected: string, actual: string): boolean =>
  normalizeForMatch(expected) === normalizeForMatch(actual)
