import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { DatasetCase } from '../../../shared/types.ts'
import { openDatabase } from '../../src/db/index.ts'
import {
  anchorDrift,
  canonicalCase,
  createDataset,
  importDatasetJsonl,
  latestDatasetVersion,
  listDatasetVersions,
  parseDatasetJsonl,
  readVersionCases,
  resolveCaseAnchors,
  serializeCasesJsonl,
  snapshotDataset,
  validateDatasetCase,
} from '../../src/evals/datasets.ts'

const VALID_CASE: DatasetCase = {
  id: 'case_refund_1',
  slices: ['direct'],
  messages: [{ role: 'user', content: 'How long does a refund take?' }],
  expected: {
    answer: 'Refunds are processed within 14 days.',
    behavior: 'answer',
    mustContain: ['14 days'],
    mustNotContain: ['30 days'],
    anchors: [{ doc: 'policies/refunds.md', heading: 'Refund timing', quote: 'within 14 days' }],
    minCitations: 1,
  },
}

const seedCorpus = (db: ReturnType<typeof openDatabase>): void => {
  const createdAt = Date.now()
  db.prepare(
    'INSERT INTO collections(id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run('col_1', 'meridian', 'test corpus', createdAt, createdAt)
  db.prepare(
    `INSERT INTO documents(id, collection_id, source_type, uri, title, content_hash, bytes, page_count, meta_json, created_at)
     VALUES (?, ?, 'file', ?, ?, ?, ?, ?, '{}', ?)`
  ).run(
    'doc_refunds',
    'col_1',
    'corpus/meridian/policies/refunds.md',
    'Refund policy',
    'hash_a',
    100,
    1,
    createdAt
  )
  db.prepare(
    `INSERT INTO documents(id, collection_id, source_type, uri, title, content_hash, bytes, page_count, meta_json, created_at)
     VALUES (?, ?, 'file', ?, ?, ?, ?, ?, '{}', ?)`
  ).run(
    'doc_billing',
    'col_1',
    'corpus/meridian/policies/billing.md',
    'Billing policy',
    'hash_b',
    100,
    1,
    createdAt
  )
  const insertChunk = db.prepare(
    `INSERT INTO chunks(id, document_id, collection_id, ordinal, text, breadcrumb, page_from, page_to, char_start, char_end, token_est)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, 10)`
  )
  insertChunk.run(
    'chunk_refund_1',
    'doc_refunds',
    'col_1',
    0,
    '### Refund timing\nRefunds are processed within 14 days of approval.',
    'Refund policy > Refund timing'
  )
  insertChunk.run(
    'chunk_refund_2',
    'doc_refunds',
    'col_1',
    1,
    '### Eligibility\nRefunds require an active subscription.',
    'Refund policy > Eligibility'
  )
  insertChunk.run(
    'chunk_billing_1',
    'doc_billing',
    'col_1',
    0,
    'Invoices are issued monthly.',
    'Billing policy > Invoices'
  )
}

const setup = () => {
  const db = openDatabase(':memory:')
  const datasetsDir = mkdtempSync(path.join(tmpdir(), 'stella-datasets-'))
  return {
    db,
    datasetsDir,
    cleanup: () => {
      db.close()
      rmSync(datasetsDir, { recursive: true, force: true })
    },
  }
}

test('validateDatasetCase accepts a complete case and fills optional fields', () => {
  const result = validateDatasetCase(VALID_CASE)
  assert.equal(result.ok, true)
  assert.deepEqual(result.case?.expected.anchors, VALID_CASE.expected.anchors)
  const minimal = validateDatasetCase({
    id: 'c1',
    messages: [{ role: 'user', content: 'hi' }],
    expected: { behavior: 'any' },
  })
  assert.equal(minimal.ok, true)
  assert.deepEqual(minimal.case?.slices, [])
  assert.equal(minimal.case?.expected.minCitations, 0)
})

test('validateDatasetCase reports per-field issues', () => {
  const result = validateDatasetCase({
    id: 'bad',
    slices: 'direct',
    messages: [{ role: 'assistant', content: 'hi' }],
    expected: { behavior: 'maybe', minCitations: -1, anchors: [{ heading: 'no doc' }] },
  })
  assert.equal(result.ok, false)
  const fields = result.issues.map((issue) => issue.field)
  assert.ok(fields.includes('slices'))
  assert.ok(fields.includes('messages[0].role'))
  assert.ok(fields.includes('expected.behavior'))
  assert.ok(fields.includes('expected.minCitations'))
  assert.ok(fields.includes('expected.anchors[0].doc'))
  assert.equal(fields.includes('id'), false)
})

test('parseDatasetJsonl keeps valid lines and reports invalid ones', () => {
  const text = [
    JSON.stringify(VALID_CASE),
    '',
    '{not json}',
    JSON.stringify({ ...VALID_CASE, expected: {} }),
    JSON.stringify({ ...VALID_CASE, messages: [{ role: 'user', content: 'second question' }] }),
  ].join('\n')
  const parsed = parseDatasetJsonl(text)
  assert.equal(parsed.cases.length, 1)
  assert.equal(parsed.issues.length, 3)
  assert.ok(parsed.issues.some((issue) => issue.field === 'json'))
})

test('import and snapshot write immutable JSONL plus manifest', () => {
  const { db, datasetsDir, cleanup } = setup()
  try {
    const dataset = createDataset({ name: 'support', description: 'demo suite' }, db)
    const imported = importDatasetJsonl(dataset.id, serializeCasesJsonl([VALID_CASE]), db)
    assert.equal(imported.imported, 1)
    assert.deepEqual(imported.issues, [])

    const outcome = snapshotDataset(dataset.id, { notes: 'demo seed' }, { db, datasetsDir })
    assert.equal(outcome.version.version, 1)
    assert.equal(outcome.version.caseCount, 1)
    assert.equal(outcome.version.path, outcome.filePath)
    assert.match(outcome.version.contentHash, /^sha256:[0-9a-f]{64}$/)

    const snapshotCase = readVersionCases(outcome.version)[0]
    // Snapshot files are git-tracked: the local DB id is deliberately omitted.
    assert.deepEqual(snapshotCase, canonicalCase(VALID_CASE))
    assert.equal(outcome.manifest.versions.length, 1)
    assert.equal(outcome.manifest.versions[0]?.notes, 'demo seed')
    assert.equal(outcome.manifest.versions[0]?.caseCount, 1)

    const second = snapshotDataset(dataset.id, {}, { db, datasetsDir })
    assert.equal(second.version.version, 2)
    assert.equal(listDatasetVersions(dataset.id, db).length, 2)
    assert.equal(latestDatasetVersion(dataset.id, db).version, 2)
    assert.equal(second.manifest.versions.length, 2)
    // Same drafts -> same bytes -> same content hash, even at a new version.
    assert.equal(second.version.contentHash, outcome.version.contentHash)
    const changed: DatasetCase = { ...VALID_CASE, slices: ['direct', 'changed'] }
    importDatasetJsonl(dataset.id, `${JSON.stringify(changed)}\n`, db)
    const third = snapshotDataset(dataset.id, {}, { db, datasetsDir })
    assert.notEqual(third.version.contentHash, second.version.contentHash)
  } finally {
    cleanup()
  }
})

test('snapshot of an empty dataset is rejected', () => {
  const { db, datasetsDir, cleanup } = setup()
  try {
    const dataset = createDataset({ name: 'empty' }, db)
    assert.throws(() => snapshotDataset(dataset.id, {}, { db, datasetsDir }), /no cases/)
  } finally {
    cleanup()
  }
})

test('anchor resolution matches doc, heading and quote; reports misses', () => {
  const { db, cleanup } = setup()
  try {
    seedCorpus(db)
    const resolved = resolveCaseAnchors(VALID_CASE, { db })
    assert.equal(resolved.resolution.resolved, 1)
    assert.equal(resolved.resolution.total, 1)
    assert.deepEqual(resolved.chunkIds, ['chunk_refund_1'])

    const byTitle = resolveCaseAnchors(
      {
        ...VALID_CASE,
        expected: {
          ...VALID_CASE.expected,
          anchors: [{ doc: 'Refund policy', heading: 'Eligibility' }],
        },
      },
      { db }
    )
    assert.deepEqual(byTitle.chunkIds, ['chunk_refund_2'])

    const missingDoc = resolveCaseAnchors(
      {
        ...VALID_CASE,
        expected: { ...VALID_CASE.expected, anchors: [{ doc: 'policies/nope.md' }] },
      },
      { db }
    )
    assert.equal(missingDoc.resolution.resolved, 0)
    assert.match(missingDoc.resolution.missing[0] ?? '', /doc_not_found/)

    const missingQuote = resolveCaseAnchors(
      {
        ...VALID_CASE,
        expected: {
          ...VALID_CASE.expected,
          anchors: [{ doc: 'policies/refunds.md', quote: 'within 90 days' }],
        },
      },
      { db }
    )
    assert.match(missingQuote.resolution.missing[0] ?? '', /quote_not_found/)
  } finally {
    cleanup()
  }
})

test('snapshot records anchor status and detects corpus drift', () => {
  const { db, datasetsDir, cleanup } = setup()
  try {
    seedCorpus(db)
    const dataset = createDataset({ name: 'support' }, db)
    importDatasetJsonl(dataset.id, serializeCasesJsonl([VALID_CASE]), db)
    const outcome = snapshotDataset(dataset.id, {}, { db, datasetsDir })
    assert.equal(outcome.version.anchorStatus.resolved, 1)
    assert.equal(outcome.version.anchorStatus.total, 1)
    assert.ok(outcome.manifest.corpusVersion.startsWith('sha256:'))

    const clean = anchorDrift(dataset.id, 1, { db })
    assert.equal(clean.ok, true)
    assert.deepEqual(clean.drifted, [])

    db.prepare('DELETE FROM chunks WHERE id = ?').run('chunk_refund_1')
    const drifted = anchorDrift(dataset.id, 1, { db })
    assert.equal(drifted.ok, false)
    assert.equal(drifted.drifted.length, 1)
    assert.equal(drifted.drifted[0]?.reason, 'newly_missing')
    assert.equal(drifted.current.resolved, 0)
    assert.notEqual(drifted.corpusVersion.stored, drifted.corpusVersion.current)
  } finally {
    cleanup()
  }
})

test('import replaces cases by id and updates the draft set', () => {
  const { db, cleanup } = setup()
  try {
    const dataset = createDataset({ name: 'support' }, db)
    importDatasetJsonl(dataset.id, serializeCasesJsonl([VALID_CASE]), db)
    const updated: DatasetCase = { ...VALID_CASE, slices: ['direct', 'refund'] }
    importDatasetJsonl(dataset.id, `${JSON.stringify(updated)}\n`, db)
    const version = snapshotDataset(
      dataset.id,
      {},
      { datasetsDir: mkdtempSync(path.join(tmpdir(), 'stella-x-')), db }
    )
    const cases = readVersionCases(version.version)
    assert.equal(cases.length, 1)
    assert.deepEqual(cases[0]?.slices, ['direct', 'refund'])
  } finally {
    cleanup()
  }
})
