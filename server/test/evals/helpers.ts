/**
 * Shared fixtures for the eval runner/gate tests: an in-memory DB with a tiny
 * retrieval corpus, a 4-case dataset snapshot, the demo profiles, stub provider
 * adapters and helpers to execute runs without any network access.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { DatasetCase, Run, RunItem, TokenUsage } from '../../../shared/types.ts'
import { openDatabase, type Db } from '../../src/db/index.ts'
import type { EvalChatFn, EvalRetrieveFn } from '../../src/evals/adapters.ts'
import {
  createDataset,
  importDatasetJsonl,
  serializeCasesJsonl,
  snapshotDataset,
} from '../../src/evals/datasets.ts'
import { seedProfiles } from '../../src/evals/profiles.ts'
import { createRun, executeRun } from '../../src/evals/runner.ts'

export const CHUNK_REFUND = 'chunk_refund_timing'
export const CHUNK_ANNUAL = 'chunk_annual_limit'

const FIXTURE_CASES: DatasetCase[] = [
  {
    id: 'case_refund_time',
    slices: ['direct'],
    messages: [{ role: 'user', content: 'How long do refunds take?' }],
    expected: {
      answer: 'Refunds are processed within 14 days.',
      behavior: 'answer',
      mustContain: ['14 days'],
      mustNotContain: ['30 days'],
      anchors: [{ doc: 'corpus/meridian/policies/refunds.md', heading: 'Refund timing' }],
      minCitations: 1,
    },
  },
  {
    id: 'case_annual_limit',
    slices: ['numbers'],
    messages: [{ role: 'user', content: 'What is the annual request limit?' }],
    expected: {
      answer: 'The annual limit is 500 requests.',
      behavior: 'answer',
      mustContain: ['500'],
      mustNotContain: [],
      anchors: [{ doc: 'Plan limits', heading: 'Annual limits' }],
      minCitations: 1,
    },
  },
  {
    id: 'case_unanswerable',
    slices: ['refusal'],
    messages: [{ role: 'user', content: 'What is the CEO private phone number?' }],
    expected: {
      answer: '',
      behavior: 'refuse',
      mustContain: [],
      mustNotContain: [],
      anchors: [],
      minCitations: 0,
    },
  },
  {
    id: 'case_refund_check',
    slices: ['direct'],
    messages: [{ role: 'user', content: 'Can I get a refund after cancelling?' }],
    expected: {
      answer: 'Refunds are processed within 14 days.',
      behavior: 'answer',
      mustContain: ['14 days'],
      mustNotContain: [],
      anchors: [{ doc: 'Refund policy', heading: 'Refund timing' }],
      minCitations: 1,
    },
  },
]

const seedCorpus = (db: Db): void => {
  const timestamp = Date.now()
  db.prepare(
    'INSERT INTO collections(id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run('col_meridian', 'meridian', 'fixture corpus', timestamp, timestamp)
  const insertDoc = db.prepare(
    `INSERT INTO documents(id, collection_id, source_type, uri, title, content_hash, bytes, page_count, meta_json, created_at)
     VALUES (?, 'col_meridian', 'file', ?, ?, ?, 100, 1, '{}', ?)`
  )
  insertDoc.run(
    'doc_refunds',
    'corpus/meridian/policies/refunds.md',
    'Refund policy',
    'hash_refunds',
    timestamp
  )
  insertDoc.run(
    'doc_plans',
    'corpus/meridian/pricing/plans.md',
    'Plan limits',
    'hash_plans',
    timestamp
  )
  const insertChunk = db.prepare(
    `INSERT INTO chunks(id, document_id, collection_id, ordinal, text, breadcrumb, page_from, page_to, char_start, char_end, token_est)
     VALUES (?, ?, 'col_meridian', ?, ?, ?, NULL, NULL, 0, 0, 20)`
  )
  insertChunk.run(
    CHUNK_REFUND,
    'doc_refunds',
    0,
    '### Refund timing\nRefunds are processed within 14 days of approval.',
    'Refund policy > Refund timing'
  )
  insertChunk.run(
    'chunk_refund_eligibility',
    'doc_refunds',
    1,
    '### Eligibility\nRefunds require an active subscription.',
    'Refund policy > Eligibility'
  )
  insertChunk.run(
    CHUNK_ANNUAL,
    'doc_plans',
    0,
    '### Annual limits\nThe annual limit is 500 requests on the Team plan.',
    'Plan limits > Annual limits'
  )
}

export const questionFromPrompt = (content: string): string => {
  const marker = content.lastIndexOf('Question: ')
  if (marker === -1) {
    return content
  }
  return content.slice(marker + 'Question: '.length).trim()
}

export type StubBehaviour = {
  /** Answer text for a question; defaults cover all fixture cases. */
  answer: (question: string) => string
  latencyMs?: number
  costUsd?: number
}

export const defaultAnswers = (question: string): string => {
  if (/refund/i.test(question)) {
    return 'Refunds are processed within 14 days of approval [s1].'
  }
  if (/annual|limit/i.test(question)) {
    return 'The annual limit is 500 requests [s1].'
  }
  if (/CEO|phone/i.test(question)) {
    return "I don't know based on the provided sources."
  }
  return 'I do not know the answer to that question.'
}

/** Chat stub: returns answers without a provider call. */
export const stubChat = (behaviour: Partial<StubBehaviour> = {}): EvalChatFn => {
  const answer = behaviour.answer ?? defaultAnswers
  return async (request) => {
    const last = request.messages[request.messages.length - 1]
    const question = questionFromPrompt(last?.content ?? '')
    const usage: TokenUsage = {
      inputTokens: 120,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 24,
    }
    return {
      text: answer(question),
      thinking: null,
      usage,
      costUsd: behaviour.costUsd ?? 0.0002,
      latencyMs: behaviour.latencyMs ?? 20,
      provider: 'replay',
    }
  }
}

