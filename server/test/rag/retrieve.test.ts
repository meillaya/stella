import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createCollection,
  ingestText,
  retrieve,
  searchCollection,
} from '../../src/rag/index.ts'
import { RagError } from '../../src/rag/contract.ts'
import { likeFallback } from '../../src/rag/search.ts'
import { withDb, seedCorpus, collectionChunkTexts } from './helpers.ts'

test('retrieve: BM25 ranks the right document first across the fixture corpus', async () => {
  await withDb(async (db) => {
    const collection = await seedCorpus(db)

    const shipping = await retrieve({ collectionId: collection.id, query: 'express shipping cost', db })
    assert.equal(shipping.chunks[0]?.title, 'Shipping & Delivery')

    const refunds = await retrieve({ collectionId: collection.id, query: 'refund eligibility', db })
    assert.equal(refunds.chunks[0]?.title, 'Refund Policy')

    const api = await retrieve({ collectionId: collection.id, query: 'parse retry count rate limit', db })
    assert.equal(api.chunks[0]?.title, 'API Reference')

    for (const result of [shipping, refunds, api]) {
      const scores = result.chunks.map((chunk) => chunk.score)
      for (let index = 1; index < scores.length; index += 1) {
        assert.ok((scores[index - 1] as number) >= (scores[index] as number), 'scores are descending')
        assert.ok((scores[index - 1] as number) > 0, 'scores are positive (higher is better)')
      }
    }
  })
})

test('retrieve: title match is boosted over body-only term frequency', async () => {
  await withDb(async (db) => {
    const collection = createCollection({ name: 'Boost' }, db)
    await ingestText(
      {
        collectionId: collection.id,
        title: 'Refund Policy',
        text: '# Refund Policy\n\nRefunds are processed within five business days.',
      },
      db
    )
    await ingestText(
      {
        collectionId: collection.id,
        title: 'Billing Notes',
        text: '# Billing Notes\n\nA refund may appear here.\n\nAnother refund note.\n\nA third refund mention.',
      },
      db
    )
    const result = await retrieve({ collectionId: collection.id, query: 'refund', db })
    assert.equal(result.chunks[0]?.title, 'Refund Policy')
  })
})

test('retrieve: returns the stable SourceRef contract with s1..sN ids', async () => {
  await withDb(async (db) => {
    const collection = await seedCorpus(db)
    const result = await retrieve({
      collectionId: collection.name,
      query: 'refund policy eligibility',
      k: 3,
      db,
    })
    assert.equal(result.collectionId, collection.id, 'name input resolves to the collection id')
    assert.ok(result.latencyMs >= 0)
    assert.equal(result.chunks.length, 3)

    result.chunks.forEach((chunk, index) => {
      assert.equal(chunk.id, `s${index + 1}`)
      assert.ok(chunk.chunkId.length > 0)
      assert.ok(chunk.documentId.length > 0)
      assert.equal(typeof chunk.title, 'string')
      assert.ok(chunk.heading === null || typeof chunk.heading === 'string')
      assert.ok(chunk.heading === null || !chunk.heading.toLowerCase().startsWith('refund policy >'))
      assert.ok(chunk.page === null || typeof chunk.page === 'number')
      assert.ok(chunk.score > 0)
      assert.ok(chunk.snippet.length > 0 && chunk.snippet.length <= 320)
      assert.ok(chunk.text.length > 0)
    })
  })
})

test('retrieve: context budget packs fewer chunks and keeps at least one', async () => {
  await withDb(async (db) => {
    const collection = createCollection({ name: 'Budget' }, db)
    for (const [index, topic] of ['meridian refunds', 'meridian shipping', 'meridian billing'].entries()) {
      await ingestText(
        {
          collectionId: collection.id,
          title: `Meridian ${index + 1}`,
          text: `# Meridian ${index + 1}\n\nMeridian notes about ${topic} and meridian support.`,
        },
        db
      )
    }
    const full = await retrieve({ collectionId: collection.id, query: 'meridian', k: 10, db })
    assert.ok(full.chunks.length >= 3)
    const tight = await retrieve({
      collectionId: collection.id,
      query: 'meridian',
      k: 10,
      contextBudgetTokens: 25,
      db,
    })
    assert.ok(tight.chunks.length >= 1, 'budget never returns zero chunks for a non-empty query')
    assert.ok(tight.chunks.length < full.chunks.length, 'tight budget packs fewer chunks')

    const limited = await retrieve({ collectionId: collection.id, query: 'meridian', k: 2, db })
    assert.ok(limited.chunks.length <= 2)
  })
})

