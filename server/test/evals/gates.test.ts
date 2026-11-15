import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { DatasetCase, GraderResult, Run, RunItem, RunSummary } from '../../../shared/types.ts'
import {
  DEFAULT_GATE_CONFIG,
  createGate,
  evaluateGate,
  gateArtifactPaths,
  gateConfigHash,
  getGate,
  getGateArtifact,
  listGates,
  loadGateConfig,
  normalizeGateConfig,
} from '../../src/evals/gates.ts'
import { setupEvalFixture } from './helpers.ts'

const summaryOf = (input: {
  cases: number
  pass: number
  costUsd?: number
  p95?: number
}): RunSummary => ({
  cases: input.cases,
  pass: input.pass,
  passRate: input.cases === 0 ? 0 : input.pass / input.cases,
  ciLow: 0,
  ciHigh: 1,
  costUsd: input.costUsd ?? 0.01,
  costPerPassUsd: input.pass === 0 ? null : (input.costUsd ?? 0.01) / input.pass,
  p50LatencyMs: 100,
  p95LatencyMs: input.p95 ?? 250,
  graderErrors: 0,
  judgeAgreement: null,
  judgeKappa: null,
  retrieval: null,
  slices: {},
})

const makeRun = (id: string, pass: number, cases: number, overrides: Partial<Run> = {}): Run => ({
  id,
  datasetId: 'ds_support',
  datasetName: 'support',
  datasetVersion: 1,
  profileId: `prof_${id}`,
  profileName: `profile ${id}`,
  provider: 'replay',
  mode: 'replay',
  status: 'done',
  budgetUsd: 0,
  createdAt: 1,
  startedAt: 2,
  finishedAt: 3,
  summary: summaryOf({ cases, pass }),
  error: null,
  ...overrides,
})

const graderPass = (id: string): GraderResult => ({ graderId: id, kind: 'contains', pass: true })

const makeItem = (
  caseId: string,
  pass: boolean,
  slices: string[],
  graderResults: GraderResult[] = []
): RunItem => ({
  id: `item_${caseId}`,
  runId: 'run',
  caseId,
  slices,
  status: 'ok',
  answer: pass ? 'ok' : 'wrong',
  usage: { inputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 5 },
  costUsd: 0.001,
  latencyMs: 100,
  sources: [],
  graderResults: graderResults.length > 0 ? graderResults : [graderPass('contains:0')],
  pass,
  retrieval: null,
  error: null,
})

const makeCase = (id: string, slices: string[]): DatasetCase => ({
  id,
  slices,
  messages: [{ role: 'user', content: 'q' }],
  expected: {
    behavior: 'answer',
    mustContain: [],
    mustNotContain: [],
    anchors: [],
    minCitations: 0,
  },
})

const baseConfig = () =>
  normalizeGateConfig({
    suite: 'support',
    minCases: 3,
    thresholds: {
      passRate: 0.8,
      faithfulness: 0.7,
      citationValidity: 0.9,
      refusalAccuracy: 0.8,
      maxCostPerCaseUsd: 0.02,
      maxP95LatencyMs: 5000,
    },
  })

const evaluate = (input: {
  baselineItems: RunItem[]
  candidateItems: RunItem[]
  cases?: DatasetCase[]
  config?: ReturnType<typeof baseConfig>
  override?: { reason?: string; by?: string | null } | null
  candidateRun?: Run
  baselineRun?: Run
}) => {
  const cases =
    input.cases ?? input.candidateItems.map((item) => makeCase(item.caseId, item.slices))
  const baselineItems = input.baselineItems
  const candidateItems = input.candidateItems
  return evaluateGate({
    baselineRun:
      input.baselineRun ??
      makeRun('run_base', baselineItems.filter((item) => item.pass).length, baselineItems.length),
    baselineItems,
    baselineCases: cases,
    candidateRun:
      input.candidateRun ??
      makeRun('run_cand', candidateItems.filter((item) => item.pass).length, candidateItems.length),
    candidateItems,
    candidateCases: cases,
    config: input.config ?? baseConfig(),
    override: input.override ?? null,
  })
}

