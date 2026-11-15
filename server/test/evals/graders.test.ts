import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DatasetCase, GraderConfig, SourceRef } from '../../../shared/types.ts'
import {
  buildCaseGraders,
  checkCitations,
  countGraderErrors,
  extractCitationRefs,
  extractJsonText,
  gradeOne,
  isRefusal,
  itemPassed,
  normalizeForMatch,
  runGraders,
  type GradeContext,
} from '../../src/evals/graders.ts'

const source = (id: string, chunkId: string): SourceRef => ({
  id,
  chunkId,
  documentId: 'doc',
  title: 'Doc',
  heading: null,
  page: null,
  score: 1,
  snippet: 'text',
})

const context = (overrides: Partial<GradeContext> = {}): GradeContext => ({
  case: {
    id: 'c1',
    slices: [],
    messages: [{ role: 'user', content: 'q' }],
    expected: {
      behavior: 'answer',
      mustContain: [],
      mustNotContain: [],
      anchors: [],
      minCitations: 0,
    },
  },
  answer: 'Refunds are processed within 14 days [s1].',
  sources: [source('s1', 'chunk_1'), source('s2', 'chunk_2')],
  usage: { inputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 5 },
  costUsd: 0.001,
  latencyMs: 120,
  model: 'deepseek-flash',
  ...overrides,
})

const grader = (
  kind: GraderConfig['kind'],
  config: Record<string, unknown> = {}
): GraderConfig => ({
  id: `${kind}:0`,
  kind,
  name: kind,
  required: true,
  config,
})

test('normalizeForMatch canonicalizes case, quotes, dashes and whitespace', () => {
  assert.equal(normalizeForMatch('  “Refund”\n\tTiming — 14  DAYS '), '"refund" timing - 14 days')
})

test('contains and not_contains are normalized substring checks', () => {
  const contains = gradeOne(grader('contains', { value: 'WITHIN 14 days' }), context())
  assert.equal(contains.pass, true)
  const missing = gradeOne(grader('contains', { value: '30 days' }), context())
  assert.equal(missing.pass, false)
  assert.match(missing.detail ?? '', /30 days/)
  const notContains = gradeOne(grader('not_contains', { value: '30 days' }), context())
  assert.equal(notContains.pass, true)
  const forbidden = gradeOne(grader('not_contains', { value: '14 DAYS' }), context())
  assert.equal(forbidden.pass, false)
})

test('regex grader supports flags and reports invalid patterns as errors', () => {
  assert.equal(
    gradeOne(grader('regex', { pattern: '\\b14 days\\b', flags: 'i' }), context()).pass,
    true
  )
  assert.equal(gradeOne(grader('regex', { pattern: '^nope$' }), context()).pass, false)
  const invalid = gradeOne(grader('regex', { pattern: '([' }), context())
  assert.equal(invalid.pass, false)
  assert.ok(invalid.error)
})

test('json_valid parses fenced JSON and validates optional schemas', () => {
  const fenced = context({ answer: 'Here you go:\n```json\n{"ok": true, "count": 2}\n```' })
  assert.equal(extractJsonText(fenced.answer), '{"ok": true, "count": 2}')
  assert.equal(gradeOne(grader('json_valid'), fenced).pass, true)
  const schema = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] }
  assert.equal(gradeOne(grader('json_valid', { schema }), fenced).pass, true)
  const bad = context({ answer: '{"ok": true}' })
  const schemaFailure = gradeOne(grader('json_valid', { schema }), bad)
  assert.equal(schemaFailure.pass, false)
  assert.match(schemaFailure.detail ?? '', /schema/)
  assert.equal(gradeOne(grader('json_valid'), context({ answer: 'not json at all' })).pass, false)
})

test('citation refs are extracted and validated against injected sources', () => {
  assert.deepEqual(extractCitationRefs('One [s1], two [S2], three [s1, s2], link [text](url)'), [
    's1',
    's2',
    's1',
    's2',
  ])
  assert.deepEqual(extractCitationRefs('no citations here'), [])
  const check = checkCitations('A [s1] and B [s2] but C [s9]', context().sources)
  assert.equal(check.validCount, 2)
  assert.deepEqual(check.invalid, ['s9'])
  const invalid = gradeOne(
    grader('citation_valid', { requireCitation: true }),
    context({ answer: 'claim [s9]' })
  )
  assert.equal(invalid.pass, false)
  assert.match(invalid.detail ?? '', /unresolved/)
  assert.equal(
    gradeOne(
      grader('citation_valid', { requireCitation: true }),
      context({ answer: 'no bracket refs' })
    ).pass,
    false
  )
  const minFailure = gradeOne(grader('citation_valid', { minCitations: 2 }), context())
  assert.equal(minFailure.pass, false)
})

