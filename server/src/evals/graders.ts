/**
 * Deterministic graders plus the grader-plan builder.
 *
 * Graders are pure functions over one answered case: no network, no time
 * dependency, stable output order. LLM rubric/factuality grading lives in
 * `judge.ts`; a grader config of kind `rubric`/`faithfulness`/`answer_relevance`
 * must go through the judge runner, never this module.
 */

import { Ajv, type ValidateFunction } from 'ajv'
import type {
  DatasetCase,
  GraderConfig,
  GraderKind,
  GraderResult,
  SourceRef,
  TokenUsage,
} from '../../../shared/types.ts'

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true })
const validators = new Map<string, ValidateFunction>()

const validatorFor = (schema: Record<string, unknown>): ValidateFunction => {
  const key = JSON.stringify(schema)
  const cached = validators.get(key)
  if (cached) {
    return cached
  }
  const validator = ajv.compile(schema)
  validators.set(key, validator)
  return validator
}

/* ------------------------------ text helpers ------------------------------ */

const QUOTE_MAP: Record<string, string> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u2013': '-',
  '\u2014': '-',
  '\u00a0': ' ',
}

/** Lowercase, NFC, canonical quotes/dashes and collapsed whitespace. */
export const normalizeForMatch = (value: string): string =>
  value
    .normalize('NFC')
    .replace(/[\u2018\u2019\u201c\u201d\u2013\u2014\u00a0]/g, (char) => QUOTE_MAP[char] ?? char)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const configString = (config: Record<string, unknown>, key: string): string | null => {
  const value = config[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

const configNumber = (config: Record<string, unknown>, key: string): number | null => {
  const value = config[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/* ------------------------------ refusals ------------------------------ */

const REFUSAL_PATTERNS: readonly RegExp[] = [
  /\bi (?:do not|don't) (?:know|have (?:enough|sufficient) information|have access)\b/i,
  /\bnot (?:enough|sufficient) (?:information|context|evidence|detail)\b/i,
  /\b(?:cannot|can't|can not|unable to) (?:answer|find|locate|determine|confirm|provide (?:that|this))\b/i,
  /\b(?:does not|doesn't|did not|didn't) (?:contain|mention|provide|say|include|specify)\b/i,
  /\bnot (?:mentioned|stated|specified|covered|available|provided) (?:in|within)\b/i,
  /\bnot (?:in|among) the (?:provided |available |retrieved )?sources\b/i,
  /\boutside (?:the|my) (?:provided|knowledge|sources)\b/i,
  /\bno (?:information|details?|mention) (?:is |are )?(?:available|provided)\b/i,
  /\b(?:sources|context) (?:do not|don't) (?:contain|mention|cover)\b/i,
]

/** Heuristic, deterministic refusal classifier used by `refusal_expected`. */
export const isRefusal = (answer: string): boolean => {
  const normalized = normalizeForMatch(answer)
  if (normalized.length === 0) {
    return false
  }
  if (REFUSAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true
  }
  // A short apology with no concrete claim is a refusal in practice.
  const wordCount = normalized.split(' ').length
  if (wordCount <= 40 && /^(?:i'm|i am|sorry|unfortunately)\b/.test(normalized)) {
    if (/\b(?:cannot|can't|not able|unable|do not|don't)\b/.test(normalized)) {
      return true
    }
  }
  return false
}

/* ------------------------------ citations ------------------------------ */

const REF_RE = /^s?(\d+)$/i

/** Extract bracket citation references like [s1], [S2], [1], [s1, s2]. */
export const extractCitationRefs = (answer: string): string[] => {
  const refs: string[] = []
  const bracket = /\[([^[\]\n]{1,120})\]/g
  for (const match of answer.matchAll(bracket)) {
    const inner = (match[1] ?? '').trim()
    if (inner.length === 0) {
      continue
    }
    for (const part of inner.split(/[,;\s]+/)) {
      const token = part.trim().replace(/[.。]+$/, '')
      if (REF_RE.test(token)) {
        refs.push(token.toLowerCase())
      }
    }
  }
  return refs
}

const resolveCitation = (ref: string, sources: SourceRef[]): SourceRef | null => {
  const direct = sources.find((source) => source.id.toLowerCase() === ref)
  if (direct) {
    return direct
  }
  const numeric = REF_RE.exec(ref)
  if (!numeric) {
    return null
  }
  const index = Number(numeric[1]) - 1
  return sources[index] ?? null
}

export type CitationCheck = {
  refs: string[]
  valid: string[]
  invalid: string[]
  validCount: number
}

export const checkCitations = (answer: string, sources: SourceRef[]): CitationCheck => {
  const refs = extractCitationRefs(answer)
  const valid = new Set<string>()
  const invalid = new Set<string>()
  for (const ref of refs) {
    const source = resolveCitation(ref, sources)
    if (source) {
      valid.add(ref)
    } else {
      invalid.add(ref)
    }
  }
  return { refs, valid: [...valid], invalid: [...invalid], validCount: valid.size }
}

/* ------------------------------ JSON helpers ------------------------------ */

/** Extract the most likely JSON value from a model answer (tolerates fences). */
export const extractJsonText = (answer: string): string => {
  const trimmed = answer.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fenced && fenced[1]) {
    return fenced[1].trim()
  }
  const firstObject = trimmed.indexOf('{')
  const lastObject = trimmed.lastIndexOf('}')
  if (firstObject !== -1 && lastObject > firstObject) {
    return trimmed.slice(firstObject, lastObject + 1)
  }
  const firstArray = trimmed.indexOf('[')
  const lastArray = trimmed.lastIndexOf(']')
  if (firstArray !== -1 && lastArray > firstArray) {
    return trimmed.slice(firstArray, lastArray + 1)
  }
  return trimmed
}

/* ------------------------------ grader plan ------------------------------ */

export type BuildGradersInput = {
  case: DatasetCase
  /** Run-level per-case cost ceiling in USD, from run config. */
  maxCostUsd?: number | null
  /** Run-level per-case latency ceiling in ms, from run config. */
  maxLatencyMs?: number | null
  /** Extra run-level graders appended to the case plan. */
  extra?: GraderConfig[]
}

const REQUIRED = true

/**
 * Compose the grader plan for one case from its expectations (contains,
 * not_contains, citation validity, minimum citations, refusal behavior) plus
 * optional run-level cost/latency ceilings and extra configured graders.
 */
export const buildCaseGraders = (input: BuildGradersInput): GraderConfig[] => {
  const graders: GraderConfig[] = []
  const expected = input.case.expected
  for (const [index, value] of expected.mustContain.entries()) {
    graders.push({
      id: `contains:${index}`,
      kind: 'contains',
      name: `must contain "${value}"`,
      required: REQUIRED,
      config: { value },
    })
  }
  for (const [index, value] of expected.mustNotContain.entries()) {
    graders.push({
      id: `not_contains:${index}`,
      kind: 'not_contains',
      name: `must not contain "${value}"`,
      required: REQUIRED,
      config: { value },
    })
  }
  const expectCitations = expected.minCitations > 0 || expected.anchors.length > 0
  if (expectCitations || input.extra?.some((grader) => grader.kind === 'citation_valid')) {
    graders.push({
      id: 'citation_valid',
      kind: 'citation_valid',
      name: 'bracket citations resolve to injected sources',
      required: REQUIRED,
      config: {
        minCitations: expected.minCitations,
        requireCitation: expected.minCitations > 0,
      },
    })
  }
  if (expected.minCitations > 0) {
    graders.push({
      id: 'min_citations',
      kind: 'min_citations',
      name: `at least ${expected.minCitations} citations`,
      required: REQUIRED,
      config: { min: expected.minCitations },
    })
  }
  if (expected.behavior === 'refuse' || expected.behavior === 'answer') {
    graders.push({
      id: 'refusal_expected',
      kind: 'refusal_expected',
      name: expected.behavior === 'refuse' ? 'answer refuses' : 'answer does not refuse',
      required: REQUIRED,
      config: { expectRefusal: expected.behavior === 'refuse' },
    })
  }
  if (
    typeof input.maxCostUsd === 'number' &&
    Number.isFinite(input.maxCostUsd) &&
    input.maxCostUsd > 0
  ) {
    graders.push({
      id: 'max_cost_usd',
      kind: 'max_cost_usd',
      name: `cost per case <= $${input.maxCostUsd}`,
      required: REQUIRED,
      config: { max: input.maxCostUsd },
    })
  }
  if (
    typeof input.maxLatencyMs === 'number' &&
    Number.isFinite(input.maxLatencyMs) &&
    input.maxLatencyMs > 0
  ) {
    graders.push({
      id: 'max_latency_ms',
      kind: 'max_latency_ms',
      name: `latency <= ${input.maxLatencyMs} ms`,
      required: REQUIRED,
      config: { max: input.maxLatencyMs },
    })
  }
  for (const extra of input.extra ?? []) {
    graders.push({ ...extra, config: { ...extra.config } })
  }
  return graders
}

/* ------------------------------ execution ------------------------------ */

export type GradeContext = {
  case: DatasetCase
  answer: string
  sources: SourceRef[]
  usage: TokenUsage
  costUsd: number
  latencyMs: number
  model: string
}

const pass = (grader: GraderConfig, detail: string, score?: number): GraderResult => ({
  graderId: grader.id,
  kind: grader.kind,
  pass: true,
  detail,
  ...(score !== undefined ? { score } : {}),
})

const fail = (grader: GraderConfig, detail: string, score?: number): GraderResult => ({
  graderId: grader.id,
  kind: grader.kind,
  pass: false,
  detail,
  ...(score !== undefined ? { score } : {}),
})

const errorResult = (grader: GraderConfig, error: string): GraderResult => ({
  graderId: grader.id,
  kind: grader.kind,
  pass: false,
  error,
  detail: error,
})

const runGrader = (grader: GraderConfig, context: GradeContext): GraderResult => {
  const { config } = grader
  switch (grader.kind) {
    case 'contains': {
      const values = Array.isArray(config.values)
        ? config.values
        : configString(config, 'value') !== null
          ? [configString(config, 'value')]
          : []
      if (values.length === 0) {
        return errorResult(grader, 'contains grader requires config.value')
      }
      const haystack = normalizeForMatch(context.answer)
      const missing = values.filter((value) => !haystack.includes(normalizeForMatch(String(value))))
      return missing.length === 0
        ? pass(grader, `contains ${missing.length === 0 ? 'all expected values' : ''}`.trim())
        : fail(grader, `missing: ${missing.map((value) => JSON.stringify(value)).join(', ')}`)
    }
    case 'not_contains': {
      const values = Array.isArray(config.values)
        ? config.values
        : configString(config, 'value') !== null
          ? [configString(config, 'value')]
          : []
      if (values.length === 0) {
        return errorResult(grader, 'not_contains grader requires config.value')
      }
      const haystack = normalizeForMatch(context.answer)
      const found = values.filter((value) => haystack.includes(normalizeForMatch(String(value))))
      return found.length === 0
        ? pass(grader, 'no forbidden text found')
        : fail(grader, `found forbidden: ${found.map((value) => JSON.stringify(value)).join(', ')}`)
    }
    case 'regex': {
      const pattern = configString(config, 'pattern')
      if (!pattern) {
        return errorResult(grader, 'regex grader requires config.pattern')
      }
      const flags = configString(config, 'flags') ?? ''
      const expression = new RegExp(pattern, flags)
      return expression.test(context.answer)
        ? pass(grader, `matches /${pattern}/${flags}`)
        : fail(grader, `does not match /${pattern}/${flags}`)
    }
    case 'json_valid': {
      const text = extractJsonText(context.answer)
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        return fail(
          grader,
          `answer is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      const schema = isRecord(config.schema) ? config.schema : null
      if (schema) {
        const validator = validatorFor(schema)
        if (!validator(parsed)) {
          const details = (validator.errors ?? [])
            .map((issue) => `${issue.instancePath || '/'} ${issue.message ?? 'invalid'}`)
            .slice(0, 3)
            .join('; ')
          return fail(grader, `JSON does not match schema: ${details}`)
        }
        return pass(grader, 'valid JSON matching the schema')
      }
      return pass(grader, 'valid JSON')
    }
    case 'citation_valid': {
      const check = checkCitations(context.answer, context.sources)
      const minCitations = configNumber(config, 'minCitations') ?? 0
      const requireCitation = config.requireCitation === true
      if (check.invalid.length > 0) {
        return fail(
          grader,
          `unresolved citation refs: ${check.invalid.map((ref) => `[${ref}]`).join(', ')} (injected: ${context.sources.length})`
        )
      }
      if (requireCitation && check.validCount === 0) {
        return fail(grader, 'no bracket citations found; at least one is required')
      }
      if (check.validCount < minCitations) {
        return fail(grader, `${check.validCount} valid citations < required ${minCitations}`)
      }
      return pass(grader, `${check.validCount} valid citation(s)`)
    }
    case 'min_citations': {
      const min = configNumber(config, 'min') ?? 1
      const check = checkCitations(context.answer, context.sources)
      const valid = check.validCount
      return valid >= min
        ? pass(
            grader,
            `${valid} valid citations >= ${min}`,
            min === 0 ? 1 : Math.min(1, valid / min)
          )
        : fail(grader, `${valid} valid citations < required ${min}`)
    }
    case 'refusal_expected': {
      const expectRefusal = config.expectRefusal !== false
      if (context.answer.trim().length === 0) {
        return fail(grader, 'empty answer')
      }
      const mustContain = context.case.expected.mustContain ?? []
      const normalized = normalizeForMatch(context.answer)
      const hasExpectedFact = mustContain.some((phrase) => normalized.includes(normalizeForMatch(phrase)))
      // A partial but substantive answer that happens to contain “I don't know”
      // is not a refusal when it already states an expected fact.
      const refusal = isRefusal(context.answer) && !hasExpectedFact
      const ok = expectRefusal ? refusal : !refusal
      return ok
        ? pass(grader, expectRefusal ? 'answer refuses as expected' : 'answer is a genuine attempt')
        : fail(
            grader,
            expectRefusal
              ? 'expected a refusal, got an answer'
              : 'unexpected refusal for an answerable case'
          )
    }
    case 'max_cost_usd': {
      const max = configNumber(config, 'max')
      if (max === null) {
        return errorResult(grader, 'max_cost_usd grader requires config.max')
      }
      return context.costUsd <= max
        ? pass(grader, `cost $${context.costUsd.toFixed(6)} <= $${max}`)
        : fail(grader, `cost $${context.costUsd.toFixed(6)} > $${max}`)
    }
    case 'max_latency_ms': {
      const max = configNumber(config, 'max')
      if (max === null) {
        return errorResult(grader, 'max_latency_ms grader requires config.max')
      }
      return context.latencyMs <= max
        ? pass(grader, `latency ${context.latencyMs} ms <= ${max} ms`)
        : fail(grader, `latency ${context.latencyMs} ms > ${max} ms`)
    }
    case 'rubric':
    case 'faithfulness':
    case 'answer_relevance':
      return errorResult(grader, `${grader.kind} graders must run through the judge runner`)
    default:
      return errorResult(grader, `unknown grader kind: ${String(grader.kind)}`)
  }
}

/** Run one grader, converting config/runtime errors into never-passing results. */
export const gradeOne = (grader: GraderConfig, context: GradeContext): GraderResult => {
  try {
    return runGrader(grader, context)
  } catch (error) {
    return errorResult(grader, error instanceof Error ? error.message : String(error))
  }
}

export const runGraders = (graders: GraderConfig[], context: GradeContext): GraderResult[] =>
  graders.map((grader) => gradeOne(grader, context))

/** An item passes when every required grader ran and passed (grader errors never pass). */
export const itemPassed = (graders: GraderConfig[], results: GraderResult[]): boolean => {
  for (const grader of graders) {
    if (!grader.required) {
      continue
    }
    const result = results.find((entry) => entry.graderId === grader.id)
    if (!result) {
      return false
    }
    if (result.error) {
      return false
    }
    if (!result.pass) {
      return false
    }
  }
  return true
}

export const countGraderErrors = (results: GraderResult[]): number =>
  results.filter((result) => typeof result.error === 'string' && result.error.length > 0).length

export const failedGraderNames = (graders: GraderConfig[], results: GraderResult[]): string[] => {
  const failed: string[] = []
  for (const grader of graders) {
    const result = results.find((entry) => entry.graderId === grader.id)
    if (!result) {
      failed.push(`${grader.name} (missing)`)
    } else if (!result.pass) {
      failed.push(result.error ? `${grader.name} (error: ${result.error})` : grader.name)
    }
  }
  return failed
}

/** Grep-like helper used by gate artifacts and the CLI. */
export const graderKindLabel: Record<GraderKind, string> = {
  contains: 'contains',
  not_contains: 'not contains',
  regex: 'regex',
  json_valid: 'JSON valid',
  citation_valid: 'citations valid',
  min_citations: 'minimum citations',
  refusal_expected: 'refusal behavior',
  max_cost_usd: 'cost ceiling',
  max_latency_ms: 'latency ceiling',
  faithfulness: 'faithfulness',
  answer_relevance: 'answer relevance',
  rubric: 'rubric',
}
