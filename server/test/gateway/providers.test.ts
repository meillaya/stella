import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import {
  ProviderError,
  ReplayMissError,
  chatRequestKey,
  createLiveProvider,
  createReplayProvider,
  getChatProvider,
  getProvider,
  jsonSchemaCassettePath,
  readCassette,
  recordChat,
  recordJsonSchema,
  rerankListwise,
  callJsonSchema,
  type ChatRequest,
  type ChatStreamEvent,
  type JsonSchemaCall,
} from '../../src/providers/index.ts'
import {
  DEFAULT_USAGE,
  SSE_HEADERS,
  buildChatStream,
  createTempDb,
  delay,
  messageStart,
  sseFrame,
  startMockUpstream,
} from './helpers.ts'

/** Providers: live chat transport, JSON-schema caller/fallback, replay. */

const chatRequest = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'deepseek-flash',
  system: 'You are a support assistant.',
  messages: [{ role: 'user', content: 'What is the refund policy?' }],
  maxTokens: 128,
  thinking: false,
  temperature: 0.2,
  ...overrides,
})

test('live provider streams a chat turn and reports usage/cost/latency', async (t) => {
  const upstream = await startMockUpstream((_request, response) => {
    response.writeHead(200, SSE_HEADERS)
    response.end(buildChatStream({ title: '退款政策' }))
  })
  const temp = createTempDb()
  t.after(async () => {
    await upstream.close()
    await temp.cleanup()
  })

  const provider = createLiveProvider({ baseUrl: upstream.url, apiKey: 'test-key' })
  const request = chatRequest({ thinking: true, effort: 'high' })
  const result = await provider.chatOnce(request)
  assert.equal(result.provider, 'deepseek')
  assert.match(result.text, /Refunds are available within 30 days\. 你好，世界 🌟/)
  assert.match(result.thinking, /考虑一下退款政策/)
  assert.equal(result.title, '退款政策')
  assert.equal(result.stopReason, 'end_turn')
  assert.equal(result.usage.inputTokens, DEFAULT_USAGE.input_tokens)
  assert.equal(result.usage.cacheReadTokens, DEFAULT_USAGE.cache_read_input_tokens)
  assert.equal(result.usage.outputTokens, DEFAULT_USAGE.output_tokens)
  assert.ok(result.costUsd > 0)
  assert.ok(result.latencyMs >= 0)
  assert.ok((result.ttfbMs ?? -1) >= 0)

  const captured = upstream.requests[0]
  assert.ok(captured)
  assert.equal(captured.headers['x-api-key'], 'test-key')
  const sent = JSON.parse(captured.body.toString('utf8')) as Record<string, unknown>
  assert.equal(sent.model, 'deepseek-flash')
  assert.equal(sent.max_tokens, 128)
  assert.equal(sent.stream, true)
  assert.equal(sent.system, 'You are a support assistant.')
  assert.deepEqual(sent.thinking, { type: 'enabled' })
  assert.deepEqual(sent.output_config, { effort: 'high' })
})

test('streamChat yields typed events and returns the final result', async (t) => {
  const upstream = await startMockUpstream((_request, response) => {
    response.writeHead(200, SSE_HEADERS)
    response.end(buildChatStream())
  })
  const temp = createTempDb()
  t.after(async () => {
    await upstream.close()
    await temp.cleanup()
  })

  const provider = createLiveProvider({ baseUrl: upstream.url, apiKey: 'test-key' })
  const events: ChatStreamEvent[] = []
  const generator = provider.streamChat(chatRequest())
  let final: Awaited<ReturnType<typeof provider.chatOnce>> | null = null
  for (;;) {
    const next = await generator.next()
    if (next.done) {
      final = next.value
      break
    }
    events.push(next.value)
  }
  assert.ok(final)
  assert.ok(events.some((event) => event.type === 'text'))
  assert.ok(events.some((event) => event.type === 'thinking'))
  assert.ok(events.some((event) => event.type === 'title'))
  assert.ok(events.some((event) => event.type === 'usage'))
  assert.ok(events.some((event) => event.type === 'stop'))
  const streamedText = events
    .map((event) => (event.type === 'text' ? event.text : ''))
    .join('')
  assert.equal(streamedText, final.text)

  // Default provider selection: explicit live/deepseek + getProvider alias.
  const viaAlias = getProvider('live', { baseUrl: upstream.url, apiKey: 'test-key' })
  assert.equal((await viaAlias.chatOnce(chatRequest())).stopReason, 'end_turn')
  assert.equal(getChatProvider('replay').id, 'replay')
})

