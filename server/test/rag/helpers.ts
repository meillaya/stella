/**
 * Shared helpers for the RAG test suite. Every test uses an in-memory SQLite
 * database and local fixture files — no network, no live DeepSeek calls.
 */
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Collection } from '../../../shared/types.ts'
import { openDatabase, type Db } from '../../src/db/index.ts'
import { createCollection, ingestFile } from '../../src/rag/index.ts'

export const FIXTURE_NAMES = ['refund-policy.md', 'shipping.md', 'api-reference.md'] as const

export const readFixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

export const makeDb = (): Db => openDatabase(':memory:')

/** Run a test body against a fresh in-memory database that is always closed. */
export const withDb = async <T>(work: (db: Db) => Promise<T> | T): Promise<T> => {
  const db = openDatabase(':memory:')
  try {
    return await work(db)
  } finally {
    db.close()
  }
}

/** Create a collection and ingest the three Markdown fixtures into it. */
export const seedCorpus = async (db: Db, name = 'Support'): Promise<Collection> => {
  const collection = createCollection({ name, description: 'RAG test corpus' }, db)
  for (const fixture of FIXTURE_NAMES) {
    await ingestFile(
      {
        collectionId: collection.id,
        fileName: fixture,
        mimeType: 'text/markdown',
        data: bytesOf(readFixture(fixture)),
      },
      db
    )
  }
  return collection
}

export const collectionChunkTexts = (db: Db, collectionId: string): string[] => {
  const rows = db
    .prepare('SELECT text FROM chunks WHERE collection_id = ? ORDER BY document_id ASC, ordinal ASC')
    .all(collectionId) as unknown as { text: string }[]
  return rows.map((row) => row.text)
}

export const ftsRowCount = (db: Db): number => {
  const row = db.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get() as { n: number }
  return Number(row.n)
}

export const rowCount = (db: Db, table: 'documents' | 'chunks' | 'collections'): number => {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  return Number(row.n)
}

/** Temporary directory inside the workspace so cleanup is sandbox-safe. */
export const makeTempDir = (prefix: string): Promise<string> =>
  mkdtemp(path.join(process.cwd(), 'server/test/rag', `.tmp-${prefix}-`))

export const cleanupDir = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true })
