/**
 * Lexical candidate search over FTS5 with parent-section expansion and RRF
 * fusion hooks.
 *
 * v1 is lexical-only: DeepSeek exposes no embeddings endpoint, and we do not
 * install local embedding models. A future dense adapter can be plugged into
 * `fuseRrf` without changing the `retrieve()` contract.
 */
import type { Db } from '../db/index.ts'
import { parseJson } from '../db/index.ts'
import { estimateTokens } from '../../../shared/pricing.ts'
import { log } from '../logger.ts'
import {
  CHUNK_MATCH_COLUMNS,
  CHUNK_MATCH_JOIN,
  mapChunkMatchRow,
  neighbourChunks,
  type ChunkMatchRow,
} from './store.ts'
import { countOccurrences, escapeFtsQuery, escapeLike } from './query.ts'
import { collapseWhitespace, tokenizeWords } from './text.ts'

/** FTS5 column weights, in declared column order (chunk_id is UNINDEXED and contributes nothing). */
export const BM25_WEIGHTS = {
  text: 1.0,
  codeTokens: 0.9,
  title: 3.2,
  breadcrumb: 1.6,
} as const

const BM25_WEIGHT_ARGS = `0.0, ${BM25_WEIGHTS.text}, ${BM25_WEIGHTS.codeTokens}, ${BM25_WEIGHTS.title}, ${BM25_WEIGHTS.breadcrumb}`

const BM25_SQL = `
  SELECT ${CHUNK_MATCH_COLUMNS}, -bm25(chunks_fts, ${BM25_WEIGHT_ARGS}) AS score
  FROM chunks_fts
  JOIN chunks c ON c.id = chunks_fts.chunk_id
  JOIN documents d ON d.id = c.document_id
  WHERE chunks_fts MATCH ? AND c.collection_id = ?
  ORDER BY score DESC
  LIMIT ?
`

export type Candidate = {
  chunkId: string
  documentId: string
  ordinal: number
  text: string
  breadcrumb: string
  headingPath: string[]
  pageFrom: number | null
  pageTo: number | null
  charStart: number
  charEnd: number
  tokenEst: number
  title: string
  /** Positive BM25-derived score; higher is better. */
  score: number
}

type Row = Record<string, unknown>

const headingPathFromMeta = (metaJson: string): string[] => {
  const meta = parseJson<{ headingPath?: unknown }>(metaJson, {})
  return Array.isArray(meta.headingPath)
    ? meta.headingPath.filter((value): value is string => typeof value === 'string')
    : []
}

export const candidateFromRow = (row: ChunkMatchRow, score: number): Candidate => ({
  chunkId: row.chunkId,
  documentId: row.documentId,
  ordinal: row.ordinal,
  text: row.text,
  breadcrumb: row.breadcrumb,
  headingPath: headingPathFromMeta(row.metaJson),
  pageFrom: row.pageFrom,
  pageTo: row.pageTo,
  charStart: row.charStart,
  charEnd: row.charEnd,
  tokenEst: row.tokenEst,
  title: row.title,
  score,
})

const isFtsSyntaxError = (error: unknown): boolean =>
  error instanceof Error && /fts5|syntax error|malformed match|unterminated string|no such column/i.test(error.message)

const fallbackScore = (row: ChunkMatchRow, terms: string[]): number => {
  let score = 0
  for (const term of terms) {
    score += countOccurrences(row.text, term)
    score += countOccurrences(row.title, term) * 3
    score += countOccurrences(row.breadcrumb, term) * 2
  }
  return score / 10
}

/**
 * Last-resort retrieval when the query has no indexable tokens or FTS5 rejects
 * the expression: bounded `LIKE` scan with an in-process relevance score.
 */
