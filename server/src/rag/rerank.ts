/**
 * Optional LLM listwise reranking.
 *
 * The provider layer (`server/src/providers/responses.ts`) is owned by the
 * gateway workstream and is loaded dynamically so missing/broken providers can
 * never block retrieval: any failure degrades to the lexical order. Results are
 * cached in memory (query + candidate ids) with a TTL and a hard size cap.
 */
import type { ModelId } from '../../../shared/types.ts'
import { log } from '../logger.ts'
import { sha256Hex } from './hash.ts'

export type RerankCandidate = {
  id: string
  text: string
}

type ListwiseFn = (input: {
  query: string
  documents: { id: string; text: string }[]
  model?: ModelId
  signal?: AbortSignal
}) => Promise<string[]>

const CACHE_LIMIT = 200
const CACHE_TTL_MS = 10 * 60 * 1000
const RERANK_TIMEOUT_MS = 12_000
const MAX_DOCUMENTS = 40
const MAX_DOC_CHARS = 1200

type CacheEntry = { expiresAt: number; order: string[] }

const cache = new Map<string, CacheEntry>()

const cacheKey = (query: string, candidates: RerankCandidate[]): string =>
  sha256Hex(`${query}\u0000${candidates.map((candidate) => candidate.id).join('\u0000')}`)

const trimCache = (): void => {
  const now = Date.now()
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {cache.delete(key)}
  }
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) {break}
    cache.delete(oldest)
  }
}

const loadListwiseFn = async (): Promise<ListwiseFn | null> => {
  try {
    // Variable specifier keeps `tsc` decoupled from the provider workstream.
    const specifier = '../providers/responses.ts'
    const module = (await import(specifier)) as Record<string, unknown>
    const candidate = module.rerankListwise
    return typeof candidate === 'function' ? (candidate as ListwiseFn) : null
  } catch (error) {
    log.warn(
      'LLM rerank provider unavailable; using lexical order',
      error instanceof Error ? error.message : String(error)
    )
    return null
  }
}

export type LlmRerankInput = {
  query: string
  candidates: RerankCandidate[]
  model?: ModelId
}

/**
 * Return every candidate id exactly once, most relevant first, or `null` when
 * reranking is unavailable (caller keeps the lexical order).
 */
export const llmRerank = async (input: LlmRerankInput): Promise<string[] | null> => {
  const documents = input.candidates.slice(0, MAX_DOCUMENTS).map((candidate) => ({
    id: candidate.id,
    text: candidate.text.slice(0, MAX_DOC_CHARS),
  }))
  if (documents.length < 2) {return null}

  const key = cacheKey(input.query, documents)
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) {return [...cached.order]}

  const rerank = await loadListwiseFn()
  if (!rerank) {return null}

  try {
    const order = await rerank({
      query: input.query,
      documents,
      model: input.model,
      signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
    })
    if (!Array.isArray(order)) {return null}
    const ids = documents.map((document) => document.id)
    const seen = new Set<string>()
    const ranked: string[] = []
    for (const id of order) {
      if (typeof id !== 'string' || seen.has(id) || !ids.includes(id)) {continue}
      seen.add(id)
      ranked.push(id)
    }
    for (const id of ids) {
      if (!seen.has(id)) {ranked.push(id)}
    }
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, order: ranked })
    trimCache()
    return [...ranked]
  } catch (error) {
    log.warn(
      'LLM rerank failed; using lexical order',
      error instanceof Error ? error.message : String(error)
    )
    return null
  }
}

/** Test helper: clear the in-memory rerank cache. */
export const clearRerankCache = (): void => {
  cache.clear()
}
