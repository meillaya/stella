import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeCost, pricingBasis } from '../../../shared/pricing.ts'
import {
  DEFAULT_USAGE,
  SSE_HEADERS,
  buildChatStream,
  chatBody,
  createTempDb,
  delay,
  fakeChunks,
  fakeRetrieve,
  framesOf,
  messageStart,
  payloadOf,
  postMessages,
  seedProfile,
  sessionRows,
  sourceRows,
  sseFrame,
  startGateway,
  startMockUpstream,
  waitForTrace,
  writeInChunks,
  type DownstreamFrame,
} from './helpers.ts'

/** Off-peak instant (Sunday) so cost assertions are exact and deterministic. */
const FIXED_NOW = Date.UTC(2026, 10, 15, 0, 0, 0, 0)

const payloadType = (frame: DownstreamFrame): string | null => {
  try {
    const payload = JSON.parse(frame.data) as Record<string, unknown>
    return typeof payload.type === 'string' ? payload.type : null
  } catch {
    return null
  }
}

test('streaming proxy keeps bytes, injects usage, records the trace and cost', async (t) => {
  const upstreamStream = buildChatStream({ usage: DEFAULT_USAGE, title: '退款政策' })
  const upstream = await startMockUpstream((_request, response) => {
    response.writeHead(200, SSE_HEADERS)
    // Chunk sizes deliberately split multi-byte UTF-8 characters (你好 / 🌟).
    void writeInChunks(response, upstreamStream, [1, 2, 3, 5, 7, 11, 4]).then(() => response.end())
  })
  const temp = createTempDb()
  const gateway = await startGateway({
    upstreamUrl: upstream.url,
    db: temp.db,
    apiKey: 'server-test-key',
    now: () => FIXED_NOW,
  })
  t.after(async () => {
    await gateway.close()
    await upstream.close()
    await temp.cleanup()
  })

  const body = chatBody()
  const response = await postMessages(gateway.url, body)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  const traceId = response.headers.get('x-stella-trace-id')
  assert.match(traceId ?? '', /^tr_/)
  const bytes = Buffer.from(await response.arrayBuffer())
  const downstream = framesOf(bytes)
  const expected = framesOf(Buffer.from(upstreamStream, 'utf8'))
  assert.equal(downstream.length, expected.length)

  // Every frame except the two usage frames must be byte-identical.
  for (let index = 0; index < expected.length; index += 1) {
    const actualFrame = downstream[index] as DownstreamFrame
    const expectedFrame = expected[index] as DownstreamFrame
    const type = payloadType(actualFrame)
    if (type === 'message_start' || type === 'message_delta') {continue}
    assert.deepEqual(
      actualFrame.raw,
      expectedFrame.raw,
      `frame ${index} (${expectedFrame.event}) changed during proxying`
    )
  }

  // Comments and pings survived (they are part of the byte compare above).
  assert.ok(downstream.some((frame) => frame.raw.toString('utf8').startsWith(': keep-alive')))
  assert.ok(downstream.some((frame) => frame.event === 'ping'))

  const startFrame = downstream.find((frame) => payloadType(frame) === 'message_start')
  assert.ok(startFrame)
  const startPayload = payloadOf(startFrame) as {
    message: { usage: Record<string, unknown> }
  }
  const startUsage = startPayload.message.usage
  assert.equal(startUsage.lantern_trace_id, traceId)
  assert.deepEqual(startUsage.lantern_sources, [])
  assert.equal(startUsage.lantern_pricing_basis, 'off-peak')
  assert.equal('lantern_cost_usd' in startUsage, false)

  const deltaFrame = downstream.find((frame) => payloadType(frame) === 'message_delta')
  assert.ok(deltaFrame)
  const deltaPayload = payloadOf(deltaFrame) as { usage: Record<string, unknown> }
  const deltaUsage = deltaPayload.usage
  const expectedCost = computeCost(
    {
      inputTokens: DEFAULT_USAGE.input_tokens,
      cacheReadTokens: DEFAULT_USAGE.cache_read_input_tokens,
      cacheCreationTokens: DEFAULT_USAGE.cache_creation_input_tokens,
      outputTokens: DEFAULT_USAGE.output_tokens,
    },
    'deepseek-flash',
    FIXED_NOW
  ).usd
  assert.equal(deltaUsage.lantern_trace_id, traceId)
  assert.equal(deltaUsage.lantern_pricing_basis, pricingBasis(FIXED_NOW))
  assert.equal(deltaUsage.lantern_cost_usd, expectedCost)
  assert.equal(typeof deltaUsage.lantern_latency_ms, 'number')
  assert.ok((deltaUsage.lantern_latency_ms as number) >= 0)

  const row = await waitForTrace(temp.db)
  assert.equal(row.id, traceId)
  assert.equal(row.status, 'ok')
  assert.equal(row.model, 'deepseek-flash')
  assert.equal(row.thinking, 0)
  assert.equal(row.pricing_basis, 'off-peak')
  assert.equal(row.cost_usd, expectedCost)
  const usage = JSON.parse(row.usage_json) as Record<string, number>
  assert.equal(usage.inputTokens, 100)
  assert.equal(usage.cacheReadTokens, 50)
  assert.equal(usage.cacheCreationTokens, 0)
  assert.equal(usage.outputTokens, 20)
  const stored = JSON.parse(row.response_json) as {
    text: string
    thinking: string
    title: string
  }
  assert.match(stored.text, /Refunds are available within 30 days\. 你好，世界 🌟/)
  assert.match(stored.thinking, /考虑一下退款政策/)
  assert.equal(stored.title, '退款政策')
  assert.ok((row.ttfb_ms ?? -1) >= 0)
  assert.ok(row.latency_ms >= (row.ttfb_ms ?? 0))

  // The stored request is exactly what was forwarded upstream.
  const captured = upstream.requests[0]
  assert.ok(captured)
  assert.deepEqual(JSON.parse(captured.body.toString('utf8')), JSON.parse(row.request_json))
  assert.equal(captured.headers['x-api-key'], 'server-test-key')

  // Sessionisation: sha256(system + first user text).
  const sessions = sessionRows(temp.db)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0]?.turns, 1)
  assert.equal(row.session_key, sessions[0]?.session_key)
  assert.ok(row.session_id)
})

