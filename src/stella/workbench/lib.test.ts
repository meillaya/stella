import { describe, expect, it } from 'vitest'
import type { DatasetCase, Gate, Run, RunItem, RunSummary } from '../../../shared/types.js'
import {
  anchorDrift,
  buildSweepVariants,
  buildTracesPath,
  caseToDraft,
  cleanQuestionText,
  draftToCase,
  extractQuestion,
  filterRunItems,
  formatUsd,
  gateReadiness,
  parseCommaList,
  passRateDeltaPp,
  resolvePreflightStats,
  runElapsedMs,
  sweepVariantSpec,
  validateCaseDraft,
} from './lib.js'

const runSummary: RunSummary = {
  cases: 20,
  pass: 17,
  passRate: 0.85,
  ciLow: 0.64,
  ciHigh: 0.95,
  costUsd: 0.2,
  costPerPassUsd: 0.0118,
  p50LatencyMs: 900,
  p95LatencyMs: 4200,
  graderErrors: 1,
  judgeAgreement: 0.9,
  judgeKappa: 0.7,
  retrieval: null,
  slices: {},
}

const makeRun = (overrides: Partial<Run> = {}): Run => ({
  id: 'run_1',
  datasetId: 'ds_1',
  datasetName: 'Support',
  datasetVersion: 2,
  profileId: 'prof_1',
  profileName: 'Support baseline',
  provider: 'replay',
  mode: 'replay',
  status: 'done',
  budgetUsd: 2,
  createdAt: 1000,
  startedAt: 1100,
  finishedAt: 2100,
  summary: runSummary,
  error: null,
  ...overrides,
})

const makeGate = (overrides: Partial<Gate> = {}): Gate => ({
  id: 'gate_1',
  baselineRunId: 'run_base',
  candidateRunId: 'run_1',
  config: {
    suite: 'support@1',
    minCases: 10,
    thresholds: {
      passRate: 0.85,
      faithfulness: 0.8,
      citationValidity: 0.9,
      refusalAccuracy: 0.8,
      maxCostPerCaseUsd: 0.05,
      maxP95LatencyMs: 8000,
    },
    regression: { overallMaxDropPp: 3, sliceMaxDropPp: 8, minSliceCases: 5 },
    judge: { requireCalibration: true, minAgreement: 0.7, maxGraderErrorsPct: 10 },
    overrides: { allowed: true, requireReason: true },
  },
  result: {
    pass: true,
    verdict: 'pass',
    failures: [],
    warnings: [],
    checkedAt: 2200,
    override: null,
  },
  createdAt: 2200,
  ...overrides,
})

const makeItem = (overrides: Partial<RunItem> = {}): RunItem => ({
  id: 'item_1',
  runId: 'run_1',
  caseId: 'case_1',
  slices: ['billing'],
  status: 'ok',
  answer: 'An answer',
  usage: { inputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 5 },
  costUsd: 0.001,
  latencyMs: 800,
  sources: [],
  graderResults: [],
  pass: true,
  retrieval: null,
  error: null,
  ...overrides,
})

const makeCase = (): DatasetCase => ({
  id: 'case_1',
  datasetId: 'ds_1',
  slices: ['billing', 'refunds'],
  messages: [
    { role: 'system', content: 'You are support.' },
    { role: 'user', content: 'How long do refunds take?' },
  ],
  expected: {
    answer: 'Up to five business days.',
    behavior: 'answer',
    mustContain: ['five business days'],
    mustNotContain: ['instant'],
    anchors: [{ doc: 'policies/refunds.md', heading: 'Timing', quote: 'five business days' }],
    minCitations: 1,
  },
  notes: 'From a real trace.',
})

