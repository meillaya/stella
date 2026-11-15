import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import fastifyMultipart from '@fastify/multipart'
import Fastify, { type FastifyInstance } from 'fastify'
import type { RetrievedChunk } from '../../../shared/types.ts'
import { openDatabase, type Db } from '../../src/db/index.ts'
import { registerGateway, type GatewayOptions } from '../../src/gateway/index.ts'
import type { RetrieveFn } from '../../src/gateway/options.ts'
import { SseFrameDecoder, parseSseFrame } from '../../src/gateway/sse.ts'

/** Shared test helpers: mock upstream, gateway app, temp DB, SSE fixtures. */

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export type CapturedRequest = {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: Buffer
}

export type MockUpstream = {
  url: string
  port: number
  requests: CapturedRequest[]
  close: () => Promise<void>
  waitForRequests: (count?: number, timeoutMs?: number) => Promise<void>
}

export const startMockUpstream = async (
  handler: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    body: Buffer
  ) => void | Promise<void>
): Promise<MockUpstream> => {
  const requests: CapturedRequest[] = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      requests.push({
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: request.headers,
        body,
      })
      Promise.resolve()
        .then(() => handler(request, response, body))
        .catch((error: unknown) => {
          if (!response.headersSent) {response.writeHead(500, { 'content-type': 'text/plain' })}
          response.end(error instanceof Error ? error.message : String(error))
        })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
    waitForRequests: async (count = 1, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs
      while (requests.length < count) {
        if (Date.now() > deadline) {throw new Error(`timed out waiting for ${count} request(s)`)}
        await delay(10)
      }
    },
  }
}

export type TestGateway = {
  app: FastifyInstance
  url: string
  close: () => Promise<void>
}

export const startGateway = async (options: {
  upstreamUrl: string
  db: Db
  apiKey?: string | null
  now?: () => number
  retrieve?: RetrieveFn
  maxBodyBytes?: number
}): Promise<TestGateway> => {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 })
  // Mirrors server/src/index.ts: multipart is parsed by the plugin, while the
  // gateway streams request.raw upstream itself.
  await app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024, files: 4 } })
  const gatewayOptions: GatewayOptions = {
    baseUrl: options.upstreamUrl,
    db: options.db,
    apiKey: options.apiKey === undefined ? 'server-test-key' : options.apiKey,
    now: options.now,
    retrieve: options.retrieve,
    maxBodyBytes: options.maxBodyBytes,
  }
  registerGateway(app, gatewayOptions)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = (app.server.address() as AddressInfo).port
  return {
    app,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await app.close()
    },
  }
}

export type TempDb = {
  db: Db
  dir: string
  cleanup: () => Promise<void>
}