export const likeFallback = (db: Db, collectionId: string, query: string, limit: number): Candidate[] => {
  const terms = [...new Set(tokenizeWords(query))].slice(0, 8)
  const raw = collapseWhitespace(query).slice(0, 200)
  const conditions: string[] = []
  const params: (string | number | null)[] = [collectionId]

  if (terms.length > 0) {
    for (const term of terms) {
      conditions.push(
        "(c.text LIKE ? ESCAPE '\\' OR d.title LIKE ? ESCAPE '\\' OR c.breadcrumb LIKE ? ESCAPE '\\')"
      )
      const pattern = `%${escapeLike(term)}%`
      params.push(pattern, pattern, pattern)
    }
  } else if (raw.length > 0) {
    conditions.push("(c.text LIKE ? ESCAPE '\\' OR d.title LIKE ? ESCAPE '\\')")
    const pattern = `%${escapeLike(raw)}%`
    params.push(pattern, pattern)
  } else {
    return []
  }

  const rows = db
    .prepare(`
      SELECT ${CHUNK_MATCH_COLUMNS}
      ${CHUNK_MATCH_JOIN}
      WHERE c.collection_id = ? AND ${conditions.join(' AND ')}
      LIMIT 400
    `)
    .all(...params) as unknown as Row[]

  return rows
    .map((row) => {
      const mapped = mapChunkMatchRow(row)
      return candidateFromRow(mapped, fallbackScore(mapped, terms))
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
}

/**
 * Return BM25-ranked candidates for one collection. Queries are escaped before
 * reaching FTS5; on a parser error we degrade to the LIKE scan.
 */
export const searchCandidates = (
  db: Db,
  input: { collectionId: string; query: string; limit: number }
): Candidate[] => {
  const escaped = escapeFtsQuery(input.query)
  if (!escaped) {return likeFallback(db, input.collectionId, input.query, input.limit)}

  try {
    const rows = db
      .prepare(BM25_SQL)
      .all(escaped, input.collectionId, Math.max(1, Math.floor(input.limit))) as unknown as Row[]
    return rows.map((row) => {
      const mapped = mapChunkMatchRow(row)
      return candidateFromRow(mapped, typeof row.score === 'number' ? row.score : 0)
    })
  } catch (error) {
    if (isFtsSyntaxError(error)) {
      log.debug('FTS5 query failed; using LIKE fallback', {
        query: input.query,
        error: error instanceof Error ? error.message : String(error),
      })
      return likeFallback(db, input.collectionId, input.query, input.limit)
    }
    throw error
  }
}

/* ------------------------- parent-section expansion ------------------------- */

export type ExpandedCandidate = {
  text: string
  tokenEst: number
  charStart: number
  charEnd: number
  pageFrom: number | null
  pageTo: number | null
  /** Number of neighbouring chunks merged into the text. */
  mergedChunks: number
}

const estimateTextTokens = (text: string): number => estimateTokens(text)

/**
 * Fold contiguous chunks from the same section into the candidate text, up to
 * `maxTokens`. Neighbours must share the exact same breadcrumb, so unrelated
 * subsections are never glued together.
 */
export const expandParentSection = (
  db: Db,
  candidate: Candidate,
  maxTokens: number
): ExpandedCandidate => {
  const base: ExpandedCandidate = {
    text: candidate.text,
    tokenEst: candidate.tokenEst || estimateTextTokens(candidate.text),
    charStart: candidate.charStart,
    charEnd: candidate.charEnd,
    pageFrom: candidate.pageFrom,
    pageTo: candidate.pageTo,
    mergedChunks: 0,
  }
  if (maxTokens <= 0) {return base}

  const before: ChunkMatchRow[] = []
  const after: ChunkMatchRow[] = []
  let remaining = maxTokens

  let ordinal = candidate.ordinal - 1
  while (ordinal >= 0 && remaining > 0) {
    const [row] = neighbourChunks(db, candidate.documentId, ordinal, ordinal)
    if (!row || row.breadcrumb !== candidate.breadcrumb || row.tokenEst > remaining) {break}
    before.unshift(row)
    remaining -= row.tokenEst
    ordinal -= 1
  }

  ordinal = candidate.ordinal + 1
  while (remaining > 0) {
    const [row] = neighbourChunks(db, candidate.documentId, ordinal, ordinal)
    if (!row || row.breadcrumb !== candidate.breadcrumb || row.tokenEst > remaining) {break}
    after.push(row)
    remaining -= row.tokenEst
    ordinal += 1
  }

  if (before.length === 0 && after.length === 0) {return base}

  const pieces = [
    ...before.map((row) => row.text),
    candidate.text,
    ...after.map((row) => row.text),
  ]
  const text = pieces.join('\n\n')
  const first = before[0]
  const last = after[after.length - 1]
  return {
    text,
    tokenEst: estimateTextTokens(text),
    charStart: first ? first.charStart : candidate.charStart,
    charEnd: last ? last.charEnd : candidate.charEnd,
    pageFrom: first ? first.pageFrom : candidate.pageFrom,
    pageTo: last ? last.pageTo : candidate.pageTo,
    mergedChunks: before.length + after.length,
  }
}

/* ------------------------------ fusion hooks ------------------------------ */

export type RankedHit = { chunkId: string; score: number }

/** Reciprocal rank fusion (default k=60) for future lexical + dense hybrids. */
export const fuseRrf = (lists: { chunkId: string }[][], rankConstant = 60): RankedHit[] => {
  const scores = new Map<string, number>()
  for (const list of lists) {
    list.forEach((hit, index) => {
      scores.set(hit.chunkId, (scores.get(hit.chunkId) ?? 0) + 1 / (rankConstant + index + 1))
    })
  }
  return [...scores.entries()]
    .map(([chunkId, score]) => ({ chunkId, score }))
    .sort((left, right) => right.score - left.score)
}

/**
 * Optional dense-retrieval adapter. Not wired in v1 — DeepSeek has no
 * embeddings endpoint and we deliberately ship no local model dependency.
 */
export type DenseAdapter = {
  readonly name: string
  search: (input: {
    collectionId: string
    query: string
    limit: number
    db: Db
  }) => Promise<{ chunkId: string; score: number }[]>
}
