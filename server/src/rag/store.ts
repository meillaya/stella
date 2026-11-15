/**
 * SQLite persistence for collections, documents and chunks (including the
 * companion FTS5 table `chunks_fts`).
 *
 * FTS rows use the `chunks` implicit rowid so chunk lookup/removal stays cheap;
 * `chunk_id` is still written to the FTS table for traceability. All functions
 * accept an optional `Db` override so tests and CLI sandboxes can use their own
 * database (`openDatabase(':memory:')`).
 */
import type { Collection, DocumentRecord } from '../../../shared/types.ts'
import { newId, now } from '../../../shared/ids.ts'
import { getDb, parseJson, transaction, type Db } from '../db/index.ts'
import { RagError, type CreateCollectionInput, type UpdateCollectionInput } from './contract.ts'

export const resolveDb = (db?: Db): Db => db ?? getDb()

type Row = Record<string, unknown>

type CollectionRow = {
  id: string
  name: string
  description: string
  created_at: number
  updated_at: number
  document_count: number
  chunk_count: number
}

type DocumentRow = {
  id: string
  collection_id: string
  title: string
  source_type: string
  uri: string | null
  bytes: number
  page_count: number
  content_hash: string
  created_at: number
  meta_json: string
  chunk_count: number
}

const COLLECTION_SELECT = `
  SELECT c.id, c.name, c.description, c.created_at, c.updated_at,
    (SELECT COUNT(*) FROM documents d WHERE d.collection_id = c.id) AS document_count,
    (SELECT COUNT(*) FROM chunks ch WHERE ch.collection_id = c.id) AS chunk_count
  FROM collections c
`

const DOCUMENT_SELECT = `
  SELECT d.id, d.collection_id, d.title, d.source_type, d.uri, d.bytes, d.page_count,
    d.content_hash, d.created_at, d.meta_json,
    (SELECT COUNT(*) FROM chunks ch WHERE ch.document_id = d.id) AS chunk_count
  FROM documents d
`

const toNumber = (value: unknown): number => {
  if (typeof value === 'number') {return value}
  if (typeof value === 'bigint') {return Number(value)}
  return Number(value ?? 0)
}

const mapCollection = (row: CollectionRow): Collection => ({
  id: row.id,
  name: row.name,
  description: row.description,
  documentCount: toNumber(row.document_count),
  chunkCount: toNumber(row.chunk_count),
  createdAt: toNumber(row.created_at),
  updatedAt: toNumber(row.updated_at),
})

const mapDocument = (row: DocumentRow): DocumentRecord => ({
  id: row.id,
  collectionId: row.collection_id,
  title: row.title,
  sourceType:
    row.source_type === 'url' ? 'url' : row.source_type === 'file' ? 'file' : 'text',
  uri: row.uri,
  bytes: toNumber(row.bytes),
  pageCount: toNumber(row.page_count),
  chunkCount: toNumber(row.chunk_count),
  contentHash: row.content_hash,
  createdAt: toNumber(row.created_at),
  meta: parseJson<Record<string, unknown>>(row.meta_json, {}),
})

const collectionRow = (row: Row | undefined): CollectionRow | null =>
  row ? ({ ...row } as unknown as CollectionRow) : null

const documentRow = (row: Row | undefined): DocumentRow | null =>
  row ? ({ ...row } as unknown as DocumentRow) : null

const cleanName = (value: unknown): string => {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name) {throw new RagError('invalid_input', 'Collection name is required')}
  if (name.length > 120) {throw new RagError('invalid_input', 'Collection name must be at most 120 characters')}
  return name
}

const cleanDescription = (value: unknown): string => {
  if (value === undefined || value === null) {return ''}
  const description = typeof value === 'string' ? value.trim() : ''
  if (description.length > 2000) {
    throw new RagError('invalid_input', 'Collection description must be at most 2000 characters')
  }
  return description
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed/i.test(error.message)

/* ------------------------------ collections ------------------------------ */

export const createCollection = (input: CreateCollectionInput, db?: Db): Collection => {
  const database = resolveDb(db)
  const name = cleanName(input?.name)
  const description = cleanDescription(input?.description)
  const id = newId('col')
  const timestamp = now()
  try {
    database
      .prepare('INSERT INTO collections(id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, description, timestamp, timestamp)
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new RagError('conflict', `A collection named "${name}" already exists`)
    }
    throw error
  }
  const created = getCollectionById(id, database)
  if (!created) {throw new RagError('not_found', 'Collection disappeared after creation')}
  return created
}

export const listCollections = (db?: Db): Collection[] => {
  const rows = resolveDb(db)
    .prepare(`${COLLECTION_SELECT} ORDER BY c.updated_at DESC, c.name ASC`)
    .all() as unknown as CollectionRow[]
  return rows.map(mapCollection)
}

export const getCollectionById = (id: string, db?: Db): Collection | null => {
  if (!id) {return null}
  const row = resolveDb(db).prepare(`${COLLECTION_SELECT} WHERE c.id = ?`).get(id)
  const mapped = collectionRow(row)
  return mapped ? mapCollection(mapped) : null
}

export const getCollectionByName = (name: string, db?: Db): Collection | null => {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed) {return null}
  const database = resolveDb(db)
  const exact = collectionRow(database.prepare(`${COLLECTION_SELECT} WHERE c.name = ?`).get(trimmed))
  if (exact) {return mapCollection(exact)}
  const loose = database
    .prepare(`${COLLECTION_SELECT} WHERE lower(c.name) = lower(?)`)
    .all(trimmed) as unknown as CollectionRow[]
  return loose.length === 1 && loose[0] ? mapCollection(loose[0]) : null
}