test('live provider failures are typed: missing key, http, interrupted, aborted', async (t) => {
  const upstream = await startMockUpstream((request, response) => {
    const url = request.url ?? '/'
    if (url === '/anthropic/v1/messages') {
      if (request.headers['x-api-key'] === 'interrupt-key') {
        response.writeHead(200, SSE_HEADERS)
        response.write(
          sseFrame('message_start', messageStart({ ...DEFAULT_USAGE, output_tokens: 0 }))
        )
        response.write(
          sseFrame('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          })
        )
        response.write(
          sseFrame('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'partial' },
          })
        )
        response.end()
        return
      }
      if (request.headers['x-api-key'] === 'bad-key') {
        response.writeHead(429, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Slow down' } })
        )
        return
      }
      response.writeHead(200, SSE_HEADERS)
      response.write(sseFrame('message_start', messageStart({ ...DEFAULT_USAGE, output_tokens: 0 })))
      const timer = setTimeout(() => response.end(), 10_000)
      response.on('close', () => clearTimeout(timer))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'unexpected path' } }))
  })
  const temp = createTempDb()
  t.after(async () => {
    await upstream.close()
    await temp.cleanup()
  })

  const noKey = createLiveProvider({ baseUrl: upstream.url, apiKey: null })
  await assert.rejects(
    noKey.chatOnce(chatRequest()),
    (error: unknown) => error instanceof ProviderError && error.code === 'missing_api_key'
  )
  assert.equal(upstream.requests.length, 0)

  const httpProvider = createLiveProvider({ baseUrl: upstream.url, apiKey: 'bad-key' })
  await assert.rejects(
    httpProvider.chatOnce(chatRequest()),
    (error: unknown) =>
      error instanceof ProviderError && error.code === 'http_error' && error.status === 429 &&
      /Slow down/.test(error.message)
  )

  const interruptedProvider = createLiveProvider({ baseUrl: upstream.url, apiKey: 'interrupt-key' })
  await assert.rejects(
    interruptedProvider.chatOnce(chatRequest()),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.code === 'interrupted' &&
      error.partial?.text === 'partial'
  )

  const abortProvider = createLiveProvider({ baseUrl: upstream.url, apiKey: 'test-key' })
  const controller = new AbortController()
  const generator = abortProvider.streamChat(chatRequest(), controller.signal)
  await generator.next()
  controller.abort()
  await delay(10)
  await assert.rejects(
    (async () => {
      for (;;) {
        const next = await generator.next()
        if (next.done) {return next.value}
      }
    })(),
    (error: unknown) => error instanceof ProviderError && error.code === 'aborted'
  )
})

