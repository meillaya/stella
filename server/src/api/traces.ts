import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Feedback, TraceStatus } from '../../../shared/types.ts'
import { getDb, type Db } from '../db/index.ts'
import {
  getTraceRow,
  listTraceSummaries,
  patchTrace,
  rowToTrace,
} from '../gateway/trace-store.ts'

/**
 * Traces API (docs/API.md):
 * - `GET  /api/traces`       filters + cursor
 * - `GET  /api/traces/:id`   full trace
 * - `PATCH /api/traces/:id`  feedback / annotation
 *
 * `POST /api/traces/:id/promote` is owned by the eval workstream and is NOT
 * registered here (avoids duplicate-route errors; promote creates dataset cases).
 *
 * Wire-up (lead): `registerTracesApi(app)` inside `registerApi`.
 */

export type TracesApiOptions = {
  /** Override the database (tests). Defaults to the process DB. */
  db?: Db
}

const apiError = (
  reply: FastifyReply,
  status: number,
  message: string,
  code?: string
): FastifyReply =>
  reply
    .code(status)
    .header('content-type', 'application/json')
    .send({ error: { message, ...(code ? { code } : {}) } })

const VALID_FEEDBACK = new Set(['up', 'down', 'none'])
const VALID_STATUSES = new Set<TraceStatus>(['ok', 'error', 'aborted', 'interrupted'])

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

export const registerTracesApi = (
  app: FastifyInstance,
  options: TracesApiOptions = {}
): void => {
  const db = (): Db => options.db ?? getDb()

  app.get('/api/traces', async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>
    const limitRaw = Number(query.limit)
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 50
    const feedbackRaw = asString(query.feedback)
    const feedback =
      feedbackRaw && VALID_FEEDBACK.has(feedbackRaw)
        ? (feedbackRaw as Feedback | 'none')
        : null
    const statusRaw = asString(query.status)
    const statuses = statusRaw
      ? (statusRaw
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry): entry is TraceStatus => VALID_STATUSES.has(entry as TraceStatus)))
      : null
    try {
      return listTraceSummaries(db(), {
        limit,
        cursor: asString(query.cursor),
        feedback,
        status: statuses && statuses.length > 0 ? statuses : null,
        q: asString(query.q),
        profileId: asString(query.profileId),
      })
    } catch (error) {
      return apiError(
        reply,
        500,
        `Could not read traces: ${error instanceof Error ? error.message : String(error)}`,
        'db_error'
      )
    }
  })

  app.get('/api/traces/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id
    try {
      const row = getTraceRow(db(), id)
      if (!row) {return apiError(reply, 404, `Trace not found: ${id}`, 'not_found')}
      return rowToTrace(db(), row)
    } catch (error) {
      return apiError(
        reply,
        500,
        `Could not read trace: ${error instanceof Error ? error.message : String(error)}`,
        'db_error'
      )
    }
  })

  app.patch('/api/traces/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id
    const body: unknown = request.body ?? {}
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return apiError(reply, 400, 'Body must be a JSON object', 'invalid_input')
    }
    const patch: { feedback?: Feedback | null; annotation?: string | null } = {}
    const record = body as Record<string, unknown>
    if ('feedback' in record) {
      const feedback = record.feedback
      if (feedback !== null && feedback !== 'up' && feedback !== 'down') {
        return apiError(reply, 400, "feedback must be 'up', 'down' or null", 'invalid_input')
      }
      patch.feedback = feedback as Feedback | null
    }
    if ('annotation' in record) {
      const annotation = record.annotation
      if (annotation !== null && typeof annotation !== 'string') {
        return apiError(reply, 400, 'annotation must be a string or null', 'invalid_input')
      }
      patch.annotation = annotation as string | null
    }
    if (Object.keys(patch).length === 0) {
      return apiError(reply, 400, 'PATCH body must include feedback and/or annotation', 'invalid_input')
    }
    try {
      const trace = patchTrace(db(), id, patch)
      if (!trace) {return apiError(reply, 404, `Trace not found: ${id}`, 'not_found')}
      return trace
    } catch (error) {
      return apiError(
        reply,
        500,
        `Could not update trace: ${error instanceof Error ? error.message : String(error)}`,
        'db_error'
      )
    }
  })
}