/** Resolve a collection reference: id first, then unique name. */
export const resolveCollection = (ref: string, db?: Db): Collection | null => {
  const trimmed = typeof ref === 'string' ? ref.trim() : ''
  if (!trimmed) {return null}
  return getCollectionById(trimmed, db) ?? getCollectionByName(trimmed, db)
}

export const updateCollection = (
  id: string,
  patch: UpdateCollectionInput,
  db?: Db
): Collection | null => {
  const database = resolveDb(db)
  const existing = getCollectionById(id, database)
  if (!existing) {return null}
  const nextName = patch.name === undefined ? existing.name : cleanName(patch.name)
  const nextDescription =
    patch.description === undefined ? existing.description : cleanDescription(patch.description)
  try {
    database
      .prepare('UPDATE collections SET name = ?, description = ?, updated_at = ? WHERE id = ?')
      .run(nextName, nextDescription, now(), id)
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new RagError('conflict', `A collection named "${nextName}" already exists`)
    }
    throw error
  }
  return getCollectionById(id, database)
}

export const deleteCollection = (id: string, db?: Db): boolean => {
  const database = resolveDb(db)
  return transaction(database, () => {
    deleteFtsForCollection(database, id)
    const result = database.prepare('DELETE FROM collections WHERE id = ?').run(id)
    return toNumber(result.changes) > 0
  })
}

export const touchCollection = (db: Db, collectionId: string, timestamp = now()): void => {
  db.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').run(timestamp, collectionId)
}

/* ------------------------------- documents ------------------------------- */

export const listDocuments = (collectionId: string, db?: Db): DocumentRecord[] => {
  const rows = resolveDb(db)
    .prepare(`${DOCUMENT_SELECT} WHERE d.collection_id = ? ORDER BY d.created_at ASC, d.title ASC`)
    .all(collectionId) as unknown as DocumentRow[]
  return rows.map(mapDocument)
}

export const getDocument = (id: string, db?: Db): DocumentRecord | null => {
  if (!id) {return null}
  const row = documentRow(resolveDb(db).prepare(`${DOCUMENT_SELECT} WHERE d.id = ?`).get(id))
  return row ? mapDocument(row) : null
}

export const deleteDocument = (id: string, db?: Db): boolean => {
  const database = resolveDb(db)
  const document = getDocument(id, database)
  if (!document) {return false}
  return transaction(database, () => {
    deleteFtsForDocument(database, id)
    const result = database.prepare('DELETE FROM documents WHERE id = ?').run(id)
    touchCollection(database, document.collectionId)
    return toNumber(result.changes) > 0
  })
}

/* -------------------------------- chunks -------------------------------- */

export type StoredChunkInput = {
  id: string
  ordinal: number
  text: string
  breadcrumb: string
  pageFrom: number | null
  pageTo: number | null
  charStart: number
  charEnd: number
  tokenEst: number
  codeTokens: string
  meta: Record<string, unknown>
}

