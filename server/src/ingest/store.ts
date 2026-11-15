/**
 * Ingest persistence: document dedupe/upsert, chunk write and FTS sync inside a
 * single transaction. A re-ingest with the same content hash (or the same URL
 * with changed content) reuses the document id and replaces its chunks
 * atomically, so no stale chunks or FTS rows survive.
 */
import { newId } from '../../../shared/ids.ts'
import { getDb, transaction, type Db } from '../db/index.ts'
import { chunkDocument, type ChunkOptions, type PageStart } from '../rag/chunk.ts'
import { RagError, type IngestResult } from '../rag/contract.ts'
import {
  findIngestTarget,
  getDocument,
  replaceDocumentChunks,
  touchCollection,
  upsertDocument,
} from '../rag/store.ts'

export type PersistDocumentInput = {
  collectionId: string
  title: string
  sourceType: 'file' | 'url' | 'text'
  uri: string | null
  contentHash: string
  bytes: number
  pageCount: number
  meta: Record<string, unknown>
  text: string
  pageStarts?: PageStart[]
  chunkOptions?: ChunkOptions
}

export const persistDocument = (input: PersistDocumentInput, db?: Db): IngestResult => {
  const database = db ?? getDb()
  const title = input.title.trim() || 'Untitled document'
  if (!input.text || input.text.trim().length === 0) {
    throw new RagError('invalid_input', `Document "${title}" has no extractable text`)
  }

  const target = findIngestTarget(database, input.collectionId, input.contentHash, input.uri)
  const deduped = target !== null && target.contentHash === input.contentHash
  const documentId = target?.id ?? newId('doc')

  const drafts = chunkDocument(
    { id: documentId, title, text: input.text, pageStarts: input.pageStarts },
    input.chunkOptions
  )
  if (drafts.length === 0) {
    throw new RagError('invalid_input', `Document "${title}" has no extractable text`)
  }

  return transaction(database, () => {
    upsertDocument(database, {
      id: documentId,
      collectionId: input.collectionId,
      title,
      sourceType: input.sourceType,
      uri: input.uri,
      contentHash: input.contentHash,
      bytes: input.bytes,
      pageCount: input.pageCount,
      meta: { ...input.meta, chunks: drafts.length },
    })

    const written = replaceDocumentChunks(
      database,
      { id: documentId, collectionId: input.collectionId, title },
      drafts.map((draft) => ({
        id: draft.id,
        ordinal: draft.ordinal,
        text: draft.text,
        breadcrumb: draft.breadcrumb,
        pageFrom: draft.pageFrom,
        pageTo: draft.pageTo,
        charStart: draft.charStart,
        charEnd: draft.charEnd,
        tokenEst: draft.tokenEst,
        codeTokens: draft.codeTokens,
        meta: { ...draft.meta, headingPath: draft.headingPath },
      }))
    )
    touchCollection(database, input.collectionId)

    const document = getDocument(documentId, database)
    if (!document) {throw new RagError('not_found', 'Document disappeared while ingesting')}
    return { document, chunks: written, deduped }
  })
}
