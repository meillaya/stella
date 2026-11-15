import { once } from 'node:events'
import type { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { log } from '../logger.ts'
import { createRawBodyCapture, type RawBodyCapture } from './body.ts'
import {
  MISSING_KEY_MESSAGE,
  forwardedClientHeaders,
  resolveAuth,
  type ResolvedGatewayOptions,
} from './options.ts'

/**
 * Buffered/pass-through proxies for everything the chat client calls besides
 * `/anthropic/v1/messages`:
 *
 * - `GET /models` (key verification; 200 when the gateway has a usable key);
 * - `POST|GET /anthropic/v1/files`, `DELETE /anthropic/v1/files/:id` (multipart
 *   uploads are streamed upstream, never buffered);
 * - `POST /v1/tools/asr` (multipart, streamed) and `/v1/tools/tts` (JSON in,
 *   audio bytes out).
 *
 * Upstream status codes and error bodies are preserved verbatim. Keys are only
 * ever placed in upstream request headers — never logged or echoed.
 */

const isJson = (contentType: string | null): boolean =>
  (contentType ?? '').includes('application/json')

const forwardedResponseHeaders = (upstream: Response): Record<string, string> => {
  const headers: Record<string, string> = {}
  const contentType = upstream.headers.get('content-type')
  if (contentType) {headers['content-type'] = contentType}
  for (const name of ['x-ds-request-id', 'request-id', 'retry-after']) {
    const value = upstream.headers.get(name)
    if (value) {headers[name] = value}
  }
  return headers
}

const plainError = (reply: FastifyReply, status: number, message: string, code?: string) =>
  reply
    .code(status)
    .header('content-type', 'application/json')
    .send({ error: { message, ...(code ? { code } : {}) } })

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

const upstreamFailure = async (
  reply: FastifyReply,
  error: unknown,
  aborted: boolean,
  shape: 'anthropic' | 'plain'
): Promise<void> => {
  if (aborted || reply.raw.destroyed) {return}
  const message = `Stella gateway could not reach the model upstream: ${
    error instanceof Error ? error.message : String(error)
  }`
  log.warn('gateway: upstream request failed', {
    message: error instanceof Error ? error.message : String(error),
  })
  if (shape === 'anthropic') {await anthropicError(reply, 502, 'api_error', message, 'upstream_unreachable')}
  else {await plainError(reply, 502, message, 'upstream_unreachable')}
}

const authOrReject = (
  request: FastifyRequest,
  reply: FastifyReply,
  options: ResolvedGatewayOptions,
  shape: 'anthropic' | 'plain'
): string | null => {
  const auth = resolveAuth(request, options.serverKey)
  if (auth) {return auth.key}
  if (shape === 'anthropic') {
    void anthropicError(reply, 401, 'authentication_error', MISSING_KEY_MESSAGE, 'missing_api_key')
  } else {
    void plainError(reply, 401, MISSING_KEY_MESSAGE, 'missing_api_key')
  }
  return null
}

const sendBuffered = async (reply: FastifyReply, upstream: Response): Promise<void> => {
  const bytes = Buffer.from(await upstream.arrayBuffer())
  if (reply.raw.destroyed) {return}
  void reply
    .code(upstream.status)
    .headers(forwardedResponseHeaders(upstream))
    .send(bytes)
}

/** Stream an upstream byte stream straight through to the client. */
const pumpUpstream = async (reply: FastifyReply, upstream: Response): Promise<void> => {
  reply.hijack()
  const headers: Record<string, string> = {}
  const contentType = upstream.headers.get('content-type')
  if (contentType) {headers['content-type'] = contentType}
  for (const name of ['x-ds-request-id', 'content-length']) {
    const value = upstream.headers.get(name)
    if (value) {headers[name] = value}
  }
  reply.raw.writeHead(upstream.status, headers)
  const reader = upstream.body?.getReader()
  if (!reader) {
    if (!reply.raw.destroyed) {reply.raw.end()}
    return
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {break}
      if (reply.raw.destroyed) {
        await reader.cancel().catch(() => {})
        return
      }
      if (!reply.raw.write(Buffer.from(value))) {
        try {
          await Promise.race([once(reply.raw, 'drain'), once(reply.raw, 'close')])
        } catch {
          await reader.cancel().catch(() => {})
          return
        }
        if (reply.raw.destroyed) {
          await reader.cancel().catch(() => {})
          return
        }
      }
    }
  } catch (error) {
    log.warn('gateway: streaming proxy failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    try {
      await reader.cancel()
    } catch {
      // Already gone.
    }
  } finally {
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {reply.raw.end()}
  }
}

type Cancellable = { controller: AbortController; release: () => void }

const cancellable = (reply: FastifyReply): Cancellable => {
  const controller = new AbortController()
  let finished = false
  const onClose = () => {
    if (!finished) {controller.abort()}
  }
  reply.raw.on('close', onClose)
  return {
    controller,
    release: () => {
      finished = true
      reply.raw.off('close', onClose)
    },
  }
}

const streamToWeb = (stream: NodeJS.ReadableStream): ReadableStream<Uint8Array> => {
  const nodeStream = stream as Readable
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk: Buffer | string) => {
        controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk))
      })
      nodeStream.on('end', () => controller.close())
      nodeStream.on('error', (error: Error) => controller.error(error))
    },
    cancel() {
      nodeStream.destroy()
    },
  })
}