export const replaceDocumentChunks = (
  db: Db,
  document: { id: string; collectionId: string; title: string },
  chunks: StoredChunkInput[]
): number => {
  deleteFtsForDocument(db, document.id)
  db.prepare('DELETE FROM chunks WHERE document_id = ?').run(document.id)

  const insertChunk = db.prepare(`
    INSERT INTO chunks(id, document_id, collection_id, ordinal, text, breadcrumb, page_from, page_to,
      char_start, char_end, token_est, code_tokens, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const lastRowId = db.prepare('SELECT last_insert_rowid() AS rowid')
  const insertFts = db.prepare(`
    INSERT INTO chunks_fts(rowid, chunk_id, text, code_tokens, title, breadcrumb)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  for (const chunk of chunks) {
    insertChunk.run(
      chunk.id,
      document.id,
      document.collectionId,
      chunk.ordinal,
      chunk.text,
      chunk.breadcrumb,
      chunk.pageFrom,
      chunk.pageTo,
      chunk.charStart,
      chunk.charEnd,
      chunk.tokenEst,
      chunk.codeTokens,
      JSON.stringify(chunk.meta)
    )
    const row = lastRowId.get() as Row | undefined
    insertFts.run(
      toNumber(row?.rowid),
      chunk.id,
      chunk.text,
      chunk.codeTokens,
      document.title,
      chunk.breadcrumb
    )
  }

  return chunks.length
}

export const deleteFtsForDocument = (db: Db, documentId: string): void => {
  db.prepare('DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)').run(
    documentId
  )
}

export const deleteFtsForCollection = (db: Db, collectionId: string): void => {
  db.prepare(
    'DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE collection_id = ?)'
  ).run(collectionId)
}

/** Find an existing document to update on re-ingest: same content first, then same URI. */
export const findIngestTarget = (
  db: Db,
  collectionId: string,
  contentHash: string,
  uri: string | null
): { id: string; contentHash: string } | null => {
  const byHash = db
    .prepare('SELECT id, content_hash FROM documents WHERE collection_id = ? AND content_hash = ? LIMIT 1')
    .get(collectionId, contentHash) as Row | undefined
  if (byHash) {return { id: String(byHash.id), contentHash: String(byHash.content_hash) }}
  if (uri) {
    const byUri = db
      .prepare('SELECT id, content_hash FROM documents WHERE collection_id = ? AND uri = ? LIMIT 1')
      .get(collectionId, uri) as Row | undefined
    if (byUri) {return { id: String(byUri.id), contentHash: String(byUri.content_hash) }}
  }
  return null
}

export type UpsertDocumentInput = {
  id: string
  collectionId: string
  title: string
  sourceType: 'file' | 'url' | 'text'
  uri: string | null
  contentHash: string
  bytes: number
  pageCount: number
  meta: Record<string, unknown>
}

export const upsertDocument = (db: Db, input: UpsertDocumentInput): void => {
  const existing = db.prepare('SELECT id FROM documents WHERE id = ?').get(input.id) as Row | undefined
  if (existing) {
    db.prepare(`
      UPDATE documents SET title = ?, source_type = ?, uri = ?, content_hash = ?, bytes = ?,
        page_count = ?, meta_json = ?
      WHERE id = ?
    `).run(
      input.title,
      input.sourceType,
      input.uri,
      input.contentHash,
      input.bytes,
      input.pageCount,
      JSON.stringify(input.meta),
      input.id
    )
    return
  }
  db.prepare(`
    INSERT INTO documents(id, collection_id, source_type, uri, title, content_hash, bytes, page_count, meta_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.collectionId,
    input.sourceType,
    input.uri,
    input.title,
    input.contentHash,
    input.bytes,
    input.pageCount,
    JSON.stringify(input.meta),
    now()
  )
}

/* ------------------------------- retrieval ------------------------------- */

export type ChunkMatchRow = {
  chunkId: string
  documentId: string
  collectionId: string
  ordinal: number
  text: string
  breadcrumb: string
  pageFrom: number | null
  pageTo: number | null
  charStart: number
  charEnd: number
  tokenEst: number
  title: string
  metaJson: string
}

export const CHUNK_MATCH_JOIN = `
  FROM chunks c
  JOIN documents d ON d.id = c.document_id
`

/** Select columns used by the retrieval layer for an arbitrary `chunks c` alias. */
export const CHUNK_MATCH_COLUMNS = `
  c.id AS chunk_id,
  c.document_id AS document_id,
  c.collection_id AS collection_id,
  c.ordinal AS ordinal,
  c.text AS text,
  c.breadcrumb AS breadcrumb,
  c.page_from AS page_from,
  c.page_to AS page_to,
  c.char_start AS char_start,
  c.char_end AS char_end,
  c.token_est AS token_est,
  c.meta_json AS meta_json,
  d.title AS title
`

export const mapChunkMatchRow = (row: Row): ChunkMatchRow => ({
  chunkId: String(row.chunk_id),
  documentId: String(row.document_id),
  collectionId: String(row.collection_id),
  ordinal: toNumber(row.ordinal),
  text: String(row.text),
  breadcrumb: String(row.breadcrumb ?? ''),
  pageFrom: row.page_from == null ? null : toNumber(row.page_from),
  pageTo: row.page_to == null ? null : toNumber(row.page_to),
  charStart: toNumber(row.char_start),
  charEnd: toNumber(row.char_end),
  tokenEst: toNumber(row.token_est),
  title: String(row.title ?? ''),
  metaJson: String(row.meta_json ?? '{}'),
})

/** Fetch the chunks immediately before/after a chunk in the same document. */
export const neighbourChunks = (
  db: Db,
  documentId: string,
  ordinalFrom: number,
  ordinalTo: number
): ChunkMatchRow[] => {
  const rows = db
    .prepare(`
      SELECT ${CHUNK_MATCH_COLUMNS}
      ${CHUNK_MATCH_JOIN}
      WHERE c.document_id = ? AND c.ordinal BETWEEN ? AND ?
      ORDER BY c.ordinal ASC
    `)
    .all(documentId, ordinalFrom, ordinalTo) as unknown as Row[]
  return rows.map(mapChunkMatchRow)
}