test('retrieve: parent-section expansion folds contiguous same-section chunks', async () => {
  await withDb(async (db) => {
    const collection = createCollection({ name: 'Expansion' }, db)
    const filler = 'Refund details are important for every customer. '.repeat(220)
    await ingestText(
      {
        collectionId: collection.id,
        title: 'long.md',
        text: `# Long Section\n\n${filler}ZEBRA_ANCHOR at the end.`,
      },
      db
    )

    const rows = db
      .prepare('SELECT id, text, ordinal FROM chunks ORDER BY ordinal ASC')
      .all() as unknown as { id: string; text: string; ordinal: number }[]
    const targetIndex = rows.findIndex((row) => row.text.includes('ZEBRA_ANCHOR'))
    assert.ok(targetIndex > 2, 'anchor lives in a late chunk of the split section')
    const target = rows[targetIndex]
    const previous = rows[targetIndex - 1]
    const beforePrevious = rows[targetIndex - 2]
    assert.ok(target && previous && beforePrevious)

    const plain = await retrieve({
      collectionId: collection.id,
      query: 'zebra anchor',
      k: 1,
      parentExpansion: false,
      db,
    })
    assert.equal(plain.chunks[0]?.chunkId, target.id)
    assert.equal(plain.chunks[0]?.text, target.text)

    const expanded = await retrieve({
      collectionId: collection.id,
      query: 'zebra anchor',
      k: 1,
      parentExpansion: true,
      db,
    })
    const expandedChunk = expanded.chunks[0]
    assert.ok(expandedChunk)
    assert.equal(expandedChunk.chunkId, target.id, 'primary chunk identity is preserved')
    assert.ok(expandedChunk.text.length > target.text.length, 'neighbour text is folded in')
    assert.ok(expandedChunk.text.includes('ZEBRA_ANCHOR'))
    assert.ok(
      expandedChunk.text.startsWith(beforePrevious.text.slice(0, 25)),
      'expanded text leads with the earlier same-section chunks'
    )
    assert.ok(expandedChunk.text.endsWith(target.text), 'primary chunk text stays at the end')
  })
})

test('retrieve: FTS escaping works end-to-end for C++, quotes, unicode and operators', async () => {
  await withDb(async (db) => {
    const collection = await seedCorpus(db)

    const cpp = await retrieve({ collectionId: collection.id, query: 'C++', db })
    assert.ok(Array.isArray(cpp.chunks), 'C++ must not raise an FTS5 syntax error')

    const quoted = await retrieve({ collectionId: collection.id, query: '"quoted phrase"', db })
    assert.ok(
      quoted.chunks.some((chunk) => chunk.title === 'API Reference'),
      'quoted phrase is matched inside the API Reference document'
    )

    const unicode = await retrieve({ collectionId: collection.id, query: '退款政策', db })
    assert.deepEqual(unicode.chunks, [], 'unicode query is valid and simply has no matches')

    const operators = await searchCollection({ collectionId: collection.id, query: 'AND OR NOT', db })
    assert.deepEqual(operators, [], 'operator-only query degrades to a no-match LIKE scan')

    const fallback = likeFallback(db, collection.id, '++', 5)
    assert.ok(fallback.some((candidate) => candidate.title === 'API Reference'))
  })
})

test('retrieve: collection resolution and input validation errors are typed', async () => {
  await withDb(async (db) => {
    const collection = await seedCorpus(db)
    const byName = await retrieve({ collectionId: 'Support', query: 'refund', db })
    const byId = await retrieve({ collectionId: collection.id, query: 'refund', db })
    assert.deepEqual(
      byName.chunks.map((chunk) => chunk.chunkId),
      byId.chunks.map((chunk) => chunk.chunkId)
    )

    await assert.rejects(
      retrieve({ collectionId: 'no-such-collection', query: 'refund', db }),
      (error: unknown) => error instanceof RagError && error.code === 'not_found'
    )
    await assert.rejects(
      retrieve({ collectionId: collection.id, query: '   ', db }),
      (error: unknown) => error instanceof RagError && error.code === 'invalid_input'
    )
  })
})

test('searchCollection: returns ranked raw chunks with text and respects k', async () => {
  await withDb(async (db) => {
    const collection = await seedCorpus(db)
    const results = await searchCollection({ collectionId: collection.id, query: 'refund', k: 2, db })
    assert.ok(results.length >= 1 && results.length <= 2)
    assert.ok(results[0]?.text.length > 0)
    assert.equal(results[0]?.id, 's1')

    const texts = collectionChunkTexts(db, collection.id)
    assert.ok(texts.length >= 2)
  })
})