const postMultipart = async (
  request: FastifyRequest,
  reply: FastifyReply,
  options: ResolvedGatewayOptions,
  upstreamPath: string,
  authStyle: 'anthropic' | 'bearer',
  shape: 'anthropic' | 'plain'
): Promise<void> => {
  const key = authOrReject(request, reply, options, shape)
  if (!key) {return}
  const { controller, release } = cancellable(reply)
  try {
    const headers: Record<string, string> = {
      ...forwardedClientHeaders(request),
      ...(authStyle === 'anthropic'
        ? { 'x-api-key': key }
        : { authorization: `Bearer ${key}` }),
    }
    const contentType = request.headers['content-type']
    if (contentType) {headers['content-type'] = contentType}
    const upstream = await options.fetchImpl(`${options.baseUrl}${upstreamPath}`, {
      method: 'POST',
      headers,
      body: streamToWeb(request.raw),
      duplex: 'half',
      signal: controller.signal,
    } as RequestInit & { duplex: 'half' })
    await sendBuffered(reply, upstream)
  } catch (error) {
    await upstreamFailure(reply, error, controller.signal.aborted, shape)
  } finally {
    release()
  }
}

export const registerProxyRoutes = (
  app: FastifyInstance,
  options: ResolvedGatewayOptions
): void => {
  /* ------------------------------ /models ------------------------------ */

  app.get('/models', async (request, reply) => {
    const key = authOrReject(request, reply, options, 'plain')
    if (!key) {return}
    const { controller, release } = cancellable(reply)
    try {
      const upstream = await options.fetchImpl(`${options.baseUrl}/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${key}` },
        signal: controller.signal,
      })
      await sendBuffered(reply, upstream)
    } catch (error) {
      await upstreamFailure(reply, error, controller.signal.aborted, 'plain')
    } finally {
      release()
    }
  })

  /* ------------------------------ Files API ------------------------------ */

  app.post('/anthropic/v1/files', async (request, reply) => {
    await postMultipart(request, reply, options, '/anthropic/v1/files', 'anthropic', 'anthropic')
  })

  app.get('/anthropic/v1/files', async (request, reply) => {
    const key = authOrReject(request, reply, options, 'anthropic')
    if (!key) {return}
    const { controller, release } = cancellable(reply)
    try {
      const upstream = await options.fetchImpl(`${options.baseUrl}/anthropic/v1/files`, {
        method: 'GET',
        headers: { 'x-api-key': key, ...forwardedClientHeaders(request) },
        signal: controller.signal,
      })
      await sendBuffered(reply, upstream)
    } catch (error) {
      await upstreamFailure(reply, error, controller.signal.aborted, 'anthropic')
    } finally {
      release()
    }
  })

  app.get('/anthropic/v1/files/:id', async (request, reply) => {
    const key = authOrReject(request, reply, options, 'anthropic')
    if (!key) {return}
    const id = (request.params as { id: string }).id
    const { controller, release } = cancellable(reply)
    try {
      const upstream = await options.fetchImpl(
        `${options.baseUrl}/anthropic/v1/files/${encodeURIComponent(id)}`,
        {
          method: 'GET',
          headers: { 'x-api-key': key, ...forwardedClientHeaders(request) },
          signal: controller.signal,
        }
      )
      await sendBuffered(reply, upstream)
    } catch (error) {
      await upstreamFailure(reply, error, controller.signal.aborted, 'anthropic')
    } finally {
      release()
    }
  })

  app.delete('/anthropic/v1/files/:id', async (request, reply) => {
    const key = authOrReject(request, reply, options, 'anthropic')
    if (!key) {return}
    const id = (request.params as { id: string }).id
    const { controller, release } = cancellable(reply)
    try {
      const upstream = await options.fetchImpl(
        `${options.baseUrl}/anthropic/v1/files/${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
          headers: { 'x-api-key': key, ...forwardedClientHeaders(request) },
          signal: controller.signal,
        }
      )
      await sendBuffered(reply, upstream)
    } catch (error) {
      await upstreamFailure(reply, error, controller.signal.aborted, 'anthropic')
    } finally {
      release()
    }
  })

  /* ------------------------------ tool endpoints ------------------------------ */

  app.post('/v1/tools/asr', async (request, reply) => {
    await postMultipart(request, reply, options, '/v1/tools/asr', 'bearer', 'plain')
  })

  app.post('/v1/tools/tts', { preParsing: ttsCapture.preParsing }, async (request, reply) => {
    const key = authOrReject(request, reply, options, 'plain')
    if (!key) {return}
    const { controller, release } = cancellable(reply)
    const raw = ttsCapture.rawBody(request)
    const body = raw && raw.length > 0 ? raw : Buffer.from(JSON.stringify(request.body ?? {}), 'utf8')
    try {
      const upstream = await options.fetchImpl(`${options.baseUrl}/v1/tools/tts`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          accept: 'audio/*, application/octet-stream',
        },
        body,
        signal: controller.signal,
      })
      if (isJson(upstream.headers.get('content-type')) || !upstream.ok) {
        await sendBuffered(reply, upstream)
      } else {
        await pumpUpstream(reply, upstream)
      }
    } catch (error) {
      await upstreamFailure(reply, error, controller.signal.aborted, 'plain')
    } finally {
      release()
    }
  })
}

const ttsCapture: RawBodyCapture = createRawBodyCapture(1024 * 1024)
