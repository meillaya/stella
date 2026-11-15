/**
 * Collections + retrieval HTTP API (docs/API.md, owner: RAG workstream).
 *
 * Routes:
 *   GET    /api/collections
 *   POST   /api/collections                      { name, description? }
 *   GET    /api/collections/:id/documents
 *   POST   /api/collections/:id/documents         multipart field "file" (max 100 MB)
 *   POST   /api/collections/:id/urls              { urls: string[] }
 *   DELETE /api/documents/:id
 *   POST   /api/collections/:id/search            { query, k?, rerank? }
 *
 * Errors always use `{ error: { message, code? } }`. `:id` accepts a collection
 * id or its unique name (the UI passes ids; CLI callers may pass names).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../db/index.ts'
import { getDb } from '../db/index.ts'
import { log } from '../logger.ts'
import {
  createCollection,
  deleteDocument,
  getDocument,
  ingestFile,
  ingestUrls,
  listCollections,
  listDocuments,
  resolveCollection,
  searchCollection,
} from '../rag/index.ts'
import { isRagError, type RagErrorCode } from '../rag/contract.ts'

export type CollectionsApiOptions = {
  /** Optional database override (tests/CLI sandboxes). Defaults to the process DB. */
  db?: Db
}

const MAX_FILE_BYTES = 100 * 1024 * 1024

const STATUS_BY_CODE: Record<RagErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
  unsupported_type: 415,
  too_large: 413,
  no_api_key: 400,
  upstream_error: 502,
}

const sendError = (
  reply: FastifyReply,
  status: number,
  message: string,
  code?: string
): FastifyReply => reply.code(status).send({ error: { message, ...(code ? { code } : {}) } })

const handleError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (isRagError(error)) {
    return sendError(reply, STATUS_BY_CODE[error.code] ?? 500, error.message, error.code)
  }
  const code = (error as { code?: unknown }).code
  if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT') {
    return sendError(reply, 413, 'File exceeds the 100 MB upload limit', 'too_large')
  }
  if (code === 'FST_PARTS_LIMIT' || code === 'FST_FIELDS_LIMIT' || code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
    return sendError(reply, 400, 'Malformed multipart upload')
  }
  log.error('collections API error', error)
  const message = error instanceof Error && error.message ? error.message : 'Internal error'
  return sendError(reply, 500, message, 'internal_error')
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

const asPositiveInt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {return Math.floor(value)}
  if (typeof value === 'string' && /^\d+$/.test(value)) {return Number(value)}
  return undefined
}

const parseRerank = (value: unknown): 'off' | 'llm' | undefined =>
  value === 'llm' || value === 'off' ? value : undefined

const routeParams = (request: FastifyRequest): { id: string } => {
  const params = request.params as { id?: unknown } | undefined
  return { id: typeof params?.id === 'string' ? params.id : '' }
}

/** Register the collections/document/search routes. Called from `api/router.ts`. */
export const registerCollectionsApi = (app: FastifyInstance, options?: CollectionsApiOptions): void => {
  const database = (): Db => options?.db ?? getDb()

  app.get('/api/collections', async () => ({ items: listCollections(database()) }))

  app.post('/api/collections', async (request, reply) => {
    try {
      const body = asRecord(request.body)
      if (!body) {return sendError(reply, 400, 'Expected a JSON body with a collection name')}
      const created = createCollection(
        {
          name: asString(body.name),
          description: body.description === undefined ? undefined : asString(body.description),
        },
        database()
      )
      return reply.code(200).send(created)
    } catch (error) {
      return handleError(reply, error)
    }
  })

  app.get('/api/collections/:id/documents', async (request, reply) => {
    try {
      const db = database()
      const collection = resolveCollection(routeParams(request).id, db)
      if (!collection) {return sendError(reply, 404, 'Collection not found', 'not_found')}
      return { items: listDocuments(collection.id, db) }
    } catch (error) {
      return handleError(reply, error)
    }
  })

  app.post('/api/collections/:id/documents', async (request, reply) => {
    try {
      const db = database()
      const collection = resolveCollection(routeParams(request).id, db)
      if (!collection) {return sendError(reply, 404, 'Collection not found', 'not_found')}
      if (!request.isMultipart()) {
        return sendError(reply, 400, 'Expected multipart/form-data with a "file" field')
      }
      const file = await request.file()
      if (!file) {return sendError(reply, 400, 'Missing multipart "file" field')}
      if ((file.file as { truncated?: boolean }).truncated) {
        return sendError(reply, 413, 'File exceeds the 100 MB upload limit', 'too_large')
      }
      const buffer = await file.toBuffer()
      if (buffer.byteLength === 0) {return sendError(reply, 400, 'Uploaded file is empty', 'invalid_input')}
      if (buffer.byteLength > MAX_FILE_BYTES) {
        return sendError(reply, 413, 'File exceeds the 100 MB upload limit', 'too_large')
      }
      const result = await ingestFile(
        {
          collectionId: collection.id,
          fileName: file.filename || 'document',
          mimeType: file.mimetype,
          data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
        },
        db
      )
      return { document: result.document, chunks: result.chunks }
    } catch (error) {
      return handleError(reply, error)
    }
  })

  app.post('/api/collections/:id/urls', async (request, reply) => {
    try {
      const db = database()
      const collection = resolveCollection(routeParams(request).id, db)
      if (!collection) {return sendError(reply, 404, 'Collection not found', 'not_found')}
      const body = asRecord(request.body)
      const urls = Array.isArray(body?.urls)
        ? body.urls.filter((url): url is string => typeof url === 'string')
        : []
      if (urls.length === 0) {return sendError(reply, 400, 'Expected a JSON body with a non-empty "urls" array')}
      const result = await ingestUrls({ collectionId: collection.id, urls }, db)
      return { documents: result.documents, errors: result.errors }
    } catch (error) {
      return handleError(reply, error)
    }
  })

  app.delete('/api/documents/:id', async (request, reply) => {
    try {
      const db = database()
      const { id } = routeParams(request)
      if (!id) {return sendError(reply, 400, 'Document id is required', 'invalid_input')}
      const document = getDocument(id, db)
      if (!document) {return sendError(reply, 404, 'Document not found', 'not_found')}
      deleteDocument(id, db)
      return { ok: true }
    } catch (error) {
      return handleError(reply, error)
    }
  })

  app.post('/api/collections/:id/search', async (request, reply) => {
    try {
      const db = database()
      const collection = resolveCollection(routeParams(request).id, db)
      if (!collection) {return sendError(reply, 404, 'Collection not found', 'not_found')}
      const body = asRecord(request.body)
      const query = asString(body?.query).trim()
      if (!query) {return sendError(reply, 400, 'Query is required', 'invalid_input')}
      const results = await searchCollection({
        collectionId: collection.id,
        query,
        k: asPositiveInt(body?.k),
        rerank: parseRerank(body?.rerank),
        db,
      })
      return { results }
    } catch (error) {
      return handleError(reply, error)
    }
  })
}