test('upstream error frame is forwarded byte-for-byte and recorded as error', async (t) => {
  const stream =
    sseFrame('message_start', messageStart({ ...DEFAULT_USAGE, output_tokens: 0 })) +
    sseFrame('error', {
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded, try again later' },
    })
  const upstream = await startMockUpstream((_request, response) => {
    response.writeHead(200, SSE_HEADERS)
    response.end(stream)
  })
  const temp = createTempDb()
  const gateway = await startGateway({ upstreamUrl: upstream.url, db: temp.db, now: () => FIXED_NOW })
  t.after(async () => {
    await gateway.close()
    await upstream.close()
    await temp.cleanup()
  })

  const response = await postMessages(gateway.url, chatBody())
  assert.equal(response.status, 200)
  const downstream = framesOf(Buffer.from(await response.arrayBuffer()))
  const errorFrame = downstream.find((frame) => frame.event === 'error')
  assert.ok(errorFrame)
  assert.equal(
    errorFrame.raw.toString('utf8'),
    `event: error\ndata: ${JSON.stringify({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded, try again later' },
    })}\n\n`
  )

  const row = await waitForTrace(temp.db)
  assert.equal(row.status, 'error')
  assert.match(row.error ?? '', /Overloaded, try again later/)
})

test('truncated stream is status interrupted with estimated usage', async (t) => {
  const stream =
    sseFrame('message_start', messageStart({ ...DEFAULT_USAGE, output_tokens: 0 })) +
    sseFrame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }) +
    sseFrame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'partial answer' },
    })
  const upstream = await startMockUpstream((_request, response) => {
    response.writeHead(200, SSE_HEADERS)
    response.end(stream)
  })
  const temp = createTempDb()
  const gateway = await startGateway({ upstreamUrl: upstream.url, db: temp.db, now: () => FIXED_NOW })
  t.after(async () => {
    await gateway.close()
    await upstream.close()
    await temp.cleanup()
  })

  const response = await postMessages(gateway.url, chatBody())
  assert.equal(response.status, 200)
  await response.arrayBuffer()

  const row = await waitForTrace(temp.db)
  assert.equal(row.status, 'interrupted')
  assert.match(row.error ?? '', /message_stop/)
  const usage = JSON.parse(row.usage_json) as { inputTokens: number; outputTokens: number; estimated?: boolean }
  assert.equal(usage.inputTokens, 100)
  assert.ok(usage.outputTokens > 0)
  assert.equal(usage.estimated, true)
  const stored = JSON.parse(row.response_json) as { text: string }
  assert.equal(stored.text, 'partial answer')
})