test('gate passes when thresholds, regressions and judge rules hold', () => {
  const items = [
    makeItem('a', true, ['direct']),
    makeItem('b', true, ['direct']),
    makeItem('c', true, ['numbers']),
  ]
  const outcome = evaluate({ baselineItems: items, candidateItems: items })
  assert.equal(outcome.result.pass, true)
  // Unmeasured metrics (no judge => no faithfulness) are warnings, not failures.
  assert.equal(outcome.result.verdict, 'warn')
  assert.deepEqual(outcome.result.failures, [])
  assert.equal(outcome.candidate.passRate, 1)
  assert.equal(outcome.paired.deltaPp, 0)
})

test('threshold failures are reported with actual and expected values', () => {
  const baseline = [
    makeItem('a', true, ['direct']),
    makeItem('b', true, ['direct']),
    makeItem('c', true, ['direct']),
  ]
  const candidate = [
    makeItem('a', false, ['direct']),
    makeItem('b', true, ['direct']),
    makeItem('c', true, ['direct']),
  ]
  const outcome = evaluate({ baselineItems: baseline, candidateItems: candidate })
  assert.equal(outcome.result.pass, false)
  assert.equal(outcome.result.verdict, 'fail')
  const rule = outcome.result.failures.find((entry) => entry.rule === 'threshold_pass_rate')
  assert.ok(rule)
  assert.ok(Math.abs((rule?.actual as number) - 2 / 3) < 1e-12)
  assert.equal(rule?.expected, 0.8)
})

test('overall regression beyond the allowed drop fails the gate', () => {
  const cases = ['a', 'b', 'c', 'd']
  const baseline = cases.map((id) => makeItem(id, true, ['direct']))
  const candidate = cases.map((id, index) => makeItem(id, index > 0, ['direct']))
  const config = baseConfig()
  config.thresholds.passRate = 0.5
  const outcome = evaluate({ baselineItems: baseline, candidateItems: candidate, config })
  assert.equal(outcome.paired.deltaPp, -25)
  const failure = outcome.result.failures.find((entry) => entry.rule === 'regression_overall')
  assert.ok(failure)
  assert.equal(failure?.actual, -25)
  assert.equal(failure?.expected, -2)
})

test('slice regressions respect minSliceCases', () => {
  const baseline: RunItem[] = []
  const candidate: RunItem[] = []
  for (let index = 0; index < 4; index += 1) {
    const id = `direct_${index}`
    baseline.push(makeItem(id, true, ['direct']))
    candidate.push(makeItem(id, false, ['direct']))
  }
  for (let index = 0; index < 2; index += 1) {
    const id = `small_${index}`
    baseline.push(makeItem(id, true, ['small']))
    candidate.push(makeItem(id, false, ['small']))
  }
  const config = baseConfig()
  config.thresholds.passRate = 0.1
  config.regression.overallMaxDropPp = 100
  config.regression.sliceMaxDropPp = 10
  config.regression.minSliceCases = 3
  const outcome = evaluate({ baselineItems: baseline, candidateItems: candidate, config })
  const sliceFailures = outcome.result.failures.filter((entry) =>
    entry.rule.startsWith('regression_slice:')
  )
  assert.deepEqual(
    sliceFailures.map((entry) => entry.rule),
    ['regression_slice:direct']
  )
  const slices = outcome.slices.map((slice) => slice.slice)
  assert.deepEqual(slices, ['direct', 'small'])
  assert.equal(outcome.slices.find((slice) => slice.slice === 'direct')?.regressed, true)
  assert.equal(outcome.slices.find((slice) => slice.slice === 'small')?.regressed, false)
})