describe('trace helpers', () => {
  it('builds a trace path and omits empty filters', () => {
    expect(buildTracesPath({ limit: 50, q: '  ', feedback: '', status: '', profileId: '' })).toBe(
      '/api/traces?limit=50'
    )
    expect(
      buildTracesPath({ limit: 100, q: 'refund & tax', feedback: 'down', status: 'ok', profileId: 'prof_1' })
    ).toBe('/api/traces?limit=100&q=refund+%26+tax&feedback=down&status=ok&profileId=prof_1')
  })

  it('removes the injected retrieval block from display text', () => {
    const question = 'What is the refund window?'
    const context =
      '<retrieved_sources>\n[1] Billing\n## Refunds\n\n14 days\n</retrieved_sources>\n\nUse these retrieved sources when they are relevant, and cite them by bracket number, e.g. [1].'
    expect(cleanQuestionText(`${question}\n${context}`)).toBe(question)
    expect(
      extractQuestion({
        messages: [{ role: 'user', content: [{ type: 'text', text: question }, { type: 'text', text: context }] }],
      })
    ).toBe(question)
  })

  it('extracts the last user message from content blocks', () => {
    expect(extractQuestion({ messages: [{ role: 'system', content: 'hello' }] })).toBe('')
    expect(
      extractQuestion({
        messages: [
          { role: 'user', content: 'first' },
          { role: 'user', content: [{ type: 'text', text: 'latest' }, { type: 'text', text: 'question' }] },
        ],
      })
    ).toBe('latest question')
    expect(extractQuestion(null)).toBe('')
  })
})

describe('gate readiness', () => {
  it('does not invent a verdict without a run or gate', () => {
    expect(gateReadiness(null, null).verdict).toBe('NO RUNS')
    expect(gateReadiness(makeRun(), null)).toMatchObject({ verdict: 'NOT GATED', tone: 'warn' })
    expect(gateReadiness(makeRun(), makeGate({ candidateRunId: 'run_other' })).verdict).toBe('NOT GATED')
  })

  it('reports a passing gate and the first blocking failure', () => {
    expect(gateReadiness(makeRun(), makeGate())).toMatchObject({ verdict: 'PASS', tone: 'pass' })
    expect(
      gateReadiness(
        makeRun(),
        makeGate({
          result: {
            pass: false,
            verdict: 'fail',
            failures: [{ rule: 'passRate', message: 'pass rate below threshold', actual: 0.7, expected: 0.85 }],
            warnings: [],
            checkedAt: 2200,
            override: null,
          },
        })
      )
    ).toMatchObject({
      verdict: 'BLOCKED',
      tone: 'fail',
      why: 'pass rate below threshold',
    })
  })

  it('shows an override as a pass with an explanation', () => {
    expect(
      gateReadiness(
        makeRun(),
        makeGate({
          result: {
            pass: true,
            verdict: 'pass',
            failures: [],
            warnings: [],
            checkedAt: 2200,
            override: { reason: 'known index gap', by: 'mei' },
          },
        })
      )
    ).toMatchObject({ verdict: 'PASS', tone: 'warn', why: 'Released with an override: known index gap' })
  })
})

describe('formatting', () => {
  it('keeps sub-cent costs readable', () => {
    expect(formatUsd(null)).toBe('—')
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0.00042)).toBe('$0.0004')
    expect(formatUsd(0.042)).toBe('$0.042')
    expect(formatUsd(12.345)).toBe('$12.35')
  })

  it('derives the pass-rate delta in percentage points from summaries', () => {
    expect(passRateDeltaPp(makeRun(), makeRun({ id: 'run_base', summary: { ...runSummary, passRate: 0.5 } }))).toBe(
      35
    )
    expect(passRateDeltaPp(makeRun(), null)).toBeNull()
  })

  it('measures elapsed run time only once started', () => {
    expect(runElapsedMs(makeRun({ finishedAt: null }), 3000)).toBe(1900)
    expect(runElapsedMs(makeRun(), 3000)).toBe(1000)
    expect(runElapsedMs(makeRun({ startedAt: null, finishedAt: null }))).toBeNull()
  })
})

