import { mkdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { config } from '../config.ts'

export type Db = DatabaseSync

let instance: Db | null = null

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')

export const openDatabase = (file = config.dbPath): Db => {
  mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(schema)
  migrate(db)
  db.prepare(
    "INSERT INTO meta(key, value) VALUES ('schema_version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run()
  return db
}

/** Additive migrations for databases created before a column existed. */
const ensureColumn = (db: Db, table: string, column: string, definition: string): void => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

const migrate = (db: Db): void => {
  ensureColumn(db, 'traces', 'retrieval_error', 'TEXT')
}

export const getDb = (): Db => {
  if (!instance) {instance = openDatabase()}
  return instance
}

export const closeDb = (): void => {
  instance?.close()
  instance = null
}

export const getSetting = (key: string, fallback: string | null = null): string | null => {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? fallback
}

export const setSetting = (key: string, value: string): void => {
  getDb()
    .prepare(
      'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, value)
}

export const deleteSetting = (key: string): void => {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key)
}

export const getJsonSetting = <T>(key: string, fallback: T): T => {
  const raw = getSetting(key)
  if (!raw) {return fallback}
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export const setJsonSetting = (key: string, value: unknown): void => {
  setSetting(key, JSON.stringify(value))
}

/** Convenience for JSON columns. */
export const parseJson = <T>(raw: string | null | undefined, fallback: T): T => {
  if (!raw) {return fallback}
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export const transaction = <T>(db: Db, work: () => T): T => {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
