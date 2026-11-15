import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import type { SourceRef, TokenUsage, TraceStatus } from '../../../shared/types.ts'
import { registerTracesApi } from '../../src/api/traces.ts'
import { computeCost } from '../../../shared/pricing.ts'
import { getTraceRow, insertTrace, rowToTrace } from '../../src/gateway/trace-store.ts'
import { createTempDb, delay, fakeChunks } from './helpers.ts'

/** Traces API: list filters/cursor, detail, annotate; promote is eval-owned. */

const USAGE: TokenUsage = {
  inputTokens: 10,
  cacheReadTokens: 2,
  cacheCreationTokens: 0,
  outputTokens: 5,
}

const insertTestTrace = (
  db: ReturnType<typeof createTempDb>['db'],
  options: {
    id: string
    createdAt: number
    status?: TraceStatus
    model?: string
    profileId?: string | null
    profileName?: string | null
    retrievalEnabled?: boolean
    feedback?: 'up' | 'down' | null
    annotation?: string | null
    question?: string
    answer?: string
    sources?: SourceRef[]
    retrievalError?: string | null
  }
): void => {
  const cost = computeCost(USAGE, 'deepseek-flash', options.createdAt)
  insertTrace(db, {
    id: options.id,
    sessionKey: `session-${options.id}`,
    createdAt: options.createdAt,
    status: options.status ?? 'ok',
    model: options.model ?? 'deepseek-flash',
    thinking: false,
    profileId: options.profileId ?? null,
    profileName: options.profileName ?? null,
    retrievalEnabled: options.retrievalEnabled ?? false,
    latencyMs: options.createdAt % 1000,
    ttfbMs: 12,
    usage: USAGE,
    costUsd: cost.usd,
    pricingBasis: cost.basis,
    request: {
      model: options.model ?? 'deepseek-flash',
      system: 'You are Stella.',
      messages: [{ role: 'user', content: options.question ?? 'Question?' }],
      stream: true,
    },
    response: {
      text: options.answer ?? 'Answer.',
      thinking: null,
      stopReason: 'end_turn',
      title: null,
      toolCalls: 0,
      citations: [],
    },
    sources: options.sources ?? [],
    injectedContext: options.sources?.length ? '<retrieved_sources>…</retrieved_sources>' : null,
    retrievalError: options.retrievalError ?? null,
    error: options.status && options.status !== 'ok' ? 'simulated failure' : null,
  })
  if (options.feedback !== undefined || options.annotation !== undefined) {
    db.prepare('UPDATE traces SET feedback = ?, annotation = ? WHERE id = ?').run(
      options.feedback ?? null,
      options.annotation ?? null,
      options.id
    )
  }
}

const buildApi = async (db: ReturnType<typeof createTempDb>['db']) => {
  const app = Fastify({ logger: false })
  registerTracesApi(app, { db })
  await app.ready()
  return app
}

test('GET /api/traces lists newest first with cursor and filters', async (t) => {
  const temp = createTempDb()
  const app = await buildApi(temp.db)
  t.after(async () => {
    await app.close()
    await temp.cleanup()
  })
  insertTestTrace(temp.db, {
    id: 'tr_old',
    createdAt: 1000,
    question: 'What is the refund policy?',
    answer: 'Thirty days.',
    sources: fakeChunks().slice(0, 1),
  })
  insertTestTrace(temp.db, {
    id: 'tr_mid',
    createdAt: 2000,
    status: 'error',
    feedback: 'down',
    annotation: 'Wrong amount',
    question: 'Digital goods?',
    answer: 'Fourteen days.',
  })
  insertTestTrace(temp.db, {
    id: 'tr_new',
    createdAt: 3000,
    status: 'aborted',
    profileId: 'prof_x',
    profileName: 'Support RAG',
    retrievalEnabled: true,
    feedback: 'up',
    question: 'Pricing table for teams?',
    answer: 'Teams pay $99.',
    sources: fakeChunks(),
  })

  const all = await app.inject({ method: 'GET', url: '/api/traces' })
  assert.equal(all.statusCode, 200)
  const page = all.json() as {
    items: {
      id: string
      question: string
      answerPreview: string
      sourceCount: number
      status: string
      feedback: string | null
      profileName: string | null
      retrievalEnabled: boolean
      costUsd: number
    }[]
    nextCursor: string | null
  }
  assert.deepEqual(
    page.items.map((item) => item.id),
    ['tr_new', 'tr_mid', 'tr_old']
  )
  assert.equal(page.nextCursor, null)
  const newest = page.items[0]
  assert.equal(newest?.question, 'Pricing table for teams?')
  assert.equal(newest?.answerPreview, 'Teams pay $99.')
  assert.equal(newest?.sourceCount, 2)
  assert.equal(newest?.profileName, 'Support RAG')
  assert.equal(newest?.retrievalEnabled, true)
  assert.ok((newest?.costUsd ?? 0) > 0)

  // Cursor pagination.
  const first = await app.inject({ method: 'GET', url: '/api/traces?limit=2' })
  const firstPage = first.json() as { items: { id: string }[]; nextCursor: string | null }
  assert.deepEqual(firstPage.items.map((item) => item.id), ['tr_new', 'tr_mid'])
  assert.ok(firstPage.nextCursor)
  const second = await app.inject({
    method: 'GET',
    url: `/api/traces?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor as string)}`,
  })
  const secondPage = second.json() as { items: { id: string }[]; nextCursor: string | null }
  assert.deepEqual(secondPage.items.map((item) => item.id), ['tr_old'])
  assert.equal(secondPage.nextCursor, null)

  // Filters.
  const down = (await app.inject({ method: 'GET', url: '/api/traces?feedback=down' })).json() as {
    items: { id: string }[]
  }
  assert.deepEqual(down.items.map((item) => item.id), ['tr_mid'])
  const errors = (await app.inject({ method: 'GET', url: '/api/traces?status=error,aborted' })).json() as {
    items: { id: string }[]
  }
  assert.deepEqual(errors.items.map((item) => item.id), ['tr_new', 'tr_mid'])
  const byProfile = (await app.inject({ method: 'GET', url: '/api/traces?profileId=prof_x' })).json() as {
    items: { id: string }[]
  }
  assert.deepEqual(byProfile.items.map((item) => item.id), ['tr_new'])
  const byQuery = (await app.inject({ method: 'GET', url: '/api/traces?q=refund' })).json() as {
    items: { id: string }[]
  }
  assert.deepEqual(byQuery.items.map((item) => item.id), ['tr_old'])
})

