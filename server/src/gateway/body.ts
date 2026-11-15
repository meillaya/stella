import { Readable } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * Raw request-body capture.
 *
 * The gateway must forward the client's JSON byte-for-byte when it does not
 * modify the body. A route-level `preParsing` hook buffers the raw bytes and
 * hands Fastify a replacement stream so normal JSON parsing still happens; the
 * handler reads the captured bytes from the per-route WeakMap. Multipart routes
 * stream straight from `request.raw` instead (never buffered for forwarding).
 */

export type RawBodyCapture = {
  preParsing: (
    request: FastifyRequest,
    reply: FastifyReply,
    payload: Readable
  ) => Promise<Readable>
  rawBody: (request: FastifyRequest) => Buffer | null
}

const TOO_LARGE = 'Request body exceeds the gateway limit'

export const createRawBodyCapture = (maxBytes: number): RawBodyCapture => {
  const bodies = new WeakMap<FastifyRequest, Buffer>()
  return {
    preParsing: async (request, _reply, payload) => {
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of payload) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        total += buffer.length
        if (total > maxBytes) {
          const error = new Error(TOO_LARGE)
          Object.assign(error, { statusCode: 413 })
          throw error
        }
        chunks.push(buffer)
      }
      const raw = Buffer.concat(chunks)
      bodies.set(request, raw)
      return Readable.from(raw)
    },
    rawBody: (request) => bodies.get(request) ?? null,
  }
}

/** Buffer an arbitrary readable stream (multipart uploads, tests). */
export const readStreamBody = async (
  stream: NodeJS.ReadableStream,
  maxBytes: number
): Promise<Buffer> => {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array)
    total += buffer.length
    if (total > maxBytes) {
      const error = new Error(TOO_LARGE)
      Object.assign(error, { statusCode: 413 })
      throw error
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** Convert a buffered body to a web ReadableStream for streaming upstream. */
export const bufferToWebStream = (buffer: Buffer): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      if (buffer.length > 0) {controller.enqueue(new Uint8Array(buffer))}
      controller.close()
    },
  })