test('replay provider reads cassettes by request hash and fails loudly on a miss', async (t) => {
  const upstream = await startMockUpstream((_request, response) => {
    response.writeHead(200, SSE_HEADERS)
    response.end(buildChatStream())
  })
  const temp = createTempDb()
  t.after(async () => {
    await upstream.close()
    await temp.cleanup()
  })

  const request = chatRequest()
  const recorded = await recordChat(request, {
    dir: path.join(temp.dir, 'cassettes'),
    liveOptions: { baseUrl: upstream.url, apiKey: 'test-key' },
  })
  assert.ok(existsSync(recorded.cassettePath))
  assert.equal(path.basename(recorded.cassettePath), `${chatRequestKey(request)}.json`)

  const cassette = await readCassette(request, { cassetteDir: path.join(temp.dir, 'cassettes') })
  assert.ok(cassette)
  assert.equal(cassette.version, 1)
  assert.equal(cassette.result.text, recorded.result.text)

  // File-based replay.
  const replay = createReplayProvider({ cassetteDir: path.join(temp.dir, 'cassettes') })
  const replayed = await replay.chatOnce(request)
  assert.deepEqual(replayed, recorded.result)

  // In-memory replay (tests/stubs).
  const inMemory = createReplayProvider({
    cassettes: { [chatRequestKey(request)]: cassette },
  })
  assert.equal((await inMemory.chatOnce(request)).text, recorded.result.text)

  // Explicit cassetteKey override (getChatProvider supports it too).
  const keyed = getChatProvider('replay', {
    cassettes: { 'custom-key': cassette },
    cassetteKey: 'custom-key',
  })
  assert.equal((await keyed.chatOnce(request)).title, recorded.result.title)

  // A different request is a loud miss — never a network fallback.
  const missRequest = chatRequest({ messages: [{ role: 'user', content: 'A different question' }] })
  await assert.rejects(
    replay.chatOnce(missRequest),
    (error: unknown) =>
      error instanceof ReplayMissError &&
      error.code === 'replay_miss' &&
      /Replay cassette missing/.test(error.message) &&
      error.cassettePath.endsWith(`${chatRequestKey(missRequest)}.json`)
  )
})

test('callJsonSchema uses the Responses API JSON-schema format', async (t) => {
  const upstream = await startMockUpstream((request, response) => {
    assert.equal(request.url, '/responses')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        id: 'resp_1',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: '{"pass": true, "score": 0.92}' }],
          },
        ],
      })
    )
  })
  const temp = createTempDb()
  t.after(async () => {
    await upstream.close()
    await temp.cleanup()
  })

  const call: JsonSchemaCall = {
    model: 'deepseek-flash',
    system: 'Grade the answer.',
    input: 'Q: refunds? A: 30 days.',
    schema: {
      type: 'object',
      properties: { pass: { type: 'boolean' }, score: { type: 'number' } },
      required: ['pass', 'score'],
      additionalProperties: false,
    },
    maxTokens: 128,
  }
  const parsed = await callJsonSchema<{ pass: boolean; score: number }>(call, {
    baseUrl: upstream.url,
    apiKey: 'test-key',
    mode: 'live',
  })
  assert.deepEqual(parsed, { pass: true, score: 0.92 })

  const captured = upstream.requests[0]
  assert.ok(captured)
  assert.equal(captured.headers.authorization, 'Bearer test-key')
  const sent = JSON.parse(captured.body.toString('utf8')) as Record<string, unknown>
  assert.equal(sent.model, 'deepseek-flash')
  assert.equal(sent.instructions, 'Grade the answer.')
  assert.equal(sent.input, 'Q: refunds? A: 30 days.')
  assert.equal(sent.temperature, 0)
  assert.deepEqual(sent.reasoning, { effort: 'none' })
  assert.deepEqual(sent.text, {
    format: {
      type: 'json_schema',
      name: 'result',
      schema: call.schema,
      strict: true,
    },
  })
  assert.equal(sent.max_output_tokens, 128)
})

