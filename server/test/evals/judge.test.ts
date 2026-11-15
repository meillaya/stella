import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { DatasetCase, JudgeSpec } from '../../../shared/types.ts'
import {
  JUDGE_MAX_ATTEMPTS,
  JUDGE_PROMPT_HASH,
  JUDGE_RUBRIC_ID,
  buildJudgeInput,
  calibrationLabelMatches,
  judgeAnswer,
  judgeProvenance,
  loadCalibrationSet,
  runJudgeCalibration,
} from '../../src/evals/judge.ts'

const spec: JudgeSpec = { rubric: 'judge-v1', passScore: 2, model: 'deepseek-flash' }

const caseValue: DatasetCase = {
  id: 'case_1',
  slices: ['direct'],
  messages: [{ role: 'user', content: 'How long do refunds take?' }],
  expected: {
    answer: 'Refunds take 14 days.',
    behavior: 'answer',
    mustContain: ['14 days'],
    mustNotContain: ['30 days'],
    anchors: [{ doc: 'refunds.md' }],
    minCitations: 1,
  },
}

const jsonOk = async (): Promise<unknown> => ({
  score: 3,
  pass: true,
  reason: 'Correct and cited.',
  unsupported_claims: [],
})

test('judge provenance is deterministic and hashed', () => {
  const provenance = judgeProvenance(spec)
  assert.equal(provenance.rubric, JUDGE_RUBRIC_ID)
  assert.equal(provenance.model, 'deepseek-flash')
  assert.equal(provenance.modelVersion, 'DeepSeek-V4.1-Flash-1017')
  assert.equal(provenance.passScore, 2)
  assert.equal(provenance.temperature, 0)
  assert.equal(provenance.thinking, false)
  assert.match(provenance.promptHash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(provenance.promptHash, JUDGE_PROMPT_HASH)
})

test('buildJudgeInput includes the rubric inputs and pass score', () => {
  const input = buildJudgeInput({
    case: caseValue,
    answer: 'Refunds take 14 days [s1].',
    sources: [
      {
        id: 's1',
        chunkId: 'chunk_1',
        documentId: 'doc_1',
        title: 'Refund policy',
        heading: 'Timing',
        page: null,
        score: 1,
        snippet: 'Refunds are processed within 14 days.',
      },
    ],
    spec,
  })
  assert.match(input, /Question:\nHow long do refunds take\?/)
  assert.match(input, /Expected behavior: answer/)
  assert.match(input, /Reference answer:\nRefunds take 14 days\./)
  assert.match(input, /Must contain:\n- 14 days/)
  assert.match(input, /Must not contain:\n- 30 days/)
  assert.match(input, /\[s1\] Refund policy — Timing/)
  assert.match(input, /passScore = 2/)
})

test('judgeAnswer maps a valid score onto a passing rubric result', async () => {
  const outcome = await judgeAnswer(
    { case: caseValue, answer: 'Refunds take 14 days [s1].', sources: [], spec },
    jsonOk
  )
  assert.equal(outcome.result.kind, 'rubric')
  assert.equal(outcome.result.pass, true)
  assert.equal(outcome.result.score, 1)
  assert.match(outcome.result.detail ?? '', /judge-v1 score=3\/3/)
  assert.match(outcome.result.detail ?? '', /prompt=sha256:/)
  assert.equal(outcome.meta.error, null)
  assert.equal(outcome.meta.rawScore, 3)
  assert.equal(outcome.meta.attempts, 1)
})

test('a low score below passScore fails the rubric grader', async () => {
  const outcome = await judgeAnswer(
    { case: caseValue, answer: 'Refunds take 30 days.', sources: [], spec },
    async () => ({ score: 1, pass: false, reason: 'Contradicts the reference.' })
  )
  assert.equal(outcome.result.pass, false)
  assert.equal(outcome.result.score, 1 / 3)
})

test('judge retries invalid JSON twice, then records a grader error that never passes', async () => {
  let calls = 0
  const outcome = await judgeAnswer(
    { case: caseValue, answer: 'Refunds take 14 days [s1].', sources: [], spec },
    async () => {
      calls += 1
      return 'this is not json'
    }
  )
  assert.equal(calls, JUDGE_MAX_ATTEMPTS)
  assert.equal(outcome.result.pass, false)
  assert.ok(outcome.result.error)
  assert.equal(outcome.meta.attempts, JUDGE_MAX_ATTEMPTS)
  assert.equal(outcome.meta.rawScore, null)
})

test('judge recovers when a later attempt returns valid JSON', async () => {
  let calls = 0
  const outcome = await judgeAnswer(
    { case: caseValue, answer: 'Refunds take 14 days [s1].', sources: [], spec },
    async () => {
      calls += 1
      return calls < JUDGE_MAX_ATTEMPTS
        ? { score: 9, pass: true }
        : { score: 2, pass: true, reason: 'ok' }
    }
  )
  assert.equal(calls, JUDGE_MAX_ATTEMPTS)
  assert.equal(outcome.result.pass, true)
  assert.equal(outcome.meta.attempts, JUDGE_MAX_ATTEMPTS)
})

test('replay misses fail fast instead of retrying a missing cassette', async () => {
  let calls = 0
  const outcome = await judgeAnswer(
    { case: caseValue, answer: 'x', sources: [], spec },
    async () => {
      calls += 1
      const error = new Error('Replay cassette missing at /tmp/none.json')
      Object.assign(error, { code: 'replay_miss' })
      throw error
    }
  )
  assert.equal(calls, 1)
  assert.equal(outcome.result.pass, false)
  assert.match(outcome.result.error ?? '', /cassette missing/)
})

test('loadCalibrationSet reads valid items and reports invalid lines', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stella-cal-'))
  try {
    writeFileSync(
      path.join(dir, '0001.jsonl'),
      [
        JSON.stringify({ id: 'a', question: 'q1', answer: 'a1', label: 'pass' }),
        JSON.stringify({ id: 'b', question: 'q2', answer: 'a2', label: 'maybe' }),
        '{bad json}',
        JSON.stringify({ id: 'c', question: 'q3', answer: 'a3', label: 'fail', notes: 'n' }),
      ].join('\n') + '\n'
    )
    const set = loadCalibrationSet({ dir })
    assert.equal(set.items.length, 2)
    assert.equal(set.issues.length, 2)
    assert.ok(set.path?.endsWith('0001.jsonl'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('judge calibration computes agreement and Cohen kappa', async () => {
  const verdicts = new Map<string, unknown>([
    ['a', { score: 3, pass: true, reason: 'ok' }],
    ['b', { score: 3, pass: true, reason: 'ok' }],
    ['c', { score: 0, pass: false, reason: 'bad' }],
    ['d', { score: 1, pass: false, reason: 'bad' }],
  ])
  let call = 0
  const calibration = await runJudgeCalibration({
    items: [
      { id: 'a', question: 'q1', answer: 'a1', label: 'pass' },
      { id: 'b', question: 'q2', answer: 'a2', label: 'fail' },
      { id: 'c', question: 'q3', answer: 'a3', label: 'fail' },
      { id: 'd', question: 'q4', answer: 'a4', label: 'pass' },
    ],
    source: 'datasets/calibration/0001.jsonl',
    spec,
    json: async () => verdicts.get(['a', 'b', 'c', 'd'][call++] as string),
  })
  assert.equal(calibration.items, 4)
  assert.equal(calibration.evaluated, 4)
  assert.equal(calibration.errors, 0)
  assert.equal(calibration.agreement, 0.5)
  assert.equal(calibration.kappa, 0)
  assert.equal(calibration.pairs[1]?.predicted, 'pass')
  assert.equal(calibration.provenance.rubric, 'judge-v1')
  assert.equal(calibrationLabelMatches('pass', 'PASS '), true)
})

test('judge calibration excludes errored items from agreement', async () => {
  const calibration = await runJudgeCalibration({
    items: [
      { id: 'a', question: 'q1', answer: 'a1', label: 'pass' },
      { id: 'b', question: 'q2', answer: 'a2', label: 'fail' },
    ],
    spec,
    json: async () => {
      const error = new Error('Replay cassette missing')
      Object.assign(error, { code: 'replay_miss' })
      throw error
    },
  })
  assert.equal(calibration.errors, 2)
  assert.equal(calibration.evaluated, 0)
  assert.equal(calibration.agreement, null)
  assert.equal(calibration.kappa, null)
})
