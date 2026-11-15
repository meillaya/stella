import { createHash } from 'node:crypto'
import { newId } from '../../../shared/ids.ts'
import type {
  Feedback,
  PricingBasis,
  SourceRef,
  TokenUsage,
  Trace,
  TraceResponse,
  TraceStatus,
  TraceSummary,
} from '../../../shared/types.ts'
import { transaction, type Db } from '../db/index.ts'

/**
 * Trace persistence and read helpers.
 *
 * The traces/trace_sources/sessions schema is owned by the lead; this module
 * only writes the existing columns. `request_json` holds the request body as
 * actually sent upstream (after RAG injection); `injected_context` holds the
 * exact injected source block; sources are normalised in `trace_sources`.
 */

export type TraceRow = {
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const parseJson = <T>(raw: string | null | undefined, fallback: T): T => {
  if (!raw) {return fallback}
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex')

/** Concatenate the text parts of a message `content` (string or block array). */
export const contentText = (content: unknown): string => {
  if (typeof content === 'string') {return content}
  if (!Array.isArray(content)) {return ''}
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

export const firstUserText = (messages: unknown): string => {
  if (!Array.isArray(messages)) {return ''}
  for (const message of messages) {
    if (isRecord(message) && message.role === 'user') {
      const text = contentText(message.content)
      if (text) {return text}
    }
  }
  return ''
}

export const lastUserText = (messages: unknown): string => {
  if (!Array.isArray(messages)) {return ''}
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (isRecord(message) && message.role === 'user') {
      const text = contentText(message.content)
      if (text) {return text}
    }
  }
  return ''
}

/** Session key: sha256(system + first user text), as specified by the product. */
export const sessionKeyOf = (system: unknown, messages: unknown): string =>
  sha256(`${typeof system === 'string' ? system : ''}${firstUserText(messages)}`)

export const questionOf = (request: unknown): string => {
  if (!isRecord(request)) {return ''}
  return lastUserText(request.messages)
}

export type InsertTraceInput = {
  id: string
  sessionKey: string
  createdAt: number
  status: TraceStatus
  model: string
  thinking: boolean
  profileId: string | null
  profileName: string | null
  retrievalEnabled: boolean
  latencyMs: number
  ttfbMs: number | null
  usage: TokenUsage
  costUsd: number
  pricingBasis: PricingBasis
  request: unknown
  response: TraceResponse
  sources: SourceRef[]
  injectedContext: string | null
  retrievalError: string | null
  error: string | null
}

const ensureSession = (db: Db, input: InsertTraceInput): string => {
  const row = db
    .prepare('SELECT id FROM sessions WHERE session_key = ?')
    .get(input.sessionKey) as { id: string } | undefined
  const fallbackTitle = (input.response.title ?? questionOf(input.request)).trim().slice(0, 80) || null
  if (row) {
    db.prepare(
      'UPDATE sessions SET last_seen_at = ?, turns = turns + 1, title = COALESCE(title, ?) WHERE id = ?'
    ).run(input.createdAt, fallbackTitle, row.id)
    return row.id
  }
  const sessionId = newId('sess')
  db.prepare(
    `INSERT INTO sessions(id, session_key, title, started_at, last_seen_at, turns, meta_json)
     VALUES (?, ?, ?, ?, ?, 1, '{}')`
  ).run(sessionId, input.sessionKey, fallbackTitle, input.createdAt, input.createdAt)
  return sessionId
}

/** Persist one finished trace (+ its sources + session turn) atomically. */
export const insertTrace = (db: Db, input: InsertTraceInput): void => {
  transaction(db, () => {
    const sessionId = ensureSession(db, input)
    db.prepare(
      `INSERT INTO traces(
         id, session_id, session_key, created_at, status, model, thinking, profile_id, profile_name,
         retrieval_enabled, latency_ms, ttfb_ms, usage_json, cost_usd, pricing_basis,
         request_json, response_json, injected_context, retrieval_error, error, feedback, annotation
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
    ).run(
      input.id,
      sessionId,
      input.sessionKey,
      input.createdAt,
      input.status,
      input.model,
      input.thinking ? 1 : 0,
      input.profileId,
      input.profileName,
      input.retrievalEnabled ? 1 : 0,
      input.latencyMs,
      input.ttfbMs,
      JSON.stringify(input.usage),
      input.costUsd,
      input.pricingBasis,
      JSON.stringify(input.request ?? {}),
      JSON.stringify(input.response),
      input.injectedContext,
      input.retrievalError,
      input.error
    )
    if (input.sources.length > 0) {
      const statement = db.prepare(
        `INSERT INTO trace_sources(trace_id, ordinal, chunk_id, document_id, title, heading, page, score, snippet)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      input.sources.forEach((source, ordinal) => {
        statement.run(
          input.id,
          ordinal,
          source.chunkId,
          source.documentId,
          source.title,
          source.heading,
          source.page,
          source.score,
          source.snippet
        )
      })
    }
  })
}

/* ------------------------------ reads ------------------------------ */

const TRACE_COLUMNS = `id, session_id, session_key, created_at, status, model, thinking, profile_id,
  profile_name, retrieval_enabled, latency_ms, ttfb_ms, usage_json, cost_usd, pricing_basis,
  request_json, response_json, injected_context, retrieval_error, error, feedback, annotation`

export const getTraceRow = (db: Db, id: string): TraceRow | null =>
  (db.prepare(`SELECT ${TRACE_COLUMNS} FROM traces WHERE id = ?`).get(id) as TraceRow | undefined) ??
  null

export const traceSources = (db: Db, traceId: string): SourceRef[] => {
  const rows = db
    .prepare(
      `SELECT ordinal, chunk_id, document_id, title, heading, page, score, snippet
       FROM trace_sources WHERE trace_id = ? ORDER BY ordinal ASC`
    )
    .all(traceId) as {
    ordinal: number
    chunk_id: string
    document_id: string
    title: string
    heading: string | null
    page: number | null
    score: number
    snippet: string
  }[]
  return rows.map((row) => ({
    id: `s${row.ordinal + 1}`,
    chunkId: row.chunk_id,
    documentId: row.document_id,
    title: row.title,
    heading: row.heading,
    page: row.page,
    score: row.score,
    snippet: row.snippet,
  }))
}

const responseOf = (row: TraceRow): TraceResponse =>
  parseJson<TraceResponse>(row.response_json, {
    text: '',
    thinking: null,
    stopReason: null,
    title: null,
    toolCalls: 0,
    citations: [],
  })

const usageOf = (row: TraceRow): TokenUsage =>
  parseJson<TokenUsage>(row.usage_json, {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
  })

const statusOf = (value: string): TraceStatus =>
  value === 'error' || value === 'aborted' || value === 'interrupted' ? value : 'ok'

export const rowToTrace = (db: Db, row: TraceRow): Trace => ({
  id: row.id,
  sessionId: row.session_id,
  sessionKey: row.session_key,
  createdAt: row.created_at,
  status: statusOf(row.status),
  model: row.model,
  thinking: row.thinking === 1,
  profileId: row.profile_id,
  profileName: row.profile_name,
  retrievalEnabled: row.retrieval_enabled === 1,
  latencyMs: row.latency_ms,
  ttfbMs: row.ttfb_ms,
  usage: usageOf(row),
  costUsd: row.cost_usd,
  pricingBasis: row.pricing_basis === 'peak' ? 'peak' : 'off-peak',
  request: parseJson<unknown>(row.request_json, null),
  response: responseOf(row),
  sources: traceSources(db, row.id),
  injectedContext: row.injected_context,
  retrievalError: row.retrieval_error,
  error: row.error,
  feedback: row.feedback === 'up' || row.feedback === 'down' ? (row.feedback as Feedback) : null,
  annotation: row.annotation,
})

export type TraceListFilters = {
  limit?: number
  cursor?: string | null
  feedback?: 'up' | 'down' | 'none' | null
  status?: TraceStatus | TraceStatus[] | null
  q?: string | null
  profileId?: string | null
}

export type TraceListPage = {
  items: TraceSummary[]
  nextCursor: string | null
}

export const encodeCursor = (row: { created_at: number; id: string }): string =>
  Buffer.from(JSON.stringify({ t: row.created_at, id: row.id }), 'utf8').toString('base64url')

export const decodeCursor = (cursor: string): { createdAt: number; id: string } | null => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!isRecord(parsed)) {return null}
    const createdAt = parsed.t
    const id = parsed.id
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {return null}
    if (typeof id !== 'string' || !id) {return null}
    return { createdAt, id }
  } catch {
    return null
  }
}