export const createTempDb = (): TempDb => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stella-gateway-'))
  const db = openDatabase(path.join(dir, 'stella.db'))
  return {
    db,
    dir,
    cleanup: async () => {
      try {
        db.close()
      } catch {
        // Already closed by the test.
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/* ------------------------------ SSE fixtures ------------------------------ */

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  'x-ds-request-id': 'req_test_1',
}

export const sseFrame = (event: string, payload: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`

export const messageStart = (usage: Record<string, number>) => ({
  type: 'message_start',
  message: { id: 'msg_test', model: 'deepseek-flash', usage },
})

export const messageDelta = (title: string | undefined, usage: Record<string, number>) => ({
  type: 'message_delta',
  delta: {
    stop_reason: 'end_turn',
    stop_sequence: null,
    ...(title === undefined ? {} : { title }),
  },
  usage,
})

export const DEFAULT_USAGE = {
  input_tokens: 100,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 50,
  output_tokens: 20,
}

export type DownstreamFrame = { raw: Buffer; event: string; data: string }

/** Split raw SSE bytes into complete frames (byte-exact, for fidelity checks). */
export const framesOf = (bytes: Buffer): DownstreamFrame[] => {
  const decoder = new SseFrameDecoder()
  const frames = [...decoder.push(bytes), ...decoder.end()]
  return frames.map((raw) => {
    const parsed = parseSseFrame(raw)
    return { raw, event: parsed?.event ?? '', data: parsed?.data ?? '' }
  })
}

export const payloadOf = (frame: DownstreamFrame): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(frame.data)
    assert.ok(parsed !== null && typeof parsed === 'object')
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `frame is not JSON (event=${frame.event}): ${frame.data.slice(0, 200)} — ${String(error)}`
    )
  }
}

export const writeInChunks = async (
  response: http.ServerResponse,
  text: string,
  chunkSizes: number[],
  pauseMs = 1
): Promise<void> => {
  const bytes = Buffer.from(text, 'utf8')
  let offset = 0
  let index = 0
  while (offset < bytes.length) {
    const size = chunkSizes[index % chunkSizes.length] as number
    response.write(bytes.subarray(offset, offset + size))
    offset += size
    index += 1
    if (pauseMs > 0) {await delay(pauseMs)}
  }
}

/** A full, protocol-shaped upstream chat stream (with comments and ping). */
export const buildChatStream = (options: {
  usage?: Record<string, number>
  title?: string
  text?: string
  thinkingText?: string
} = {}): string => {
  const usage = options.usage ?? DEFAULT_USAGE
  const text = options.text ?? 'Refunds are available within 30 days. 你好，世界 🌟'
  const thinkingText = options.thinkingText ?? '考虑一下退款政策。'
  return [
    sseFrame('message_start', messageStart({ ...usage, output_tokens: 0 })),
    ': keep-alive\n\n',
    sseFrame('ping', { type: 'ping' }),
    '',
    sseFrame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    }),
    sseFrame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: thinkingText },
    }),
    sseFrame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig_test' },
    }),
    sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseFrame('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    }),
    sseFrame('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text },
    }),
    sseFrame('content_block_stop', { type: 'content_block_stop', index: 1 }),
    sseFrame('message_delta', messageDelta(options.title ?? '退款政策', { ...usage })),
    sseFrame('message_stop', { type: 'message_stop' }),
  ].join('')
}

/* ------------------------------ request fixtures ------------------------------ */

export const chatBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'deepseek-flash',
  system: 'You are Stella, a support assistant.',
  messages: [
    { role: 'user', content: 'What is the refund policy?' },
    { role: 'assistant', content: [{ type: 'text', text: 'We refund within 30 days.' }] },
    { role: 'user', content: 'What about digital goods?' },
  ],
  thinking: { type: 'disabled' },
  tools: [],
  safety_check: { level: 'high' },
  stream: true,
  ...overrides,
})

export const postMessages = (
  gatewayUrl: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> =>
  fetch(`${gatewayUrl}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

/* ------------------------------ DB helpers ------------------------------ */

export type TraceDbRow = {
  id: string
  session_id: string | null
  session_key: string
  created_at: number
  status: string
  model: string
  thinking: number
  profile_id: string | null
  profile_name: string | null
  retrieval_enabled: number
  latency_ms: number
  ttfb_ms: number | null
  usage_json: string
  cost_usd: number
  pricing_basis: string
  request_json: string
  response_json: string
  injected_context: string | null
  retrieval_error: string | null
  error: string | null
  feedback: string | null
  annotation: string | null
}

export const traceRows = (db: Db): TraceDbRow[] =>
  db.prepare('SELECT * FROM traces ORDER BY created_at ASC').all() as unknown as TraceDbRow[]

export const waitForTrace = async (
  db: Db,
  count = 1,
  timeoutMs = 5000
): Promise<TraceDbRow> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const rows = traceRows(db)
    if (rows.length >= count) {return rows[count - 1] as TraceDbRow}
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${count} trace row(s); found ${rows.length}`)
    }
    await delay(10)
  }
}

export const sourceRows = (
  db: Db,
  traceId: string
): { ordinal: number; chunk_id: string; title: string; snippet: string }[] =>
  db
    .prepare(
      'SELECT ordinal, chunk_id, title, snippet FROM trace_sources WHERE trace_id = ? ORDER BY ordinal ASC'
    )
    .all(traceId) as unknown as { ordinal: number; chunk_id: string; title: string; snippet: string }[]

export const sessionRows = (db: Db): Record<string, unknown>[] =>
  db.prepare('SELECT * FROM sessions').all() as unknown as Record<string, unknown>[]

/* ------------------------------ RAG fixtures ------------------------------ */

export const fakeChunks = (): RetrievedChunk[] => [
  {
    id: 's1',
    chunkId: 'chk_1',
    documentId: 'doc_1',
    title: 'Refund policy',
    heading: 'Digital goods',
    page: 2,
    score: 0.91,
    snippet: 'Digital goods can be refunded within 14 days if unused.',
    text: 'Digital goods can be refunded within 14 days if unused. This policy supersedes the general 30-day window.',
  },
  {
    id: 's2',
    chunkId: 'chk_2',
    documentId: 'doc_2',
    title: 'Release notes',
    heading: null,
    page: null,
    score: 0.72,
    snippet: 'The digital-goods window changed to 14 days.',
    text: 'The digital-goods window changed to 14 days in release 4.2.',
  },
]

export const seedProfile = (
  db: Db,
  overrides: { retrieval?: Record<string, unknown>; template?: string } = {}
): string => {
  const id = 'prof_test'
  const spec = {
    model: { id: 'deepseek-flash', thinking: false, maxTokens: 2048 },
    retrieval: {
      enabled: true,
      collection: 'support',
      k: 4,
      candidates: 20,
      rerank: 'off',
      contextBudgetTokens: 1200,
      parentExpansion: true,
      ...overrides.retrieval,
    },
    prompt: { template: overrides.template ?? 'rag-v1', citationStyle: 'bracket' },
    judge: { rubric: 'judge-v1', passScore: 0.7 },
  }
  db.prepare(
    'INSERT INTO profiles(id, name, version, parent_id, spec_json, created_at, published_at) VALUES (?, ?, ?, NULL, ?, ?, ?)'
  ).run(id, 'Support RAG', 1, JSON.stringify(spec), Date.now(), Date.now())
  db.prepare(
    "INSERT INTO settings(key, value) VALUES ('active_profile_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(id)
  return id
}

export const fakeRetrieve = (input: {
  chunks?: RetrievedChunk[]
  error?: Error
  calls?: unknown[]
}): RetrieveFn => {
  return async (options) => {
    input.calls?.push(options)
    if (input.error) {throw input.error}
    return {
      chunks: input.chunks ?? fakeChunks(),
      collectionId: 'col_support',
      latencyMs: 5,
    }
  }
}
