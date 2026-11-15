/**
 * Stable RAG contract — the only entry point other workstreams (gateway, evals,
 * CLI, collections API) should import. The functions below are thin wrappers
 * over the implementation modules so their signatures stay frozen while the
 * internals evolve.
 *
 * Ownership: `server/src/rag/**`, `server/src/ingest/**`,
 * `server/src/api/collections.ts`, `server/test/rag/**`.
 *
 * Design defaults (v1, lexical only — DeepSeek has no embeddings endpoint):
 * - FTS5 `bm25()` over `chunks_fts` with column weights text=1.0,
 *   code_tokens=0.9, title=3.2, breadcrumb=1.6 (titles/headings boosted).
 * - Deterministic `SourceRef.id` mapping: `s1`, `s2`, ... in returned rank order.
 * - Parent-section expansion folds contiguous same-section chunks into the
 *   primary result's `text` (never increases the result count past `k`).
 * - Token-budget packing via `shared/pricing.estimateTokens`.
 * - RRF (k=60) fusion hook is in place for a future dense adapter; v1 uses the
 *   single lexical list.
 */
import type { Collection, DocumentRecord, RetrievedChunk } from '../../../shared/types.ts'
import type { Db } from '../db/index.ts'
import type {
  CreateCollectionInput,
  IngestFileInput,
  IngestPathsInput,
  IngestPathsResult,
  IngestResult,
  IngestTextInput,
  IngestUrlInput,
  IngestUrlsInput,
  IngestUrlsResult,
  RetrieveOptions,
  RetrieveResult,
  SearchOptions,
  UpdateCollectionInput,
} from './contract.ts'
import * as store from './store.ts'
import * as retrieval from './retrieve.ts'
import * as ingestion from '../ingest/index.ts'

export { RagError, isRagError, RETRIEVAL_DEFAULTS } from './contract.ts'
export type {
  CreateCollectionInput,
  IngestFileInput,
  IngestPathsInput,
  IngestPathsResult,
  IngestResult,
  IngestTextInput,
  IngestUrlInput,
  IngestUrlsInput,
  IngestUrlsResult,
  RagErrorCode,
  RemoteIngestOptions,
  RetrieveOptions,
  RetrieveResult,
  RetrievalRerank,
  SearchOptions,
  UpdateCollectionInput,
} from './contract.ts'
export type { Collection, DocumentRecord, RetrievedChunk, SourceRef } from '../../../shared/types.ts'

/* ------------------------------ collections ------------------------------ */

export const createCollection = (input: CreateCollectionInput, db?: Db): Collection =>
  store.createCollection(input, db)

export const listCollections = (db?: Db): Collection[] => store.listCollections(db)

export const getCollectionById = (id: string, db?: Db): Collection | null =>
  store.getCollectionById(id, db)

export const getCollectionByName = (name: string, db?: Db): Collection | null =>
  store.getCollectionByName(name, db)

/** Resolve a collection reference (id first, then unique name). */
export const resolveCollection = (ref: string, db?: Db): Collection | null =>
  store.resolveCollection(ref, db)

export const updateCollection = (
  id: string,
  patch: UpdateCollectionInput,
  db?: Db
): Collection | null => store.updateCollection(id, patch, db)

export const deleteCollection = (id: string, db?: Db): boolean => store.deleteCollection(id, db)

/* ------------------------------ documents ------------------------------ */

export const listDocuments = (collectionId: string, db?: Db): DocumentRecord[] =>
  store.listDocuments(collectionId, db)

export const getDocument = (id: string, db?: Db): DocumentRecord | null =>
  store.getDocument(id, db)

export const deleteDocument = (id: string, db?: Db): boolean => store.deleteDocument(id, db)

/* ------------------------------ ingestion ------------------------------ */

export const ingestFile = (input: IngestFileInput, db?: Db): Promise<IngestResult> =>
  ingestion.ingestFile(input, db)

export const ingestText = (input: IngestTextInput, db?: Db): Promise<IngestResult> =>
  ingestion.ingestText(input, db)

/** Fetch a URL (DeepSeek Fetch API when a key is configured, local fetch+strip fallback). */
export const ingestUrl = (input: IngestUrlInput, db?: Db): Promise<IngestResult> =>
  ingestion.ingestUrl(input, db)

export const ingestUrls = (input: IngestUrlsInput, db?: Db): Promise<IngestUrlsResult> =>
  ingestion.ingestUrls(input, db)

/** Ingest local files and/or directories (recursive; Markdown/TXT/HTML + OCR formats). */
export const ingestPaths = (input: IngestPathsInput, db?: Db): Promise<IngestPathsResult> =>
  ingestion.ingestPaths(input, db)

/* ------------------------------ retrieval ------------------------------ */

/**
 * Retrieve context for a query.
 *
 * The returned `chunks` are ranked best-first and carry deterministic
 * `SourceRef.id`s (`s1`, `s2`, ...) suitable for prompt citation.
 */
export const retrieve = (options: RetrieveOptions): Promise<RetrieveResult> =>
  retrieval.retrieve(options)

/** Search one collection and return ranked chunks without context-budget packing. */
export const searchCollection = (options: SearchOptions): Promise<RetrievedChunk[]> =>
  retrieval.searchCollection(options)
