import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  createCollection,
  deleteCollection,
  deleteDocument,
  getCollectionByName,
  ingestFile,
  ingestPaths,
  ingestText,
  ingestUrls,
  listDocuments,
  retrieve,
  searchCollection,
  updateCollection,
} from '../../src/rag/index.ts'
import { RagError } from '../../src/rag/contract.ts'
import {
  bytesOf,
  cleanupDir,
  collectionChunkTexts,
  ftsRowCount,
  makeTempDir,
  readFixture,
  rowCount,
  withDb,
} from './helpers.ts'

const markdownFile = (name: string) => bytesOf(readFixture(name))

test('ingest: Markdown file becomes document, chunks and searchable FTS rows', async () => {
  await withDb(async (db) => {
    const collection = createCollection({ name: 'Docs' }, db)
    const result = await ingestFile(
      {
        collectionId: collection.id,
        fileName: 'refund-policy.md',
        mimeType: 'text/markdown',
        data: markdownFile('refund-policy.md'),
      },
      db
    )
    assert.equal(result.deduped, false)
    assert.equal(result.document.title, 'Refund Policy')
    assert.equal(result.document.sourceType, 'file')
    assert.equal(result.document.contentHash.length, 64)
    assert.ok(result.chunks >= 2)
    assert.equal(result.document.chunkCount, result.chunks)
    assert.equal(listDocuments(collection.id, db).length, 1)
    assert.equal(ftsRowCount(db), result.chunks)

    // camelCase identifier search uses the code_tokens shadow column.
    const identifierHits = await searchCollection({ collectionId: collection.id, query: 'get user name', db })
    assert.ok(identifierHits.some((hit) => hit.title === 'Refund Policy'))
  })
})

test('ingest: same content hash dedupes in place and replaces chunks atomically', async () => {
  await withDb(async (db) => {
    const collection = createCollection({ name: 'Docs' }, db)
    const data = markdownFile('refund-policy.md')
    const first = await ingestFile(
      { collectionId: collection.id, fileName: 'refund-policy.md', mimeType: 'text/markdown', data },
      db
    )
    const firstChunkCount = first.chunks
    const firstDocumentId = first.document.id
    assert.equal(ftsRowCount(db), firstChunkCount)

    const second = await ingestFile(
      { collectionId: collection.id, fileName: 'refund-policy.md', mimeType: 'text/markdown', data },
      db
    )
    assert.equal(second.deduped, true)
    assert.equal(second.document.id, firstDocumentId)
    assert.equal(rowCount(db, 'documents'), 1)
    assert.equal(rowCount(db, 'chunks'), firstChunkCount)
    assert.equal(ftsRowCount(db), firstChunkCount, 'no orphaned FTS rows after re-ingest')

    const renamed = await ingestFile(
      {
        collectionId: collection.id,
        fileName: 'refund-policy.md',
        mimeType: 'text/markdown',
        data,
        title: 'Refund Policy (2026)',
      },
      db
    )
    assert.equal(renamed.document.id, firstDocumentId)
    assert.equal(renamed.document.title, 'Refund Policy (2026)')
    assert.equal(rowCount(db, 'documents'), 1)
  })
})

test('ingest: changed content for the same URL replaces the document', async () => {
  await withDb(async (db) => {
    const collection = createCollection({ name: 'Docs' }, db)
    const uri = 'https://example.com/widgets'
    const first = await ingestText(
      {
        collectionId: collection.id,
        title: 'Widgets',
        text: '# Widgets\n\nVersion one describes widgets only.',
        uri,
        sourceType: 'url',
      },
      db
    )
    const second = await ingestText(
      {
        collectionId: collection.id,
        title: 'Widgets',
        text: '# Widgets\n\nVersion two describes gadgets only.',
        uri,
        sourceType: 'url',
      },
      db
    )
    assert.equal(second.document.id, first.document.id, 'same URI reuses the document id')
    assert.equal(second.deduped, false)
    assert.equal(rowCount(db, 'documents'), 1)
    const text = collectionChunkTexts(db, collection.id).join('\n')
    assert.ok(!text.includes('Version one'))
    assert.ok(text.includes('Version two'))
    assert.equal(ftsRowCount(db), rowCount(db, 'chunks'))
  })
})

test('ingest: unsupported file types are rejected with a typed error', async () => {
  await withDb(async (db) => {
    const collection = createCollection({ name: 'Docs' }, db)
    await assert.rejects(
      ingestFile(
        { collectionId: collection.id, fileName: 'archive.xyz', data: bytesOf('not a document') },
        db
      ),
      (error: unknown) => error instanceof RagError && error.code === 'unsupported_type'
    )
    await assert.rejects(
      ingestFile({ collectionId: 'missing', fileName: 'a.md', data: bytesOf('# A') }, db),
      (error: unknown) => error instanceof RagError && error.code === 'not_found'
    )
    await assert.rejects(
      ingestText({ collectionId: collection.id, title: 'Empty', text: '   ' }, db),
      (error: unknown) => error instanceof RagError && error.code === 'invalid_input'
    )
  })
})

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })

test('ingest: OCR upstream errors (402) map to actionable RagErrors', async () => {
  await withDb(async (db) => {
    const collection = createCollection({ name: 'Docs' }, db)
    const fetchImpl = (async () =>
      jsonResponse({ error: { message: 'Insufficient balance', code: 'insufficient_balance' } }, 402)) as unknown as typeof fetch
    await assert.rejects(
      ingestFile(
        {
          collectionId: collection.id,
          fileName: 'scan.pdf',
          data: bytesOf('%PDF-1.4 fake pdf bytes'),
          apiKey: 'test-key',
          fetchImpl,
        },
        db
      ),
      (error: unknown) => {
        assert.ok(error instanceof RagError)
        assert.equal(error.code, 'upstream_error')
        assert.match(error.message, /balance/i)
        return true
      }
    )
  })
})