/** Retrieval stub over the fixture corpus, with deterministic s1 ids. */
export const stubRetrieve: EvalRetrieveFn = async (request) => {
  const timestamp = Date.now()
  const make = (chunkId: string, title: string, heading: string, text: string) => ({
    id: 's1',
    chunkId,
    documentId: chunkId.startsWith('chunk_refund') ? 'doc_refunds' : 'doc_plans',
    title,
    heading,
    page: null,
    score: 1,
    snippet: text,
    text,
  })
  const chunks = /refund/i.test(request.query)
    ? [
        make(
          CHUNK_REFUND,
          'Refund policy',
          'Refund timing',
          'Refunds are processed within 14 days of approval.'
        ),
      ]
    : /annual|limit/i.test(request.query)
      ? [
          make(
            CHUNK_ANNUAL,
            'Plan limits',
            'Annual limits',
            'The annual limit is 500 requests on the Team plan.'
          ),
        ]
      : []
  void timestamp
  return { chunks, collectionId: 'col_meridian', latencyMs: 3 }
}

/** Calibration json stub used when runs enable the judge. */
export const stubJudgeJson = async (): Promise<unknown> => ({
  score: 3,
  pass: true,
  reason: 'Matches the reference answer and cites the source.',
  unsupported_claims: [],
})

export type EvalFixture = {
  db: Db
  datasetsDir: string
  dataDir: string
  datasetVersionId: string
  baselineProfileId: string
  candidateProfileId: string
  baselineRun: Run
  candidateRun: Run
  cleanup: () => void
  runWith: (options: {
    profileId?: string
    beam?: StubBehaviour
    budgetUsd?: number
    datasetVersionId?: string
    judge?: boolean
    concurrency?: number
    calibrationDir?: string
  }) => Promise<Run>
  itemsOf: (runId: string) => RunItem[]
}

export const setupEvalFixture = async (
  options: { candidateAnswers?: (question: string) => string } = {}
): Promise<EvalFixture> => {
  const db = openDatabase(':memory:')
  const datasetsDir = mkdtempSync(path.join(tmpdir(), 'stella-eval-ds-'))
  const dataDir = mkdtempSync(path.join(tmpdir(), 'stella-eval-data-'))
  seedCorpus(db)
  const dataset = createDataset({ name: 'support', description: 'fixture suite' }, db)
  importDatasetJsonl(dataset.id, serializeCasesJsonl(FIXTURE_CASES), db)
  const snapshot = snapshotDataset(dataset.id, { notes: 'fixture' }, { db, datasetsDir })
  const profiles = seedProfiles({ db, collection: 'meridian', activate: true })
  const runWith: EvalFixture['runWith'] = async (runOptions) => {
    const created = createRun(
      {
        datasetVersionId: runOptions.datasetVersionId ?? snapshot.version.id,
        profileId: runOptions.profileId ?? profiles.baseline.id,
        ...(runOptions.budgetUsd !== undefined ? { budgetUsd: runOptions.budgetUsd } : {}),
        mode: 'replay',
        config: { judge: runOptions.judge === true, calibration: runOptions.judge === true },
      },
      { db, queue: false }
    )
    const executed = await executeRun(created.id, {
      db,
      concurrency: runOptions.concurrency ?? 2,
      ...(runOptions.calibrationDir !== undefined
        ? { calibrationDir: runOptions.calibrationDir }
        : {}),
      ...(runOptions.judge !== undefined ? { judge: runOptions.judge } : {}),
      adapters: {
        chat: stubChat(runOptions.beam ?? {}),
        retrieve: stubRetrieve,
        json: stubJudgeJson,
        mode: 'replay',
      },
    })
    return executed
  }
  const baselineRun = await runWith({
    beam: { answer: defaultAnswers },
  })
  const candidateRun = await runWith({
    beam: options.candidateAnswers
      ? { answer: options.candidateAnswers }
      : { answer: defaultAnswers },
  })
  const fixture: EvalFixture = {
    db,
    datasetsDir,
    dataDir,
    datasetVersionId: snapshot.version.id,
    baselineProfileId: profiles.baseline.id,
    candidateProfileId: profiles.improved.id,
    baselineRun,
    candidateRun,
    cleanup: () => {
      db.close()
      rmSync(datasetsDir, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    },
    runWith,
    itemsOf: (runId: string) => {
      const rows = db
        .prepare(
          `SELECT ri.*, c.data_json AS data_json FROM run_items ri
           JOIN runs r ON r.id = ri.run_id
           LEFT JOIN cases c ON c.dataset_id = r.dataset_id AND c.case_key = ri.case_id
           WHERE ri.run_id = ? ORDER BY ri.rowid ASC`
        )
        .all(runId) as {
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
        usage: JSON.parse(row.usage_json) as TokenUsage,
        costUsd: row.cost_usd,
        latencyMs: row.latency_ms,
        sources: JSON.parse(row.sources_json) as RunItem['sources'],
        graderResults: JSON.parse(row.grader_results_json) as RunItem['graderResults'],
        pass: row.pass === 1,
        retrieval: row.retrieval_json
          ? (JSON.parse(row.retrieval_json) as RunItem['retrieval'])
          : null,
        error: row.error,
      }))
    },
  }
  return fixture
}

export const fixtureCases = (): DatasetCase[] => FIXTURE_CASES.map((item) => ({ ...item }))