test('GET /api/traces/:id returns the full trace including sources and retrieval errors', async (t) => {
  const temp = createTempDb()
  const app = await buildApi(temp.db)
  t.after(async () => {
    await app.close()
    await temp.cleanup()
  })
  insertTestTrace(temp.db, {
    id: 'tr_detail',
    createdAt: 5000,
    profileId: 'prof_x',
    profileName: 'Support RAG',
    retrievalEnabled: true,
    sources: fakeChunks(),
    retrievalError: 'collection not found',
    feedback: 'up',
    annotation: 'Grounded answer',
    question: 'What about digital goods?',
    answer: 'Fourteen days.',
  })

  const response = await app.inject({ method: 'GET', url: '/api/traces/tr_detail' })
  assert.equal(response.statusCode, 200)
  const trace = response.json() as Record<string, unknown> & {
    id: string
    sessionKey: string
    status: string
    retrievalError: string | null
    injectedContext: string | null
    sources: { id: string; chunkId: string; title: string }[]
    request: { messages: { role: string; content: string }[] }
    response: { text: string }
    feedback: string
    annotation: string
    usage: TokenUsage
    costUsd: number
  }
  assert.equal(trace.id, 'tr_detail')
  assert.equal(trace.sessionKey, 'session-tr_detail')
  assert.equal(trace.status, 'ok')
  assert.equal(trace.retrievalError, 'collection not found')
  assert.match(trace.injectedContext ?? '', /retrieved_sources/)
  assert.equal(trace.sources.length, 2)
  assert.equal(trace.sources[0]?.id, 's1')
  assert.equal(trace.sources[0]?.chunkId, 'chk_1')
  assert.equal(trace.response.text, 'Fourteen days.')
  assert.equal(trace.request.messages[0]?.content, 'What about digital goods?')
  assert.equal(trace.feedback, 'up')
  assert.equal(trace.annotation, 'Grounded answer')
  assert.equal(trace.usage.inputTokens, USAGE.inputTokens)
  assert.ok(trace.costUsd > 0)
  assert.equal((trace.usage as TokenUsage).cacheReadTokens, 2)

  const missing = await app.inject({ method: 'GET', url: '/api/traces/tr_missing' })
  assert.equal(missing.statusCode, 404)
  assert.equal((missing.json() as { error: { code: string } }).error.code, 'not_found')
})

test('PATCH /api/traces/:id sets and clears feedback/annotation', async (t) => {
  const temp = createTempDb()
  const app = await buildApi(temp.db)
  t.after(async () => {
    await app.close()
    await temp.cleanup()
  })
  insertTestTrace(temp.db, { id: 'tr_patch', createdAt: 7000 })

  const down = await app.inject({
    method: 'PATCH',
    url: '/api/traces/tr_patch',
    payload: { feedback: 'down', annotation: 'Missing citation' },
  })
  assert.equal(down.statusCode, 200)
  const patched = down.json() as { feedback: string; annotation: string }
  assert.equal(patched.feedback, 'down')
  assert.equal(patched.annotation, 'Missing citation')
  const row = getTraceRow(temp.db, 'tr_patch')
  assert.ok(row)
  assert.equal(rowToTrace(temp.db, row).feedback, 'down')

  const cleared = await app.inject({
    method: 'PATCH',
    url: '/api/traces/tr_patch',
    payload: { feedback: null, annotation: null },
  })
  assert.equal(cleared.statusCode, 200)
  const clearedTrace = cleared.json() as { feedback: string | null; annotation: string | null }
  assert.equal(clearedTrace.feedback, null)
  assert.equal(clearedTrace.annotation, null)

  const invalid = await app.inject({
    method: 'PATCH',
    url: '/api/traces/tr_patch',
    payload: { feedback: 'sideways' },
  })
  assert.equal(invalid.statusCode, 400)
  assert.equal((invalid.json() as { error: { code: string } }).error.code, 'invalid_input')

  const empty = await app.inject({ method: 'PATCH', url: '/api/traces/tr_patch', payload: {} })
  assert.equal(empty.statusCode, 400)

  const unknown = await app.inject({
    method: 'PATCH',
    url: '/api/traces/tr_missing',
    payload: { feedback: 'up' },
  })
  assert.equal(unknown.statusCode, 404)
  await delay(0)
})
