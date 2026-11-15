/**
 * Public RAG contract types shared by the retrieval, ingestion, API and eval
 * layers. This module is dependency-free at runtime (type-only imports), so it
 * can be imported from anywhere without pulling in `node:sqlite` or network
 * code.
 *
 * The stable entry point is `server/src/rag/index.ts`; import from there unless
 * you are inside the RAG/ingestion workstream.
 */
import type { Collection, DocumentRecord, ModelId, RetrievedChunk } from '../../../shared/types.ts'
import type { Db } from '../db/index.ts'

/** Machine-readable error codes returned by RAG helpers and the HTTP API. */
export type RagErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'unsupported_type'
  | 'no_api_key'
  | 'too_large'
  | 'upstream_error'

/** Typed error used by every RAG/ingestion entry point. */
export class RagError extends Error {
  readonly code: RagErrorCode

  constructor(code: RagErrorCode, message: string) {
    super(message)
    this.name = 'RagError'
    this.code = code
  }
}

export const isRagError = (value: unknown): value is RagError => value instanceof RagError

/** How the optional LLM listwise reranker is invoked. */
export type RetrievalRerank = 'off' | 'llm'

/** Defaults applied by `retrieve()` when the caller omits an option. */
export const RETRIEVAL_DEFAULTS = {
  k: 6,
  /** Candidate chunks pulled from FTS5 before reranking/packing. */
  candidates: 40,
  /** Tokens of retrieved context the caller is willing to pay for. */
  contextBudgetTokens: 2400,
  parentExpansion: true,
  rerank: 'off',
} as const

export type RetrieveOptions = {
  /**
   * Collection id or unique name. Names are resolved through
   * `getCollectionByName`, which lets profiles store the human collection name.
   */
  collectionId: string
  query: string
  /** Maximum number of returned chunks. Default 6. */
  k?: number
  /** FTS5 candidate pool size before packing/reranking. Default `max(40, k * 4)`. */
  candidates?: number
  /** `'llm'` enables the optional listwise reranker; silent fallback on failure. Default `'off'`. */
  rerank?: RetrievalRerank
  /** Optional model for the LLM reranker (e.g. the active profile's model). */
  rerankModel?: ModelId
  /** Token budget for the packed context. `0` (or negative) means unlimited. Default 2400. */
  contextBudgetTokens?: number
  /** Merge contiguous same-section neighbour chunks into a result's text. Default true. */
  parentExpansion?: boolean
  /** Optional database override (tests, CLI sandboxes). Defaults to the process DB. */
  db?: Db
}

export type RetrieveResult = {
  /** `RetrievedChunk`s in rank order; `id` is a deterministic `s1`, `s2`, ... mapping. */
  chunks: RetrievedChunk[]
  /** Resolved collection id (a name passed in `collectionId` is resolved to its id). */
  collectionId: string
  latencyMs: number
}

export type SearchOptions = {
  /** Collection id or unique name. */
  collectionId: string
  query: string
  /** Maximum number of chunks. Default 8. */
  k?: number
  rerank?: RetrievalRerank
  db?: Db
}

export type CreateCollectionInput = {
  name: string
  description?: string
}

export type UpdateCollectionInput = {
  name?: string
  description?: string
}

/** Result of ingesting one document (file, text or URL). */
export type IngestResult = {
  document: DocumentRecord
  /** Number of chunks written for the document. */
  chunks: number
  /** True when an existing document with the same content hash was updated in place. */
  deduped: boolean
}

/**
 * Advanced/test hooks accepted by single-document ingestion. Normal callers
 * (API/CLI) omit them: the server key, base URL and global fetch are used.
 */
export type RemoteIngestOptions = {
  apiKey?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}

export type IngestFileInput = RemoteIngestOptions & {
  /** Collection id or unique name. */
  collectionId: string
  fileName: string
  mimeType?: string
  data: Uint8Array
  /** Overrides the title detected from frontmatter/<title>/file name. */
  title?: string
}

export type IngestTextInput = RemoteIngestOptions & {
  collectionId: string
  title: string
  text: string
  /** Original source URI when the text came from a remote document. */
  uri?: string | null
  /** Defaults to `'text'`. */
  sourceType?: 'file' | 'url' | 'text'
}

export type IngestUrlInput = RemoteIngestOptions & {
  collectionId: string
  url: string
  title?: string
}

export type IngestPathsInput = {
  collectionId: string
  /** Files and/or directories. Directories are walked recursively for supported files. */
  paths: string[]
}

export type IngestUrlsInput = {
  collectionId: string
  urls: string[]
  apiKey?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}

export type IngestUrlError = {
  url: string
  message: string
  code?: RagErrorCode
}

export type IngestPathError = {
  path: string
  message: string
  code?: RagErrorCode
}

export type IngestUrlsResult = {
  documents: IngestResult[]
  errors: IngestUrlError[]
}

export type IngestPathsResult = {
  documents: IngestResult[]
  errors: IngestPathError[]
}

/** Internal DB-facing shape; re-exported for the API layer's convenience. */
export type { Collection, DocumentRecord, RetrievedChunk }
