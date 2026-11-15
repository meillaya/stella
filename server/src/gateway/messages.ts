import { once } from 'node:events'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { newId } from '../../../shared/ids.ts'
import {
  asModelId,
  computeCost,
  pricingBasis as pricingBasisAt,
} from '../../../shared/pricing.ts'
import type {
  SourceRef,
  TokenUsage,
  TraceResponse,
  TraceStatus,
} from '../../../shared/types.ts'
import { log } from '../logger.ts'
import { emptyUsage, normalizeUsage } from '../providers/contracts.ts'
import { createRawBodyCapture, type RawBodyCapture } from './body.ts'
import { injectRetrieval } from './injection.ts'
import {
  MISSING_KEY_MESSAGE,
  forwardedClientHeaders,
  resolveAuth,
  type ResolvedGatewayOptions,
} from './options.ts'
import { loadActiveProfile } from './profile.ts'
import { MessagesCapture } from './stream-capture.ts'
import { SseFrameDecoder, parseSseFrame } from './sse.ts'
import { contentText, insertTrace, sessionKeyOf } from './trace-store.ts'
import { augmentUsageFrame, compactSources, type UsageInjection } from './usage-injection.ts'

/**
 * POST /anthropic/v1/messages — streaming Messages proxy with trace capture.
 *
 * The response is a byte-faithful copy of the upstream SSE stream with one
 * exception: the usage object of `message_start` and `message_delta` is
 * augmented with `lantern_*` provenance/cost keys (chat-demo stores the whole
 * usage object, so the UI can show trace id, sources, cost and latency without
 * a second request). Every trace (ok/error/aborted/interrupted) is persisted.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const anthropicError = (
  reply: FastifyReply,
  status: number,
  type: string,
  message: string,
  code?: string
) =>
  reply
    .code(status)
    .header('content-type', 'application/json')
    .send({ type: 'error', error: { type, message, ...(code ? { code } : {}) } })

const errorMessageFromBody = (raw: Buffer, status: number): string => {
  const text = raw.toString('utf8')
  try {
    const parsed: unknown = JSON.parse(text)
    if (isRecord(parsed)) {
      if (isRecord(parsed.error) && typeof parsed.error.message === 'string') {
        return parsed.error.message
      }
      if (typeof parsed.message === 'string') {return parsed.message}
    }
  } catch {
    // Non-JSON upstream error body.
  }
  return text.trim().slice(0, 500) || `Upstream returned HTTP ${status}`
}

type TraceSetup = {
  traceId: string
  sessionKey: string
  createdAt: number
  model: string
  thinking: boolean
  profileId: string | null
  profileName: string | null
  retrievalEnabled: boolean
  request: unknown
  sources: SourceRef[]
  injectedContext: string | null
}

const writeChunk = async (reply: FastifyReply, chunk: Buffer): Promise<boolean> => {
  const raw = reply.raw
  if (raw.destroyed || raw.writableEnded) {return false}
  try {
    if (raw.write(chunk)) {return true}
  } catch {
    return false
  }
  try {
    await Promise.race([once(raw, 'drain'), once(raw, 'close')])
  } catch {
    return false
  }
  return !raw.destroyed && !raw.writableEnded
}

const observeCompleteMessage = (capture: MessagesCapture, payload: unknown): void => {
  if (!isRecord(payload)) {return}
  const message = isRecord(payload.message) ? payload.message : payload
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      capture.observePayload({ type: 'content_block_start', content_block: block })
    }
  }
  if (isRecord(message.usage)) {
    capture.usage = normalizeUsage(message.usage)
    capture.sawUsageDelta = true
  }
  if (typeof message.stop_reason === 'string') {capture.stopReason = message.stop_reason}
  if (typeof message.title === 'string') {capture.title = message.title}
  if (typeof message.stop_sequence !== 'string' && message.type === 'message') {
    capture.sawMessageStart = true
    capture.sawMessageStop = true
  }
}

export const handleMessagesRequest = async (
  request: FastifyRequest,
  reply: FastifyReply,
  options: ResolvedGatewayOptions,
  rawBody: Buffer | null
): Promise<void> => {
  const wallStart = performance.now()
  const createdAt = options.now()
  const db = options.getDb()
  const bodyValue: unknown = request.body
  if (!isRecord(bodyValue)) {
    await anthropicError(reply, 400, 'invalid_request_error', 'Request body must be a JSON object.')
    return
  }
  const body = bodyValue
  const auth = resolveAuth(request, options.serverKey)
  if (!auth) {
    await anthropicError(reply, 401, 'authentication_error', MISSING_KEY_MESSAGE, 'missing_api_key')
    return
  }

  let profile: ReturnType<typeof loadActiveProfile> = null
  try {
    profile = loadActiveProfile(db)
  } catch (error) {
    log.warn('gateway: could not load active profile', {
      message: error instanceof Error ? error.message : String(error),
    })
  }
  const systemText =
    typeof body.system === 'string'
      ? body.system
      : body.system === undefined
        ? ''
        : contentText(body.system)
  const messagesValue = body.messages
  const model =
    typeof body.model === 'string' && body.model.trim()
      ? body.model.trim()
      : (profile?.spec.model.id ?? 'deepseek-flash')
  const thinking =
    isRecord(body.thinking) ? body.thinking.type === 'enabled' : body.thinking === true

  const injection = await injectRetrieval({ body, profile, db, retrieve: options.retrieve })
  const effectiveBody = injection.mutatedBody ?? body
  const wantsStream = body.stream === true

  const setup: TraceSetup = {
    traceId: newId('tr'),
    sessionKey: sessionKeyOf(systemText, messagesValue),
    createdAt,
    model,
    thinking,
    profileId: profile?.id ?? null,
    profileName: profile?.name ?? null,
    retrievalEnabled: injection.retrievalEnabled,
    request: effectiveBody,
    sources: injection.sources,
    injectedContext: injection.injectedContext,
  }

  const finish = (input: {
    status: TraceStatus
    ttfbMs: number | null
    capture: MessagesCapture | null
    usage?: TokenUsage
    error: string | null
  }): void => {
    const latencyMs = Math.max(0, Math.round(performance.now() - wallStart))
    const response: TraceResponse = input.capture
      ? input.capture.response()
      : { text: '', thinking: null, stopReason: null, title: null, toolCalls: 0, citations: [] }
    const usage = input.usage ?? input.capture?.finalUsage() ?? emptyUsage()
    const cost = computeCost(usage, asModelId(model), createdAt)
    try {
      insertTrace(db, {
        id: setup.traceId,
        sessionKey: setup.sessionKey,
        createdAt,
        status: input.status,
        model,
        thinking,
        profileId: profile?.id ?? null,
        profileName: profile?.name ?? null,
        retrievalEnabled: injection.retrievalEnabled,
        latencyMs,
        ttfbMs: input.ttfbMs,
        usage,
        costUsd: cost.usd,
        pricingBasis: cost.basis,
        request: body,
        response,
        sources: injection.sources,
        injectedContext: injection.injectedContext,
        retrievalError: injection.retrievalError,
        error: input.error,
      })
      log.debug('gateway: trace stored', {
        traceId: setup.traceId,
        status: input.status,
        latencyMs,
      })
    } catch (error) {
      log.error('gateway: failed to store trace', {
        traceId: setup.traceId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const usageInjection: UsageInjection = {
    traceId: setup.traceId,
    sources: compactSources(injection.sources),
    pricingBasis: pricingBasisAt(createdAt),
  }

  const upstreamHeaders: Record<string, string> = {
    'content-type': 'application/json',
    accept: wantsStream ? 'text/event-stream' : 'application/json',
    'x-api-key': auth.key,
    ...forwardedClientHeaders(request),
  }
  const upstreamBody = injection.mutatedBody
    ? Buffer.from(JSON.stringify(injection.mutatedBody), 'utf8')
    : (rawBody ?? Buffer.from(JSON.stringify(body), 'utf8'))

  const controller = new AbortController()
  let clientAborted = false
  let streamFinished = false
  const onClientClose = () => {
    if (!streamFinished) {
      clientAborted = true
      controller.abort()
    }
  }
  reply.raw.on('close', onClientClose)

  const upstreamUrl = `${options.baseUrl}${request.raw.url ?? request.url}`
  let upstream: Response
  try {
    upstream = await options.fetchImpl(upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: upstreamBody,
      signal: controller.signal,
    })
  } catch (error) {
    streamFinished = true
    const aborted = clientAborted || controller.signal.aborted
    finish({
      status: aborted ? 'aborted' : 'error',
      ttfbMs: null,
      capture: null,
      error: aborted
        ? 'Client disconnected before the upstream response started.'
        : `Could not reach the model upstream: ${error instanceof Error ? error.message : String(error)}`,
    })
    if (!aborted && !reply.raw.destroyed) {
      await anthropicError(
        reply,
        502,
        'api_error',
        `Stella gateway could not reach the model upstream: ${error instanceof Error ? error.message : String(error)}`,
        'upstream_unreachable'
      )
    }
    return
  }

  const contentType = upstream.headers.get('content-type') ?? ''
  const isSse = contentType.includes('text/event-stream')

  if (!upstream.ok || !isSse || !wantsStream) {
    let bytes: Buffer
    try {
      bytes = Buffer.from(await upstream.arrayBuffer())
    } catch (error) {
      streamFinished = true
      const aborted = clientAborted || controller.signal.aborted
      finish({
        status: aborted ? 'aborted' : 'error',
        ttfbMs: null,
        capture: null,
        error: aborted ? 'Client disconnected while reading the upstream response.' : String(error),
      })
      return
    }
    streamFinished = true
    const capture = new MessagesCapture()
    if (bytes.length > 0) {
      try {
        const parsed: unknown = JSON.parse(bytes.toString('utf8'))
        if (upstream.ok && !isSse && !wantsStream) {
          observeCompleteMessage(capture, parsed)
        } else {
          capture.observePayload(parsed)
        }
      } catch {
        // Non-JSON body: leave the capture empty.
      }
    }
    let status: TraceStatus
    let error: string | null = null
    if (!upstream.ok) {
      status = 'error'
      error = errorMessageFromBody(bytes, upstream.status)
      capture.error ??= error
    } else if (!isSse && wantsStream) {
      status = 'error'
      error = 'Upstream returned a non-SSE response for a streaming request.'
      capture.error ??= error
    } else {
      status = 'ok'
    }
    finish({ status, ttfbMs: null, capture, error })
    if (reply.raw.destroyed) {return}
    const headers: Record<string, string> = { 'x-stella-trace-id': setup.traceId }
    if (contentType) {headers['content-type'] = contentType}
    for (const name of ['x-ds-request-id', 'request-id', 'retry-after']) {
      const value = upstream.headers.get(name)
      if (value) {headers[name] = value}
    }
    reply.code(upstream.status).headers(headers).send(bytes)
    return
  }

  // Stream: hijack so bytes go out exactly as received (with injected usage frames).
  reply.hijack()
  reply.raw.writeHead(upstream.status, {
    'content-type': contentType,
    'cache-control': 'no-cache, no-transform',
    'x-stella-trace-id': setup.traceId,
    'x-accel-buffering': 'no',
  })

  const decoder = new SseFrameDecoder()
  const capture = new MessagesCapture()
  let ttfbMs: number | null = null
  let streamError: string | null = null

  const emitFrame = async (frame: Buffer): Promise<boolean> => {
    let outgoing = frame
    const parsed = parseSseFrame(frame)
    if (parsed) {
      let payload: unknown
      try {
        payload = JSON.parse(parsed.data)
      } catch {
        payload = undefined
        if (parsed.event === 'error') {
          capture.error ??= parsed.data.trim() || 'Upstream sent an error frame'
        }
      }
      if (isRecord(payload)) {
        capture.observePayload(payload, parsed.event)
        if (payload.type === 'message_start') {
          outgoing = augmentUsageFrame(frame, 'message_start', usageInjection)
        } else if (payload.type === 'message_delta') {
          const cost = computeCost(capture.finalUsage(), asModelId(model), createdAt)
          outgoing = augmentUsageFrame(frame, 'message_delta', usageInjection, {
            costUsd: cost.usd,
            latencyMs: performance.now() - wallStart,
          })
        }
      }
    }
    const wrote = await writeChunk(reply, outgoing)
    if (wrote && ttfbMs === null) {ttfbMs = Math.round(performance.now() - wallStart)}
    return wrote
  }

  const responseBody = upstream.body
  try {
    if (!responseBody) {throw new Error('upstream response body is unavailable')}
    const reader = responseBody.getReader()
    let aborted = false
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {break}
      for (const frame of decoder.push(value)) {
        if (!(await emitFrame(frame))) {
          aborted = true
          break
        }
      }
      if (aborted) {
        try {
          await reader.cancel()
        } catch {
          // The client is gone; nothing to release.
        }
        break
      }
    }
    if (!aborted && !clientAborted) {
      for (const frame of decoder.end()) {
        if (!(await emitFrame(frame))) {break}
      }
    }
  } catch (error) {
    if (!clientAborted && !controller.signal.aborted) {
      streamError = error instanceof Error ? error.message : String(error)
    }
  }

  streamFinished = true
  try {
    if (!reply.raw.destroyed) {reply.raw.end()}
  } catch {
    // Socket already gone.
  }

  let status: TraceStatus
  let error: string | null
  if (clientAborted || controller.signal.aborted) {
    status = 'aborted'
    error = 'Client disconnected before the response completed.'
  } else if (streamError) {
    status = 'error'
    error = `Upstream stream failed: ${streamError}`
  } else if (capture.error) {
    status = 'error'
    error = capture.error
  } else if (capture.sawMessageStop) {
    status = 'ok'
    error = null
  } else {
    status = 'interrupted'
    error = 'Upstream stream ended before message_stop; the response is incomplete.'
  }
  finish({ status, ttfbMs, capture, error })
}

export const registerMessagesRoutes = (
  app: FastifyInstance,
  options: ResolvedGatewayOptions
): void => {
  const capture: RawBodyCapture = createRawBodyCapture(options.maxBodyBytes)
  app.post(
    '/anthropic/v1/messages',
    { preParsing: capture.preParsing },
    async (request, reply) => {
      try {
        await handleMessagesRequest(request, reply, options, capture.rawBody(request))
      } catch (error) {
        log.error('gateway: messages handler failed', {
          message: error instanceof Error ? error.message : String(error),
        })
        if (!reply.raw.headersSent && !reply.sent) {
          await anthropicError(reply, 500, 'api_error', 'Stella gateway failed to proxy the request.')
        } else if (!reply.raw.destroyed) {
          reply.raw.end()
        }
      }
    }
  )
}