test('judge rules: required calibration, minimum agreement and grader errors', () => {
  const items = [
    makeItem('a', true, ['direct']),
    makeItem('b', true, ['direct']),
    makeItem('c', true, ['direct']),
  ]
  const config = baseConfig()
  config.judge = { requireCalibration: true, minAgreement: 0.6, maxGraderErrorsPct: 5 }
  const noCalibration = evaluate({ baselineItems: items, candidateItems: items, config })
  assert.ok(noCalibration.result.failures.some((entry) => entry.rule === 'judge_calibration'))

  const lowAgreement = evaluate({
    baselineItems: items,
    candidateItems: items,
    config,
    candidateRun: makeRun('run_cand', 3, 3, {
      summary: { ...summaryOf({ cases: 3, pass: 3 }), judgeAgreement: 0.4, judgeKappa: 0.1 },
    }),
  })
  assert.ok(lowAgreement.result.failures.some((entry) => entry.rule === 'judge_agreement'))

  const errored = items.map((item, index) => ({
    ...item,
    graderResults: [
      {
        graderId: 'judge:judge-v1',
        kind: 'rubric' as const,
        pass: false,
        error: 'judge failed',
        detail: 'x',
      },
      ...(index === 0 ? [] : []),
    ],
  }))
  const errorsOutcome = evaluate({ baselineItems: items, candidateItems: errored, config })
  assert.ok(errorsOutcome.result.failures.some((entry) => entry.rule === 'grader_errors'))
})

test('unmeasured thresholds warn instead of failing', () => {
  const items = [
    makeItem('a', true, ['direct']),
    makeItem('b', true, ['direct']),
    makeItem('c', true, ['direct']),
  ]
  const outcome = evaluate({ baselineItems: items, candidateItems: items })
  assert.equal(outcome.result.pass, true)
  assert.ok(outcome.result.warnings.some((warning) => warning.includes('faithfulness')))
  assert.equal(outcome.result.verdict, 'warn')
})

test('override requires a reason and allowed config; overridden gate passes', () => {
  const baseline = ['a', 'b', 'c', 'd'].map((id) => makeItem(id, true, ['direct']))
  const candidate = ['a', 'b', 'c', 'd'].map((id, index) => makeItem(id, index !== 0, ['direct']))
  const failing = evaluate({ baselineItems: baseline, candidateItems: candidate })
  assert.equal(failing.result.pass, false)

  const withoutReason = evaluate({
    baselineItems: baseline,
    candidateItems: candidate,
    override: {},
  })
  assert.equal(withoutReason.result.pass, false)

  const overridden = evaluate({
    baselineItems: baseline,
    candidateItems: candidate,
    override: { reason: 'known flaky provider incident, tracking SEV-12', by: 'release-manager' },
  })
  assert.equal(overridden.result.pass, true)
  assert.equal(overridden.result.verdict, 'warn')
  assert.equal(overridden.result.override?.by, 'release-manager')
  assert.ok(overridden.result.failures.length > 0)

  const config = baseConfig()
  config.overrides.allowed = false
  const disabled = evaluate({
    baselineItems: baseline,
    candidateItems: candidate,
    config,
    override: { reason: 'please' },
  })
  assert.equal(disabled.result.pass, false)
  assert.ok(disabled.result.failures.some((entry) => entry.rule === 'override'))
})

test('normalizeGateConfig merges defaults and validates values', () => {
  const config = normalizeGateConfig({ suite: 'demo', thresholds: { passRate: 0.9 } })
  assert.equal(config.suite, 'demo')
  assert.equal(config.minCases, DEFAULT_GATE_CONFIG.minCases)
  assert.equal(config.thresholds.passRate, 0.9)
  assert.equal(config.thresholds.citationValidity, DEFAULT_GATE_CONFIG.thresholds.citationValidity)
  assert.throws(() => normalizeGateConfig({ thresholds: { passRate: 2 } }), /passRate/)
  assert.throws(() => normalizeGateConfig('nope'), /JSON object/)
  assert.equal(
    new Set([
      gateConfigHash(config),
      gateConfigHash(normalizeGateConfig({ suite: 'demo', thresholds: { passRate: 0.9 } })),
    ]).size,
    1
  )
})