const VALID_STATUSES = new Set(['ok', 'error', 'aborted', 'interrupted'])

export const listTraceRows = (
  db: Db,
  filters: TraceListFilters
): { rows: TraceRow[]; nextCursor: string | null } => {
  const limit = Math.min(Math.max(Math.floor(filters.limit ?? 50), 1), 200)
  const where: string[] = []
  const params: (string | number)[] = []

  if (filters.feedback === 'up' || filters.feedback === 'down') {
    where.push('feedback = ?')
    params.push(filters.feedback)
  } else if (filters.feedback === 'none') {
    where.push('feedback IS NULL')
  }
  const statuses = Array.isArray(filters.status)
    ? filters.status
    : filters.status
      ? [filters.status]
      : []
  const normalized = statuses.filter((status) => VALID_STATUSES.has(status))
  if (normalized.length > 0) {
    where.push(`status IN (${normalized.map(() => '?').join(', ')})`)
    params.push(...normalized)
  }
  if (filters.profileId) {
    where.push('profile_id = ?')
    params.push(filters.profileId)
  }
  if (filters.q && filters.q.trim()) {
    const like = `%${filters.q.trim().toLowerCase()}%`
    where.push('(lower(request_json) LIKE ? OR lower(response_json) LIKE ?)')
    params.push(like, like)
  }
  const cursor = filters.cursor ? decodeCursor(filters.cursor) : null
  if (cursor) {
    where.push('(created_at < ? OR (created_at = ? AND id < ?))')
    params.push(cursor.createdAt, cursor.createdAt, cursor.id)
  }

  const sql =
    `SELECT ${TRACE_COLUMNS} FROM traces` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY created_at DESC, id DESC LIMIT ?'
  params.push(limit + 1)
  const rows = db.prepare(sql).all(...params) as TraceRow[]
  const pageRows = rows.slice(0, limit)
  const nextCursor = rows.length > limit && pageRows.length > 0 ? encodeCursor(pageRows[pageRows.length - 1] as TraceRow) : null
  return { rows: pageRows, nextCursor }
}