test('upstream HTTP error status and body are preserved and traced', async (t) => {
  const errorBody = JSON.stringify({
    type: 'error',
    error: { type: 'rate_limit_error', message: 'Too many requests' },
  })
  const upstream = await startMockUpstream((_request, response) => {
    response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' })
    response.end(errorBody)
  })
  const temp = createTempDb()
  const gateway = await startGateway({ upstreamUrl: upstream.url, db: temp.db, now: () => FIXED_NOW })
  t.after(async () => {
    await gateway.close()
    await upstream.close()
    await temp.cleanup()
  })

  const response = await postMessages(gateway.url, chatBody())
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '7')
  assert.equal(await response.text(), errorBody)
  const row = await waitForTrace(temp.db)
  assert.equal(row.status, 'error')
  assert.match(row.error ?? '', /Too many requests/)
})

test('client abort cancels upstream and records an aborted trace', async (t) => {
  let requests = 0
  const upstream = await startMockUpstream((_request, response) => {
    requests += 1
    response.writeHead(200, SSE_HEADERS)
    if (requests === 1) {
      // Slow stream: the client aborts before message_stop.
      response.write(sseFrame('message_start', messageStart({ ...DEFAULT_USAGE, output_tokens: 0 })))
      const timer = setTimeout(() => response.end(), 10_000)
      response.on('close', () => clearTimeout(timer))
      return
    }
    response.end(buildChatStream())
  })
  const temp = createTempDb()
  const gateway = await startGateway({ upstreamUrl: upstream.url, db: temp.db, now: () => FIXED_NOW })
  t.after(async () => {
    await gateway.close()
    await upstream.close()
    await temp.cleanup()
  })

  const controller = new AbortController()
  const abortable = await fetch(`${gateway.url}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(chatBody()),
    signal: controller.signal,
  })
  const reader = abortable.body?.getReader()
  assert.ok(reader)
  await reader.read()
  controller.abort()
  await delay(50)

  const row = await waitForTrace(temp.db, 1)
  assert.equal(row.status, 'aborted')
  assert.match(row.error ?? '', /Client disconnected/)

  // The gateway keeps working after the abort.
  const again = await postMessages(gateway.url, chatBody())
  assert.equal(again.status, 200)
  const bytes = Buffer.from(await again.arrayBuffer())
  assert.ok(framesOf(bytes).some((frame) => payloadType(frame) === 'message_stop'))
  assert.equal(requests, 2)
})

test('/models proxies with the server key and ignores client placeholder keys', async (t) => {
  const modelsBody = JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }] })
  const upstream = await startMockUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(modelsBody)
  })
  const temp = createTempDb()
  const gateway = await startGateway({
    upstreamUrl: upstream.url,
    db: temp.db,
    apiKey: 'server-test-key',
    now: () => FIXED_NOW,
  })
  t.after(async () => {
    await gateway.close()
    await upstream.close()
    await temp.cleanup()
  })

  // The fork verifies with a placeholder client key; with a server key the
  // gateway ignores it and returns 200.
  const response = await fetch(`${gateway.url}/models`, {
    headers: { authorization: 'Bearer stella-local' },
  })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), modelsBody)
  assert.equal(upstream.requests[0]?.headers.authorization, 'Bearer server-test-key')

  // No client key at all: still 200 when the server key exists.
  const withoutClientKey = await fetch(`${gateway.url}/models`)
  assert.equal(withoutClientKey.status, 200)
  assert.equal(await withoutClientKey.text(), modelsBody)

  // Same-origin by design: the gateway never adds CORS headers.
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  assert.equal(response.headers.get('access-control-allow-credentials'), null)
})

test('/models falls back to the client key (BYOK) and 401s without any key', async (t) => {
  const upstream = await startMockUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"object":"list","data":[]}')
  })
  const temp = createTempDb()
  const gateway = await startGateway({
    upstreamUrl: upstream.url,
    db: temp.db,
    apiKey: null,
    now: () => FIXED_NOW,
  })
  t.after(async () => {
    await gateway.close()
    await upstream.close()
    await temp.cleanup()
  })

  const byok = await fetch(`${gateway.url}/models`, {
    headers: { 'x-api-key': 'client-key-123' },
  })
  assert.equal(byok.status, 200)
  assert.equal(upstream.requests[0]?.headers.authorization, 'Bearer client-key-123')

  const missing = await fetch(`${gateway.url}/models`)
  assert.equal(missing.status, 401)
  const body = (await missing.json()) as { error: { message: string; code?: string } }
  assert.match(body.error.message, /DEEPSEEK_API_KEY/)
  assert.equal(upstream.requests.length, 1)
})

test('multipart files POST/DELETE proxy with the beta header intact', async (t) => {
  const upstream = await startMockUpstream((request, response) => {
    if (request.method === 'POST') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: 'file_abc',
          type: 'file',
          size_bytes: 11,
          created_at: '2026-11-15T00:00:00Z',
          filename: 'notes.txt',
          mime_type: 'text/plain',
        })
      )
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'file_deleted', id: 'file_abc' }))
  })
  const temp = createTempDb()
  const gateway = await startGateway({
    upstreamUrl: upstream.url,
    db: temp.db,
    apiKey: null,
    now: () => FIXED_NOW,
  })
  t.after(async () => {
    await gateway.close()
    await upstream.close()
    await temp.cleanup()
  })

  const form = new FormData()
  form.append('purpose', 'user_data')
  form.append('file', new Blob(['hello world'], { type: 'text/plain' }), 'notes.txt')
  const upload = await fetch(`${gateway.url}/anthropic/v1/files`, {
    method: 'POST',
    headers: {
      'x-api-key': 'client-key-123',
      'anthropic-beta': 'files-api-2025-04-14',
    },
    body: form,
  })
  assert.equal(upload.status, 200)
  assert.equal(((await upload.json()) as { id: string }).id, 'file_abc')
  const captured = upstream.requests[0]
  assert.ok(captured)
  assert.equal(captured.headers['x-api-key'], 'client-key-123')
  assert.equal(captured.headers['anthropic-beta'], 'files-api-2025-04-14')
  assert.match(captured.headers['content-type'] ?? '', /multipart\/form-data; boundary=/)
  assert.match(captured.body.toString('utf8'), /hello world/)

  const deletion = await fetch(`${gateway.url}/anthropic/v1/files/file_abc`, {
    method: 'DELETE',
    headers: {
      'x-api-key': 'client-key-123',
      'anthropic-beta': 'files-api-2025-04-14',
    },
  })
  assert.equal(deletion.status, 200)
  assert.equal(((await deletion.json()) as { type: string }).type, 'file_deleted')
  const deleteRequest = upstream.requests[1]
  assert.ok(deleteRequest)
  assert.equal(deleteRequest.method, 'DELETE')
  assert.equal(deleteRequest.url, '/anthropic/v1/files/file_abc')
  assert.equal(deleteRequest.headers['anthropic-beta'], 'files-api-2025-04-14')
})

test('non-streaming messages are buffered, traced and returned verbatim', async (t) => {
  const messageBody = JSON.stringify({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'deepseek-flash',
    content: [{ type: 'text', text: 'Buffered answer.' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 7,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1,
      output_tokens: 3,
    },
  })
  const upstream = await startMockUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(messageBody)
  })
  const temp = createTempDb()
  const gateway = await startGateway({ upstreamUrl: upstream.url, db: temp.db, now: () => FIXED_NOW })
  t.after(async () => {
    await gateway.close()
    await upstream.close()
    await temp.cleanup()
  })

  const response = await postMessages(gateway.url, chatBody({ stream: false }))
  assert.equal(response.status, 200)
  assert.equal(await response.text(), messageBody)
  const row = await waitForTrace(temp.db)
  assert.equal(row.status, 'ok')
  const stored = JSON.parse(row.response_json) as { text: string; stopReason: string }
  assert.equal(stored.text, 'Buffered answer.')
  const usage = JSON.parse(row.usage_json) as { inputTokens: number; outputTokens: number }
  assert.equal(usage.inputTokens, 7)
  assert.equal(usage.outputTokens, 3)
})

test('tts streams audio bytes through unchanged', async (t) => {
  const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05])
  const upstream = await startMockUpstream((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer client-key-123')
    response.writeHead(200, { 'content-type': 'audio/pcm' })
    response.end(pcm)
  })
  const temp = createTempDb()
  const gateway = await startGateway({
    upstreamUrl: upstream.url,
    db: temp.db,
    apiKey: null,
    now: () => FIXED_NOW,
  })
  t.after(async () => {
    await gateway.close()
    await upstream.close()
    await temp.cleanup()
  })

  const response = await fetch(`${gateway.url}/v1/tools/tts`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-key-123', 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello', voice_id: 'stella', format: 'pcm' }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'audio/pcm')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pcm)
  const captured = upstream.requests[0]
  assert.ok(captured)
  assert.deepEqual(JSON.parse(captured.body.toString('utf8')), {
    text: 'hello',
    voice_id: 'stella',
    format: 'pcm',
  })
})

test('RAG injection appends one numbered block to the final user message', async (t) => {
  const upstream = await startMockUpstream((_request, response) => {
    response.writeHead(200, SSE_HEADERS)
    response.end(buildChatStream({ usage: DEFAULT_USAGE }))
  })
  const temp = createTempDb()
  const profileId = seedProfile(temp.db)
  const calls: unknown[] = []
  const retrieve = fakeRetrieve({ chunks: fakeChunks(), calls })
  const gateway = await startGateway({
    upstreamUrl: upstream.url,
    db: temp.db,
    now: () => FIXED_NOW,
    retrieve,
  })
  t.after(async () => {
    await gateway.close()
    await upstream.close()
    await temp.cleanup()
  })

  const body = chatBody()
  const originalMessages = body.messages as { role: string; content: unknown }[]
  const response = await postMessages(gateway.url, body)
  assert.equal(response.status, 200)
  const bytes = Buffer.from(await response.arrayBuffer())
  const downstream = framesOf(bytes)

  const captured = upstream.requests[0]
  assert.ok(captured)
  const sent = JSON.parse(captured.body.toString('utf8')) as {
    system: string
    messages: { role: string; content: unknown }[]
  }
  assert.equal(sent.system, 'You are Stella, a support assistant.')
  // History untouched: assistant content byte-identical.
  assert.deepEqual(sent.messages[1], originalMessages[1])
  assert.deepEqual(sent.messages[0], originalMessages[0])
  const finalContent = sent.messages[sent.messages.length - 1]?.content
  assert.ok(Array.isArray(finalContent))
  const blocks = finalContent as { type: string; text: string }[]
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0]?.text, 'What about digital goods?')
  assert.match(blocks[1]?.text ?? '', /<retrieved_sources>/)
  assert.match(blocks[1]?.text ?? '', /\[1\] Refund policy — Digital goods \(p\. 2\)/)
  assert.match(blocks[1]?.text ?? '', /Digital goods can be refunded within 14 days/)
  assert.match(blocks[1]?.text ?? '', /\[2\] Release notes/)
  assert.match(blocks[1]?.text ?? '', /cite them by bracket number/)

  // Retrieval was called with the profile spec.
  assert.equal(calls.length, 1)
  const call = calls[0] as Record<string, unknown>
  assert.equal(call.collectionId, 'support')
  assert.equal(call.query, 'What about digital goods?')
  assert.equal(call.k, 4)

  // lantern_sources in message_start holds the compact sources (<= 180 chars).
  const startPayload = payloadOf(
    downstream.find((frame) => payloadType(frame) === 'message_start') as DownstreamFrame
  ) as { message: { usage: { lantern_sources: Record<string, unknown>[] } } }
  const injectedSources = startPayload.message.usage.lantern_sources
  assert.equal(injectedSources.length, 2)
  assert.equal(injectedSources[0]?.chunkId, 'chk_1')
  assert.equal(injectedSources[0]?.documentId, 'doc_1')
  assert.equal(injectedSources[0]?.title, 'Refund policy')
  assert.equal(injectedSources[0]?.heading, 'Digital goods')
  assert.equal(injectedSources[0]?.page, 2)
  assert.ok(String(injectedSources[0]?.snippet ?? '').length <= 180)

  const row = await waitForTrace(temp.db)
  assert.equal(row.status, 'ok')
  assert.equal(row.profile_id, profileId)
  assert.equal(row.profile_name, 'Support RAG')
  assert.equal(row.retrieval_enabled, 1)
  assert.match(row.injected_context ?? '', /<retrieved_sources>/)
  assert.equal(row.retrieval_error, null)
  const sources = sourceRows(temp.db, row.id)
  assert.equal(sources.length, 2)
  assert.equal(sources[0]?.chunk_id, 'chk_1')
  assert.equal(sources[0]?.ordinal, 0)
  assert.match(sources[0]?.snippet ?? '', /Digital goods/)
  // The trace stores the client's original body for readable transcripts;
  // the retrieved block lives in injected_context and upstream received `sent`.
  const storedRequest = JSON.parse(row.request_json) as { messages: { content: unknown }[] }
  assert.deepEqual(storedRequest, body)
  assert.notDeepEqual(storedRequest, sent)
})

test('retrieval failure degrades gracefully and records retrieval_error', async (t) => {
  const upstream = await startMockUpstream((_request, response) => {
    response.writeHead(200, SSE_HEADERS)
    response.end(buildChatStream())
  })
  const temp = createTempDb()
  seedProfile(temp.db)
  const gateway = await startGateway({
    upstreamUrl: upstream.url,
    db: temp.db,
    now: () => FIXED_NOW,
    retrieve: fakeRetrieve({ error: new Error('collection not found') }),
  })
  t.after(async () => {
    await gateway.close()
    await upstream.close()
    await temp.cleanup()
  })

  const body = chatBody()
  const response = await postMessages(gateway.url, body)
  assert.equal(response.status, 200)
  await response.arrayBuffer()
  const captured = upstream.requests[0]
  assert.ok(captured)
  // Body forwarded untouched (still a string content for the last user message).
  const sent = JSON.parse(captured.body.toString('utf8')) as {
    messages: { content: unknown }[]
  }
  assert.equal(sent.messages[sent.messages.length - 1]?.content, 'What about digital goods?')

  const row = await waitForTrace(temp.db)
  assert.equal(row.status, 'ok')
  assert.equal(row.retrieval_enabled, 1)
  assert.equal(row.injected_context, null)
  assert.match(row.retrieval_error ?? '', /collection not found/)
  assert.equal(sourceRows(temp.db, row.id).length, 0)
})

test('assistant-final message (continuation) is never mutated by retrieval', async (t) => {
  const upstream = await startMockUpstream((_request, response) => {
    response.writeHead(200, SSE_HEADERS)
    response.end(buildChatStream())
  })
  const temp = createTempDb()
  seedProfile(temp.db)
  const gateway = await startGateway({
    upstreamUrl: upstream.url,
    db: temp.db,
    now: () => FIXED_NOW,
    retrieve: fakeRetrieve({ chunks: fakeChunks() }),
  })
  t.after(async () => {
    await gateway.close()
    await upstream.close()
    await temp.cleanup()
  })

  const body = chatBody({
    messages: [
      { role: 'user', content: 'Tell me about refunds.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Refunds take 30 days.' }] },
    ],
  })
  const response = await postMessages(gateway.url, body)
  assert.equal(response.status, 200)
  await response.arrayBuffer()
  const captured = upstream.requests[0]
  assert.ok(captured)
  assert.deepEqual(JSON.parse(captured.body.toString('utf8')), body)
  const row = await waitForTrace(temp.db)
  assert.equal(row.injected_context, null)
})