test('loadGateConfig reads stella.gate.json, rejects invalid JSON and falls back to defaults', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'stella-gate-cfg-'))
  try {
    const defaults = loadGateConfig({ root })
    assert.equal(defaults.path, null)
    assert.match(defaults.hash, /^sha256:/)

    writeFileSync(
      path.join(root, 'stella.gate.json'),
      JSON.stringify({ suite: 'support', minCases: 12 })
    )
    const loaded = loadGateConfig({ root })
    assert.equal(loaded.config.minCases, 12)
    assert.ok(loaded.path?.endsWith('stella.gate.json'))

    writeFileSync(path.join(root, 'stella.gate.json'), '{oops')
    assert.throws(() => loadGateConfig({ root }), /not valid JSON/)

    assert.throws(() => loadGateConfig({ file: path.join(root, 'missing.json') }), /not found/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('createGate persists artifacts: self-contained HTML, gate.json and gate.md', async () => {
  const fixture = await setupEvalFixture()
  const calibrationDir = mkdtempSync(path.join(tmpdir(), 'stella-cal-empty-'))
  try {
    const judgedBaseline = await fixture.runWith({ judge: true, calibrationDir })
    const judgedCandidate = await fixture.runWith({ judge: true, calibrationDir })
    const config = normalizeGateConfig({
      suite: 'support',
      minCases: 3,
      thresholds: {
        passRate: 0.8,
        faithfulness: 0.7,
        citationValidity: 0.9,
        refusalAccuracy: 0.8,
        maxCostPerCaseUsd: 0.02,
        maxP95LatencyMs: 60_000,
      },
    })
    const gate = createGate(
      {
        baselineRunId: judgedBaseline.id,
        candidateRunId: judgedCandidate.id,
        config,
        dataDir: fixture.dataDir,
      },
      { db: fixture.db }
    )
    assert.equal(gate.result.pass, true)
    assert.equal(gate.result.verdict, 'pass')
    const paths = gateArtifactPaths(judgedCandidate.id, fixture.dataDir)
    assert.equal(gate.artifacts.htmlPath, paths.htmlPath)
    assert.ok(existsSync(paths.mdPath))
    assert.ok(existsSync(paths.jsonPath))
    assert.ok(existsSync(paths.htmlPath))
    const html = readFileSync(paths.htmlPath, 'utf8')
    assert.match(html, /<!doctype html>/i)
    assert.match(html, /Release gate review/)
    assert.match(html, /<style>/)
    assert.doesNotMatch(html, /<link[^>]+href=/i)
    assert.doesNotMatch(html, /https?:\/\//)
    assert.doesNotMatch(html, /<script/i)
    const md = readFileSync(paths.mdPath, 'utf8')
    assert.match(md, /# Release gate — PASS/)
    const artifact = JSON.parse(readFileSync(paths.jsonPath, 'utf8')) as Record<string, unknown>
    assert.equal((artifact.gate as { candidateRunId: string }).candidateRunId, judgedCandidate.id)
    assert.match(JSON.stringify(artifact), /sha256:/)

    const stored = getGate(gate.id, fixture.db)
    assert.equal(stored.result.pass, true)
    assert.equal(listGates({}, fixture.db).length, 1)
    for (const format of ['md', 'json', 'html'] as const) {
      const payload = getGateArtifact(gate.id, format, { db: fixture.db, dataDir: fixture.dataDir })
      assert.ok(payload.body.length > 100)
      if (format === 'html') {
        assert.match(payload.contentType, /^text\/html/)
      }
    }
  } finally {
    rmSync(calibrationDir, { recursive: true, force: true })
    fixture.cleanup()
  }
})

test('createGate fails and explains regressions for a worse candidate', async () => {
  const fixture = await setupEvalFixture({
    candidateAnswers: (question) =>
      /refund/i.test(question) ? 'Refunds are never processed.' : 'I do not know.',
  })
  try {
    const config = normalizeGateConfig({ suite: 'support', minCases: 3 })
    const gate = createGate(
      { baselineRunId: fixture.baselineRun.id, candidateRunId: fixture.candidateRun.id, config },
      { db: fixture.db }
    )
    assert.equal(gate.result.pass, false)
    assert.equal(gate.result.verdict, 'fail')
    assert.ok(gate.result.failures.length > 0)
    const html = readFileSync(gate.artifacts.htmlPath, 'utf8')
    assert.match(html, /FAIL/)
    assert.match(html, /Failing cases/)

    const overridden = createGate(
      {
        baselineRunId: fixture.baselineRun.id,
        candidateRunId: fixture.candidateRun.id,
        config,
        override: { reason: 'incident in provider; accepted by release manager', by: 'eval-dev' },
      },
      { db: fixture.db }
    )
    assert.equal(overridden.result.pass, true)
    assert.match(overridden.result.override?.reason ?? '', /incident/)
    assert.equal(listGates({}, fixture.db).length, 2)
  } finally {
    fixture.cleanup()
  }
})
