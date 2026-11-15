/**
 * Retrieval pipeline: FTS5 candidates → optional LLM listwise rerank →
 * parent-section expansion → token-budget packing → deterministic SourceRef
 * mapping (`s1`, `s2`, ...).
 */
import type { RetrievedChunk } from '../../../shared/types.ts'
import { getDb, type Db } from '../db/index.ts'
import { log } from '../logger.ts'
import {
  RETRIEVAL_DEFAULTS,
  RagError,
  type RetrieveOptions,
  type RetrieveResult,
  type SearchOptions,
} from './contract.ts'
import { makeSnippet } from './query.ts'
import {
  expandParentSection,
  searchCandidates,
  type Candidate,
  type ExpandedCandidate,
} from './search.ts'
import { llmRerank } from './rerank.ts'
import { resolveCollection } from './store.ts'

const MAX_K = 50
const MAX_CANDIDATES = 200
/** Extra tokens of neighbour text folded into one result by parent expansion. */
const EXPANSION_TOKENS = 700
/** Longer prime chunks are shown truncated inside the prompt context. */
const MAX_CHUNK_TEXT_CHARS = 12_000

const clampInt = (value: number | undefined, fallback: number, min: number, max: number): number => {
  if (value === undefined || !Number.isFinite(value)) {return fallback}
  return Math.max(min, Math.min(max, Math.floor(value)))
}

/** Heading for the UI/trace: drop leading path parts that repeat the document title. */
const headingFor = (title: string, headingPath: string[]): string | null => {
  const remaining = [...headingPath]
  while (remaining.length > 0 && (remaining[0] as string).trim().toLowerCase() === title.trim().toLowerCase()) {
    remaining.shift()
  }
  return remaining.length > 0 ? remaining.join(' > ') : null
}

const toRetrievedChunk = (
  candidate: Candidate,
  expanded: ExpandedCandidate,
  index: number,
  query: string,
  score: number
): RetrievedChunk => {
  const heading = headingFor(candidate.title, candidate.headingPath)
  return {
    id: `s${index + 1}`,
    chunkId: candidate.chunkId,
    documentId: candidate.documentId,
    title: candidate.title,
    heading,
    page: candidate.pageFrom ?? candidate.pageTo,
    score,
    snippet: makeSnippet(candidate.text, query),
    text: expanded.text.length > MAX_CHUNK_TEXT_CHARS
      ? `${expanded.text.slice(0, MAX_CHUNK_TEXT_CHARS)}…`
      : expanded.text,
  }
}

type Packed = {
  chunks: RetrievedChunk[]
  usedTokens: number
}

const packCandidates = (
  db: Db,
  query: string,
  ordered: Candidate[],
  k: number,
  budgetTokens: number,
  parentExpansion: boolean
): Packed => {
  const chunks: RetrievedChunk[] = []
  let usedTokens = 0

  for (const candidate of ordered) {
    if (chunks.length >= k) {break}
    const remainingBudget = budgetTokens > 0 ? Math.max(0, budgetTokens - usedTokens) : EXPANSION_TOKENS
    const expansionBudget = parentExpansion
      ? Math.min(EXPANSION_TOKENS, remainingBudget)
      : 0
    const expanded = expandParentSection(db, candidate, expansionBudget)
    const tokenEst = expanded.tokenEst
    const isFirst = chunks.length === 0

    if (!isFirst && budgetTokens > 0 && usedTokens + tokenEst > budgetTokens) {
      // Try a smaller, unexpanded variant of this candidate before giving up.
      const compact = parentExpansion ? expandParentSection(db, candidate, 0) : expanded
      if (usedTokens + compact.tokenEst > budgetTokens) {continue}
      usedTokens += compact.tokenEst
      chunks.push(toRetrievedChunk(candidate, compact, chunks.length, query, candidate.score))
      continue
    }

    usedTokens += tokenEst
    chunks.push(toRetrievedChunk(candidate, expanded, chunks.length, query, candidate.score))
  }

  return { chunks, usedTokens }
}

/**
 * Retrieve context for a query from one collection.
 *
 * Throws `RagError('invalid_input')` for an empty query and
 * `RagError('not_found')` when the collection (id or name) does not exist.
 */
export const retrieve = async (options: RetrieveOptions): Promise<RetrieveResult> => {
  const startedAt = Date.now()
  const db = options.db ?? getDb()
  const query = typeof options.query === 'string' ? options.query.trim() : ''
  if (!query) {throw new RagError('invalid_input', 'Query is required')}

  const collection = resolveCollection(String(options.collectionId ?? ''), db)
  if (!collection) {
    throw new RagError('not_found', `Collection "${String(options.collectionId ?? '')}" was not found`)
  }

  const k = clampInt(options.k, RETRIEVAL_DEFAULTS.k, 1, MAX_K)
  const candidateLimit = clampInt(
    options.candidates,
    Math.max(RETRIEVAL_DEFAULTS.candidates, k * 4),
    k,
    MAX_CANDIDATES
  )
  const budgetTokens =
    options.contextBudgetTokens === undefined
      ? RETRIEVAL_DEFAULTS.contextBudgetTokens
      : Math.floor(options.contextBudgetTokens)
  const parentExpansion = options.parentExpansion ?? RETRIEVAL_DEFAULTS.parentExpansion
  const rerankMode = options.rerank ?? RETRIEVAL_DEFAULTS.rerank

  const candidates = searchCandidates(db, {
    collectionId: collection.id,
    query,
    limit: candidateLimit,
  })

  if (candidates.length === 0) {
    return { chunks: [], collectionId: collection.id, latencyMs: Date.now() - startedAt }
  }

  let ordered = candidates
  if (rerankMode === 'llm' && candidates.length > 1) {
    const order = await llmRerank({
      query,
      candidates: candidates.map((candidate) => ({
        id: candidate.chunkId,
        text: `${candidate.title}\n${candidate.headingPath.join(' > ')}\n${candidate.text}`,
      })),
      model: options.rerankModel,
    })
    if (order) {
      const byId = new Map(candidates.map((candidate) => [candidate.chunkId, candidate]))
      ordered = order
        .map((chunkId) => byId.get(chunkId))
        .filter((candidate): candidate is Candidate => Boolean(candidate))
    }
  }

  const packed = packCandidates(db, query, ordered, k, budgetTokens, parentExpansion)
  const latencyMs = Date.now() - startedAt
  log.debug('retrieved context', {
    collectionId: collection.id,
    query,
    candidates: candidates.length,
    chunks: packed.chunks.length,
    tokens: packed.usedTokens,
    latencyMs,
  })
  return { chunks: packed.chunks, collectionId: collection.id, latencyMs }
}

/** Search one collection and return ranked chunks without context-budget packing. */
export const searchCollection = async (options: SearchOptions): Promise<RetrievedChunk[]> => {
  const result = await retrieve({
    collectionId: options.collectionId,
    query: options.query,
    k: options.k ?? 8,
    rerank: options.rerank ?? RETRIEVAL_DEFAULTS.rerank,
    contextBudgetTokens: 0,
    parentExpansion: false,
    db: options.db,
  })
  return result.chunks
}