const sourceCounts = (db: Db, traceIds: string[]): Map<string, number> => {
  const counts = new Map<string, number>()
  if (traceIds.length === 0) {return counts}
  const rows = db
    .prepare(
      `SELECT trace_id, COUNT(*) AS n FROM trace_sources WHERE trace_id IN (${traceIds
        .map(() => '?')
        .join(', ')}) GROUP BY trace_id`
    )
    .all(...traceIds) as { trace_id: string; n: number }[]
  for (const row of rows) {counts.set(row.trace_id, row.n)}
  return counts
}

export const rowToSummary = (row: TraceRow, sourceCount: number): TraceSummary => ({
  id: row.id,
  sessionKey: row.session_key,
  createdAt: row.created_at,
  status: statusOf(row.status),
  model: row.model,
  profileName: row.profile_name,
  retrievalEnabled: row.retrieval_enabled === 1,
  latencyMs: row.latency_ms,
  costUsd: row.cost_usd,
  feedback: row.feedback === 'up' || row.feedback === 'down' ? (row.feedback as Feedback) : null,
  question: questionOf(parseJson<unknown>(row.request_json, null)),
  answerPreview: responseOf(row).text.slice(0, 200),
  sourceCount,
})

export const listTraceSummaries = (db: Db, filters: TraceListFilters): TraceListPage => {
  const { rows, nextCursor } = listTraceRows(db, filters)
  const counts = sourceCounts(
    db,
    rows.map((row) => row.id)
  )
  return {
    items: rows.map((row) => rowToSummary(row, counts.get(row.id) ?? 0)),
    nextCursor,
  }
}

export type TracePatch = {
  feedback?: Feedback | null
  annotation?: string | null
}

/** Apply a feedback/annotation patch; returns the fresh trace or null when unknown. */
export const patchTrace = (db: Db, id: string, patch: TracePatch): Trace | null => {
  if (!getTraceRow(db, id)) {return null}
  if (patch.feedback !== undefined) {
    db.prepare('UPDATE traces SET feedback = ? WHERE id = ?').run(patch.feedback, id)
  }
  if (patch.annotation !== undefined) {
    db.prepare('UPDATE traces SET annotation = ? WHERE id = ?').run(patch.annotation, id)
  }
  const row = getTraceRow(db, id)
  return row ? rowToTrace(db, row) : null
}