test('min_citations counts distinct valid refs', () => {
  assert.equal(gradeOne(grader('min_citations', { min: 1 }), context()).pass, true)
  assert.equal(gradeOne(grader('min_citations', { min: 3 }), context()).pass, false)
  assert.equal(
    gradeOne(grader('min_citations', { min: 1 }), context({ answer: 'no citations' })).pass,
    false
  )
})

test('refusal_expected distinguishes grounded refusals from answers', () => {
  const refusal = "I don't know; the provided sources do not contain that information."
  assert.equal(isRefusal(refusal), true)
  assert.equal(isRefusal('Refunds take 14 days [s1].'), false)
  assert.equal(isRefusal("I'm sorry, I cannot answer that."), true)
  assert.equal(
    gradeOne(grader('refusal_expected', { expectRefusal: true }), context({ answer: refusal }))
      .pass,
    true
  )
  assert.equal(
    gradeOne(
      grader('refusal_expected', { expectRefusal: true }),
      context({ answer: 'The answer is 14.' })
    ).pass,
    false
  )
  assert.equal(
    gradeOne(
      grader('refusal_expected', { expectRefusal: false }),
      context({ answer: 'The answer is 14.' })
    ).pass,
    true
  )
  assert.equal(
    gradeOne(grader('refusal_expected', { expectRefusal: false }), context({ answer: refusal }))
      .pass,
    false
  )
})

test('cost and latency ceilings compare against grader context', () => {
  assert.equal(gradeOne(grader('max_cost_usd', { max: 0.01 }), context()).pass, true)
  assert.equal(gradeOne(grader('max_cost_usd', { max: 0.0001 }), context()).pass, false)
  assert.equal(gradeOne(grader('max_latency_ms', { max: 200 }), context()).pass, true)
  assert.equal(gradeOne(grader('max_latency_ms', { max: 50 }), context()).pass, false)
})

test('judge-only grader kinds never pass through the deterministic runner', () => {
  for (const kind of ['rubric', 'faithfulness', 'answer_relevance'] as const) {
    const result = gradeOne(grader(kind), context())
    assert.equal(result.pass, false)
    assert.match(result.error ?? '', /judge runner/)
  }
})

test('itemPassed requires required graders and never accepts grader errors', () => {
  const graders = [
    grader('contains', { value: '14 days' }),
    { ...grader('regex', { pattern: 'x' }), required: false },
  ]
  const results = runGraders(graders, context())
  assert.equal(itemPassed(graders, results), true)
  const withError = [grader('regex', { pattern: '([' })]
  assert.equal(itemPassed(withError, runGraders(withError, context())), false)
  assert.equal(countGraderErrors(runGraders(withError, context())), 1)
  const missing = itemPassed([grader('contains', { value: 'x' })], [])
  assert.equal(missing, false)
})

test('buildCaseGraders derives a plan from case expectations and run config', () => {
  const caseValue: DatasetCase = {
    id: 'c1',
    slices: ['direct'],
    messages: [{ role: 'user', content: 'q' }],
    expected: {
      behavior: 'answer',
      mustContain: ['14 days'],
      mustNotContain: ['30 days'],
      anchors: [{ doc: 'refunds.md' }],
      minCitations: 1,
    },
  }
  const plan = buildCaseGraders({
    case: caseValue,
    maxCostUsd: 0.01,
    maxLatencyMs: 5000,
    extra: [grader('regex', { pattern: 'days' })],
  })
  const kinds = plan.map((entry) => entry.kind)
  assert.deepEqual(kinds, [
    'contains',
    'not_contains',
    'citation_valid',
    'min_citations',
    'refusal_expected',
    'max_cost_usd',
    'max_latency_ms',
    'regex',
  ])
  assert.ok(plan.every((entry) => entry.required))

  const refusalPlan = buildCaseGraders({
    case: {
      ...caseValue,
      expected: {
        ...caseValue.expected,
        behavior: 'refuse',
        mustContain: [],
        anchors: [],
        minCitations: 0,
      },
    },
  })
  const refusal = refusalPlan.find((entry) => entry.kind === 'refusal_expected')
  assert.equal(refusal?.config.expectRefusal, true)
})