test('ingest: OCR pages are cleaned, stored with page count and page ranges', async () => {
  await withDb(async (db) => {
    const collection = createCollection({ name: 'Docs' }, db)
    const fetchImpl = (async () =>
      jsonResponse({
        id: 'ocr_test',
        object: 'ocr.result',
        purpose: 'text_recognition',
        page_count: 2,
        pages: [
          {
            index: 0,
            text: '<｜ref｜>Handbook<｜/ref｜><｜box｜>[[10, 20, 300, 80]]<｜/box｜>\nRefund requests are handled on page one.',
            finish_reason: 'stop',
          },
          {
            index: 1,
            text: 'Shipping on page two usually takes five business days.',
            finish_reason: 'stop',
          },
        ],
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
      })) as unknown as typeof fetch

    const result = await ingestFile(
      {
        collectionId: collection.id,
        fileName: 'handbook.pdf',
        data: bytesOf('%PDF-1.4 fake pdf bytes'),
        apiKey: 'test-key',
        fetchImpl,
      },
      db
    )
    assert.equal(result.document.pageCount, 2)
    assert.equal(result.document.meta.format, 'pdf')

    const texts = collectionChunkTexts(db, collection.id).join('\n')
    assert.ok(!texts.includes('｜ref｜'), 'OCR ref tokens are stripped')
    assert.ok(!texts.includes('[[10, 20, 300, 80]]'), 'OCR box coordinates are stripped')
    assert.ok(texts.includes('Refund requests are handled on page one'))
    assert.ok(texts.includes('Shipping on page two'))

    const pageRows = db
      .prepare('SELECT page_from, page_to FROM chunks ORDER BY ordinal ASC')
      .all() as unknown as { page_from: number | null; page_to: number | null }[]
    assert.ok(pageRows.length > 0)
    assert.ok(pageRows.some((row) => row.page_from === 1))
    assert.ok(pageRows.some((row) => row.page_to === 2), 'tracked page ranges reach page 2')

    const refunds = await retrieve({ collectionId: collection.id, query: 'refund requests page one', db })
    assert.ok(refunds.chunks.length > 0)
    assert.equal(refunds.chunks[0]?.page, 1)
  })
})

test('ingest: directory ingestion walks supported files recursively', async () => {
  await withDb(async (db) => {
    const collection = createCollection({ name: 'PathDocs' }, db)
    const dir = await makeTempDir('paths')
    try {
      await writeFile(path.join(dir, 'one.md'), readFixture('refund-policy.md'))
      await writeFile(path.join(dir, 'two.md'), readFixture('shipping.md'))
      await writeFile(path.join(dir, 'skip.xyz'), 'not a supported document')
      const result = await ingestPaths({ collectionId: collection.id, paths: [dir] }, db)
      assert.equal(result.documents.length, 2)
      assert.equal(result.errors.length, 0)
      assert.equal(listDocuments(collection.id, db).length, 2)
    } finally {
      await cleanupDir(dir)
    }
  })
})

test('ingest: URL batch reports per-URL failures instead of throwing', async () => {
  await withDb(async (db) => {
    const collection = createCollection({ name: 'Urls' }, db)
    const fetchImpl = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const result = await ingestUrls(
      { collectionId: collection.id, urls: ['https://example.invalid/page'], fetchImpl },
      db
    )
    assert.equal(result.documents.length, 0)
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0]?.url, 'https://example.invalid/page')
    assert.match(result.errors[0]?.message ?? '', /network down/)
  })
})

test('ingest: deleting documents/collections cleans chunks and FTS rows', async () => {
  await withDb(async (db) => {
    const collection = createCollection({ name: 'Cleanup', description: 'before' }, db)
    const ingested = await ingestFile(
      {
        collectionId: collection.id,
        fileName: 'refund-policy.md',
        mimeType: 'text/markdown',
        data: markdownFile('refund-policy.md'),
      },
      db
    )
    assert.ok(ftsRowCount(db) > 0)

    assert.equal(deleteDocument(ingested.document.id, db), true)
    assert.equal(rowCount(db, 'documents'), 0)
    assert.equal(rowCount(db, 'chunks'), 0)
    assert.equal(ftsRowCount(db), 0, 'document delete removes FTS rows')
    assert.equal(deleteDocument(ingested.document.id, db), false)

    const again = await ingestFile(
      {
        collectionId: collection.id,
        fileName: 'refund-policy.md',
        mimeType: 'text/markdown',
        data: markdownFile('refund-policy.md'),
      },
      db
    )
    assert.notEqual(again.document.id, ingested.document.id, 'deleted content is a fresh document')

    const updated = updateCollection(collection.id, { name: 'Cleanup 2', description: 'after' }, db)
    assert.equal(updated?.name, 'Cleanup 2')
    assert.equal(updated?.description, 'after')
    assert.equal(deleteCollection(collection.id, db), true)
    assert.equal(rowCount(db, 'collections'), 0)
    assert.equal(rowCount(db, 'chunks'), 0)
    assert.equal(ftsRowCount(db), 0, 'collection delete removes FTS rows')
    assert.equal(getCollectionByName('Cleanup 2', db), null)
  })
})
