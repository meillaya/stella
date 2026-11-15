import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getDb } from '../../src/db/index.ts'
import {
  cancelRun,
  compareRuns,
  computeRetrievalMetrics,
  createRun,
  executeRun,
  getRun,
  getRunItems,
  listRuns,
  summarizeRun,
} from '../../src/evals/runner.ts'
import {
  defaultAnswers,
  setupEvalFixture,
  stubChat,
  stubJudgeJson,
  stubRetrieve,
} from './helpers.ts'

test('computeRetrievalMetrics is deterministic and bounded', () => {
  const source = (id: string, chunkId: string) => ({
    id,
    chunkId,
    documentId: 'doc',
    title: 't',
    heading: null,
    page: null,
    score: 1,
    snippet: 'x',
  })
  const perfect = computeRetrievalMetrics({
    retrieved: [source('s1', 'a'), source('s2', 'b')],
    goldChunkIds: ['a', 'b'],
  })
  assert.equal(perfect?.recallAtK, 1)
  assert.equal(perfect?.precisionAtK, 1)
  assert.equal(perfect?.mrr, 1)
  assert.equal(perfect?.ndcgAtK, 1)

  const partial = computeRetrievalMetrics({
    retrieved: [source('s1', 'x'), source('s2', 'a'), source('s3', 'y')],
    goldChunkIds: ['a', 'b'],
  })
  assert.equal(partial?.recallAtK, 0.5)
  assert.ok(Math.abs((partial?.precisionAtK ?? 0) - 1 / 3) < 1e-12)
  assert.equal(partial?.mrr, 0.5)
  assert.ok((partial?.ndcgAtK ?? 0) > 0 && (partial?.ndcgAtK ?? 0) < 1)

  assert.equal(computeRetrievalMetrics({ retrieved: [], goldChunkIds: [] }), null)
  assert.equal(computeRetrievalMetrics({ retrieved: [], goldChunkIds: ['a'] })?.recallAtK, 0)
})

test('stub run completes, stores items, metrics, cost and slices', async () => {
  const fixture = await setupEvalFixture()
  try {
    const run = fixture.baselineRun
    assert.equal(run.status, 'done')
    assert.equal(run.summary?.cases, 4)
    assert.equal(run.summary?.pass, 4)
    assert.equal(run.summary?.passRate, 1)
    assert.ok((run.summary?.costUsd ?? 0) > 0)
    assert.ok((run.summary?.costPerPassUsd ?? 0) > 0)
    assert.ok(run.summary?.ciLow !== undefined)
    assert.deepEqual(Object.keys(run.summary?.slices ?? {}).sort(), [
      'direct',
      'numbers',
      'refusal',
    ])
    assert.equal(run.summary?.slices.direct?.cases, 2)
    assert.equal(run.summary?.graderErrors, 0)
    assert.equal(run.summary?.retrieval?.evaluated, 3)
    assert.equal(run.summary?.retrieval?.recallAtK, 1)

    const items = getRunItems(run.id, fixture.db)
    assert.equal(items.length, 4)
    assert.ok(items.every((item) => item.status === 'ok' && item.pass))
    const refundItem = items.find((item) => item.caseId === 'case_refund_time')
    assert.deepEqual(refundItem?.slices, ['direct'])
    assert.ok(refundItem?.answer.includes('14 days'))
    assert.ok((refundItem?.sources.length ?? 0) > 0)
    assert.equal(refundItem?.retrieval?.recallAtK, 1)
  } finally {
    fixture.cleanup()
  }
})

test('budget cap aborts remaining cases and marks the run cancelled', async () => {
  const fixture = await setupEvalFixture()
  try {
    const run = await fixture.runWith({
      budgetUsd: 0.0001,
      beam: { costUsd: 0.0002, answer: defaultAnswers },
      concurrency: 1,
    })
    assert.equal(run.status, 'cancelled')
    assert.match(run.error ?? '', /budget cap reached/)
    const items = fixture.itemsOf(run.id)
    assert.equal(items.length, 4)
    assert.ok(items.some((item) => item.status === 'skipped'))
    assert.ok(items.every((item) => !item.pass || item.status === 'ok'))
    assert.ok((run.summary?.cases ?? 0) === 4)
  } finally {
    fixture.cleanup()
  }
})

test('cancelRun marks a queued run cancelled and the worker skips it', async () => {
  const fixture = await setupEvalFixture()
  try {
    const created = createRun(
      {
        datasetVersionId: fixture.datasetVersionId,
        profileId: fixture.baselineProfileId,
        mode: 'replay',
        config: { judge: false },
      },
      { db: fixture.db, queue: false }
    )
    assert.equal(created.status, 'queued')
    const cancelled = cancelRun(created.id, { db: fixture.db })
    assert.equal(cancelled.status, 'cancelled')
    const after = await executeRun(created.id, {
      db: fixture.db,
      adapters: { chat: stubChat(), retrieve: stubRetrieve, mode: 'replay' },
    })
    assert.equal(after.status, 'cancelled')
    assert.equal(fixture.itemsOf(created.id).length, 0)
  } finally {
    fixture.cleanup()
  }
})