test('callJsonSchema falls back to chat json_object when /responses is unavailable', async (t) => {
  const upstream = await startMockUpstream((request, response) => {
    if ((request.url ?? '').includes('/responses')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '{"pass": false}' } }],
      })
    )
  })
  const temp = createTempDb()
  t.after(async () => {
    await upstream.close()
    await temp.cleanup()
  })

  const call: JsonSchemaCall = {
    system: 'Grade the answer.',
    input: 'Q: refunds?',
    schema: {
      type: 'object',
      properties: { pass: { type: 'boolean' } },
      required: ['pass'],
      additionalProperties: false,
    },
  }
  const parsed = await callJsonSchema<{ pass: boolean }>(call, {
    baseUrl: upstream.url,
    apiKey: 'test-key',
    mode: 'live',
  })
  assert.deepEqual(parsed, { pass: false })
  assert.equal(upstream.requests.length, 2)
  const fallback = upstream.requests[1]
  assert.ok(fallback)
  assert.equal(fallback.url, '/chat/completions')
  const sent = JSON.parse(fallback.body.toString('utf8')) as Record<string, unknown>
  assert.deepEqual(sent.response_format, { type: 'json_object' })
  assert.match(JSON.stringify(sent.messages), /JSON Schema/)

  // Auth errors are not retried through the fallback.
  const authUpstream = await startMockUpstream((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'bad key' } }))
  })
  t.after(async () => {
    await authUpstream.close()
  })
  await assert.rejects(
    callJsonSchema(call, { baseUrl: authUpstream.url, apiKey: 'bad', mode: 'live' }),
    (error: unknown) =>
      error instanceof ProviderError && error.code === 'http_error' && error.status === 401
  )
  assert.equal(authUpstream.requests.length, 1)
})

test('callJsonSchema replay + record round-trips a judge call', async (t) => {
  const upstream = await startMockUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ output_text: '{"pass": true}' }))
  })
  const temp = createTempDb()
  t.after(async () => {
    await upstream.close()
    await temp.cleanup()
  })

  const call: JsonSchemaCall = {
    system: 'Grade.',
    input: 'answer',
    schema: {
      type: 'object',
      properties: { pass: { type: 'boolean' } },
      required: ['pass'],
      additionalProperties: false,
    },
  }
  const cassetteDir = path.join(temp.dir, 'cassettes')
  const recorded = await recordJsonSchema(call, {
    baseUrl: upstream.url,
    apiKey: 'test-key',
    cassettesDir: cassetteDir,
  })
  assert.deepEqual(recorded.result, { pass: true })
  assert.ok(existsSync(recorded.cassettePath))
  assert.equal(recorded.cassettePath, jsonSchemaCassettePath(call, cassetteDir))

  const replayed = await callJsonSchema<{ pass: boolean }>(call, {
    mode: 'replay',
    cassettesDir: cassetteDir,
  })
  assert.deepEqual(replayed, { pass: true })

  const other: JsonSchemaCall = { ...call, input: 'a different answer' }
  await assert.rejects(
    callJsonSchema(other, { mode: 'replay', cassettesDir: cassetteDir }),
    (error: unknown) => error instanceof ReplayMissError && error.code === 'replay_miss'
  )
})

test('rerankListwise returns every id ordered, dropping invented ids', async (t) => {
  const upstream = await startMockUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ output_text: '{"order": ["s3", "s1", "s9"]}' }))
  })
  const temp = createTempDb()
  t.after(async () => {
    await upstream.close()
    await temp.cleanup()
  })

  const ordered = await rerankListwise({
    query: 'refund window for digital goods',
    documents: [
      { id: 's1', text: 'Refunds within 30 days.' },
      { id: 's2', text: 'Team pricing.' },
      { id: 's3', text: 'Digital goods: 14 days.' },
    ],
    baseUrl: upstream.url,
    apiKey: 'test-key',
    mode: 'live',
  })
  // s9 is invented and dropped; s2 was omitted and keeps its original position.
  assert.deepEqual(ordered, ['s3', 's1', 's2'])
  const sent = JSON.parse(upstream.requests[0]?.body.toString('utf8') ?? '{}') as {
    instructions?: string
    input?: string
  }
  assert.match(sent.input ?? '', /\[s3\]/)
  assert.match(sent.instructions ?? '', /order/)
})