describe('case editors', () => {
  it('parses and deduplicates comma-separated values', () => {
    expect(parseCommaList(' billing, refunds ,, billing ')).toEqual(['billing', 'refunds'])
    expect(parseCommaList('')).toEqual([])
  })

  it('round-trips a case through the editor draft', () => {
    const original = makeCase()
    const draft = caseToDraft(original)
    expect(draft.question).toBe('How long do refunds take?')
    expect(draft.anchors[0]).toEqual({
      doc: 'policies/refunds.md',
      heading: 'Timing',
      quote: 'five business days',
    })
    const next = draftToCase(
      { ...draft, slices: 'billing, refunds, billing', minCitations: '2' },
      { id: original.id, datasetId: 'ds_1', existing: original }
    )
    expect(next.messages).toHaveLength(2)
    expect(next.messages[0]).toEqual({ role: 'system', content: 'You are support.' })
    expect(next.slices).toEqual(['billing', 'refunds'])
    expect(next.expected.minCitations).toBe(2)
    expect(next.expected.anchors[0]?.quote).toBe('five business days')
  })

  it('rejects a draft without a question or with a bad citation count', () => {
    expect(validateCaseDraft(caseToDraft(makeCase()))).toBeNull()
    expect(validateCaseDraft({ ...caseToDraft(makeCase()), question: '  ' })).toMatch(/question/i)
    expect(validateCaseDraft({ ...caseToDraft(makeCase()), minCitations: '1.5' })).toMatch(/citations/i)
  })

  it('summarizes anchor drift', () => {
    expect(anchorDrift({ resolved: 3, total: 3, missing: [] })).toMatchObject({ tone: 'pass' })
    expect(anchorDrift({ resolved: 2, total: 3, missing: ['policies/refunds.md'] })).toMatchObject({
      tone: 'fail',
      detail: '1 anchor no longer matches the corpus: policies/refunds.md',
    })
    expect(anchorDrift({ resolved: 0, total: 0, missing: [] })).toMatchObject({ label: 'No anchors' })
  })
})

describe('runs and sweeps', () => {
  it('filters run items by failure or transport error', () => {
    const items = [
      makeItem(),
      makeItem({ id: 'item_2', pass: false }),
      makeItem({ id: 'item_3', pass: false, status: 'error' }),
    ]
    expect(filterRunItems(items, 'all')).toHaveLength(3)
    expect(filterRunItems(items, 'failed').map((item) => item.id)).toEqual(['item_2', 'item_3'])
    expect(filterRunItems(items, 'errors').map((item) => item.id)).toEqual(['item_3'])
  })

  it('builds sweep variants and changes only retrieval', () => {
    const variants = buildSweepVariants([3, 6], ['off', 'llm'])
    expect(variants.map((variant) => variant.label)).toEqual([
      'k=3 · rerank off',
      'k=3 · rerank llm',
      'k=6 · rerank off',
      'k=6 · rerank llm',
    ])
    const base = {
      model: { id: 'deepseek-flash' as const, thinking: true, maxTokens: 4096 },
      retrieval: {
        enabled: true,
        collection: 'support',
        k: 4,
        candidates: 12,
        rerank: 'off' as const,
        contextBudgetTokens: 6000,
        parentExpansion: true,
      },
      prompt: { template: 'rag-v1' as const, citationStyle: 'bracket' as const },
      judge: { rubric: 'judge-v1' as const, passScore: 0.7 },
    }
    const next = sweepVariantSpec(base, 8, 'llm')
    expect(next.retrieval).toMatchObject({ k: 8, candidates: 12, rerank: 'llm' })
    expect(next.model).toEqual(base.model)
    expect(base.retrieval.k).toBe(4)
  })
})

describe('fine-tuning preflight', () => {
  it('merges direct and nested stats and lists findings', () => {
    const stats = resolvePreflightStats({
      stats: { examples: 120, duplicates: 4, contamination: 2 },
      report: { train: 1 },
      contamination: 0,
      issues: [{ severity: 'warning', message: '2 records contain email addresses' }],
      warnings: ['holdout is small'],
    })
    expect(stats.examples).toBe(120)
    expect(stats.duplicates).toBe(4)
    expect(stats.contamination).toBe(2)
  })
})