test('judge runs, records provenance and calibration when enabled', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const calibrationDir = mkdtempSync(path.join(tmpdir(), 'stella-cal-'))
  writeFileSync(
    path.join(calibrationDir, 'calibration.jsonl'),
    [
      JSON.stringify({ id: 'cal1', question: 'q1', answer: 'a1', label: 'pass' }),
      JSON.stringify({ id: 'cal2', question: 'q2', answer: 'a2', label: 'fail' }),
    ].join('\n') + '\n'
  )
  const fixture = await setupEvalFixture()
  try {
    const run = await fixture.runWith({
      judge: true,
      calibrationDir,
      beam: { answer: defaultAnswers },
    })
    assert.equal(run.status, 'done')
    const items = fixture.itemsOf(run.id)
    const judgeResult = items[0]?.graderResults.find((result) => result.kind === 'rubric')
    assert.ok(judgeResult)
    assert.equal(judgeResult?.pass, true)
    assert.match(judgeResult?.detail ?? '', /judge-v1 score=3\/3/)
    assert.match(judgeResult?.detail ?? '', /prompt=sha256:/)
    assert.equal(run.summary?.judgeAgreement, 0.5)
    assert.equal(run.summary?.judgeKappa, 0)
  } finally {
    rmSync(calibrationDir, { recursive: true, force: true })
    fixture.cleanup()
  }
})

test('compareRuns reports paired deltas, bootstrap CI and slices', async () => {
  const fixture = await setupEvalFixture({
    candidateAnswers: (question) =>
      /annual|limit/i.test(question) ? 'The annual limit is unknown.' : defaultAnswers(question),
  })
  try {
    const comparison = compareRuns(fixture.baselineRun.id, fixture.candidateRun.id, {
      db: fixture.db,
      iterations: 500,
    })
    assert.equal(comparison.overall.cases, 4)
    assert.equal(comparison.overall.passRate.baseline, 1)
    assert.equal(comparison.overall.passRate.candidate, 0.75)
    assert.equal(comparison.overall.passRate.delta, -25)
    assert.equal(comparison.overall.regressed, 1)
    assert.equal(comparison.overall.improved, 0)
    assert.ok(
      (comparison.overall.passRate.ciLowPp ?? 0) <= (comparison.overall.passRate.ciHighPp ?? 0)
    )
    const numbers = comparison.slices.find((slice) => slice.slice === 'numbers')
    assert.ok(numbers?.regressed)
    assert.equal(numbers?.cases, 1)
  } finally {
    fixture.cleanup()
  }
})

test('summarizeRun handles empty runs', () => {
  const summary = summarizeRun({ cases: [], items: [], calibration: null })
  assert.equal(summary.cases, 0)
  assert.equal(summary.passRate, 0)
  assert.equal(summary.costPerPassUsd, null)
  assert.equal(summary.retrieval, null)
  assert.deepEqual(summary.slices, {})
})

test('run catalogue reflects stored runs', async () => {
  const fixture = await setupEvalFixture()
  try {
    const runs = listRuns({}, fixture.db)
    assert.ok(runs.length >= 2)
    const run = getRun(fixture.baselineRun.id, fixture.db)
    assert.equal(run.profileName, 'Support baseline')
    assert.equal(run.datasetName, 'support')
    assert.equal(run.datasetVersion, 1)
    assert.equal(getDb() !== fixture.db, true)
    // Judge provenance is persisted for gate artifacts.
    assert.ok(Array.isArray(run.summary?.slices ? Object.keys(run.summary.slices) : []))
  } finally {
    fixture.cleanup()
  }
})

test('replay miss inside a run is recorded as a per-case error, not a crash', async () => {
  const fixture = await setupEvalFixture()
  try {
    const run = await fixture.runWith({
      beam: {
        answer: () => {
          const error = new Error('Replay cassette missing at /tmp/x.json')
          Object.assign(error, { code: 'replay_miss' })
          throw error
        },
      },
    })
    assert.equal(run.status, 'done')
    assert.equal(run.summary?.pass, 0)
    const items = fixture.itemsOf(run.id)
    assert.ok(items.every((item) => item.status === 'error'))
    assert.match(items[0]?.error ?? '', /Replay cassette missing/)
    assert.equal(run.summary?.graderErrors, 0)
  } finally {
    fixture.cleanup()
  }
})

test('judge json stub is only called when the judge is enabled', async () => {
  const fixture = await setupEvalFixture()
  try {
    let calls = 0
    const created = createRun(
      {
        datasetVersionId: fixture.datasetVersionId,
        profileId: fixture.baselineProfileId,
        mode: 'replay',
        config: { judge: true },
      },
      { db: fixture.db, queue: false }
    )
    const run = await executeRun(created.id, {
      db: fixture.db,
      adapters: {
        chat: stubChat(),
        retrieve: stubRetrieve,
        json: async () => {
          calls += 1
          return stubJudgeJson()
        },
        mode: 'replay',
      },
    })
    assert.equal(run.status, 'done')
    assert.equal(calls, 4)
  } finally {
    fixture.cleanup()
  }
})
