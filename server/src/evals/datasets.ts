/**
 * Datasets: JSONL validation, immutable snapshots, DB sync, and gold-anchor
 * resolution / drift reporting.
 *
 * A dataset has mutable **draft** cases in the `cases` table. Snapshotting
 * freezes the current drafts into `datasets/<slug>/<version>.jsonl` plus a
 * per-dataset `manifest.json`, and records a `dataset_versions` row. Snapshot
 * files are immutable: runs and exports read them, never the drafts.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { config } from '../config.ts'
import { getDb, parseJson, transaction, type Db } from '../db/index.ts'
import { newId, now } from '../../../shared/ids.ts'
import type {
  AnchorResolution,
  Dataset,
  DatasetCase,
  DatasetVersion,
  GoldAnchor,
} from '../../../shared/types.ts'
import { BusinessError, errorMessage } from './errors.ts'

/* ------------------------------ JSONL parsing ------------------------------ */

export type DatasetIssue = { line: number; caseId: string | null; field: string; message: string }

export type ParsedDataset = { cases: DatasetCase[]; issues: DatasetIssue[] }

type FieldIssue = { field: string; message: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

const stringList = (value: unknown, field: string, issues: FieldIssue[]): string[] => {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value)) {
    issues.push({ field, message: 'must be an array of strings' })
    return []
  }
  const out: string[] = []
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string') {
      issues.push({ field: `${field}[${index}]`, message: 'must be a string' })
      continue
    }
    if (entry.trim().length > 0) {
      out.push(entry)
    }
  }
  return out
}

const optionalString = (
  value: unknown,
  field: string,
  issues: FieldIssue[]
): string | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    issues.push({ field, message: 'must be a string' })
    return undefined
  }
  return value
}

const normalizeAnchor = (
  value: unknown,
  field: string,
  issues: FieldIssue[]
): GoldAnchor | null => {
  if (!isRecord(value)) {
    issues.push({ field, message: 'must be an object with a "doc" field' })
    return null
  }
  if (!isNonEmptyString(value.doc)) {
    issues.push({
      field: `${field}.doc`,
      message: 'must be a non-empty string (document path or title)',
    })
    return null
  }
  const anchor: GoldAnchor = { doc: value.doc.trim() }
  if (value.heading !== undefined && value.heading !== null) {
    if (typeof value.heading !== 'string') {
      issues.push({ field: `${field}.heading`, message: 'must be a string' })
    } else if (value.heading.trim().length > 0) {
      anchor.heading = value.heading.trim()
    }
  }
  if (value.quote !== undefined && value.quote !== null) {
    if (typeof value.quote !== 'string') {
      issues.push({ field: `${field}.quote`, message: 'must be a string' })
    } else if (value.quote.trim().length > 0) {
      anchor.quote = value.quote.trim()
    }
  }
  return anchor
}

export type CaseValidation = { ok: boolean; case: DatasetCase | null; issues: FieldIssue[] }

/** Validate and normalize one DatasetCase. Unknown extra fields are ignored. */
export const validateDatasetCase = (input: unknown): CaseValidation => {
  const issues: FieldIssue[] = []
  if (!isRecord(input)) {
    return { ok: false, case: null, issues: [{ field: 'case', message: 'must be a JSON object' }] }
  }
  if (!isNonEmptyString(input.id)) {
    issues.push({ field: 'id', message: 'is required and must be a non-empty string' })
  }
  const datasetId = optionalString(input.datasetId, 'datasetId', issues)

  const slices = stringList(input.slices, 'slices', issues)

  const messages: DatasetCase['messages'] = []
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    issues.push({ field: 'messages', message: 'must be a non-empty array' })
  } else {
    for (const [index, entry] of input.messages.entries()) {
      if (!isRecord(entry)) {
        issues.push({
          field: `messages[${index}]`,
          message: 'must be an object with role and content',
        })
        continue
      }
      if (entry.role !== 'user' && entry.role !== 'system') {
        issues.push({ field: `messages[${index}].role`, message: 'must be "user" or "system"' })
        continue
      }
      if (typeof entry.content !== 'string' || entry.content.trim().length === 0) {
        issues.push({ field: `messages[${index}].content`, message: 'must be a non-empty string' })
        continue
      }
      messages.push({ role: entry.role, content: entry.content })
    }
    if (messages.length > 0 && !messages.some((message) => message.role === 'user')) {
      issues.push({ field: 'messages', message: 'must include at least one user message' })
    }
  }

  const expectedRaw = input.expected
  const expected: DatasetCase['expected'] = {
    behavior: 'any',
    mustContain: [],
    mustNotContain: [],
    anchors: [],
    minCitations: 0,
  }
  if (!isRecord(expectedRaw)) {
    issues.push({ field: 'expected', message: 'is required and must be an object' })
  } else {
    const answer = optionalString(expectedRaw.answer, 'expected.answer', issues)
    if (answer !== undefined) {
      expected.answer = answer
    }
    if (expectedRaw.behavior === undefined) {
      issues.push({
        field: 'expected.behavior',
        message: 'is required: one of "answer", "refuse", "any"',
      })
    } else if (
      expectedRaw.behavior !== 'answer' &&
      expectedRaw.behavior !== 'refuse' &&
      expectedRaw.behavior !== 'any'
    ) {
      issues.push({
        field: 'expected.behavior',
        message: 'must be one of "answer", "refuse", "any"',
      })
    } else {
      expected.behavior = expectedRaw.behavior
    }
    expected.mustContain = stringList(expectedRaw.mustContain, 'expected.mustContain', issues)
    expected.mustNotContain = stringList(
      expectedRaw.mustNotContain,
      'expected.mustNotContain',
      issues
    )
    if (expectedRaw.anchors !== undefined && expectedRaw.anchors !== null) {
      if (!Array.isArray(expectedRaw.anchors)) {
        issues.push({
          field: 'expected.anchors',
          message: 'must be an array of GoldAnchor objects',
        })
      } else {
        for (const [index, entry] of expectedRaw.anchors.entries()) {
          const anchor = normalizeAnchor(entry, `expected.anchors[${index}]`, issues)
          if (anchor) {
            expected.anchors.push(anchor)
          }
        }
      }
    }
    if (expectedRaw.minCitations !== undefined && expectedRaw.minCitations !== null) {
      const value = expectedRaw.minCitations
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        issues.push({ field: 'expected.minCitations', message: 'must be a non-negative integer' })
      } else {
        expected.minCitations = value
      }
    }
  }

  const notes = optionalString(input.notes, 'notes', issues)
  const sourceTraceId = optionalString(input.sourceTraceId, 'sourceTraceId', issues)
  const createdAt =
    typeof input.createdAt === 'number' && Number.isFinite(input.createdAt)
      ? input.createdAt
      : undefined
  const updatedAt =
    typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt)
      ? input.updatedAt
      : undefined

  if (issues.length > 0) {
    return { ok: false, case: null, issues }
  }
  const result: DatasetCase = {
    id: (input.id as string).trim(),
    slices,
    messages,
    expected,
  }
  if (datasetId !== undefined) {
    result.datasetId = datasetId
  }
  if (notes !== undefined) {
    result.notes = notes
  }
  if (sourceTraceId !== undefined) {
    result.sourceTraceId = sourceTraceId
  }
  if (createdAt !== undefined) {
    result.createdAt = createdAt
  }
  if (updatedAt !== undefined) {
    result.updatedAt = updatedAt
  }
  return { ok: true, case: result, issues }
}

/** Parse a JSONL dataset file. Blank lines are ignored; invalid lines are reported, not thrown. */
export const parseDatasetJsonl = (text: string): ParsedDataset => {
  const cases: DatasetCase[] = []
  const issues: DatasetIssue[] = []
  const seen = new Set<string>()
  const lines = text.split(/\r?\n/)
  for (const [index, rawLine] of lines.entries()) {
    const line = index + 1
    const trimmed = rawLine.trim()
    if (trimmed.length === 0) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      issues.push({
        line,
        caseId: null,
        field: 'json',
        message: `invalid JSON: ${errorMessage(error)}`,
      })
      continue
    }
    const validation = validateDatasetCase(parsed)
    if (!validation.ok || !validation.case) {
      for (const issue of validation.issues) {
        issues.push({
          line,
          caseId: isRecord(parsed) && typeof parsed.id === 'string' ? parsed.id : null,
          ...issue,
        })
      }
      continue
    }
    if (seen.has(validation.case.id)) {
      issues.push({
        line,
        caseId: validation.case.id,
        field: 'id',
        message: 'duplicate case id in file',
      })
      continue
    }
    seen.add(validation.case.id)
    cases.push(validation.case)
  }
  return { cases, issues }
}

/* ------------------------------ canonical case form ------------------------------ */

/**
 * Stable field order for snapshots, hashes and exports. Volatile timestamps
 * (`createdAt`/`updatedAt`) are excluded so re-importing unchanged data always
 * produces the same content hash. Keep this in sync with DatasetCase.
 */
const canonicalExpected = (input: DatasetCase['expected']): DatasetCase['expected'] => {
  const expected: DatasetCase['expected'] = {
    behavior: input.behavior,
    mustContain: [...input.mustContain],
    mustNotContain: [...input.mustNotContain],
    anchors: input.anchors.map((anchor) => {
      const copy: GoldAnchor = { doc: anchor.doc }
      if (anchor.heading !== undefined) {
        copy.heading = anchor.heading
      }
      if (anchor.quote !== undefined) {
        copy.quote = anchor.quote
      }
      return copy
    }),
    minCitations: input.minCitations,
  }
  if (input.answer !== undefined) {
    expected.answer = input.answer
  }
  return expected
}

export const canonicalCase = (input: DatasetCase): DatasetCase => {
  const out: DatasetCase = {
    id: input.id,
    slices: [...input.slices],
    messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
    expected: canonicalExpected(input.expected),
  }
  if (input.datasetId !== undefined) {
    out.datasetId = input.datasetId
  }
  if (input.notes !== undefined) {
    out.notes = input.notes
  }
  if (input.sourceTraceId !== undefined) {
    out.sourceTraceId = input.sourceTraceId
  }
  // Volatile bookkeeping timestamps are deliberately not part of snapshot
  // content: re-importing an unchanged dataset must reproduce the same hash.
  return out
}

export const serializeCase = (input: DatasetCase): string => {
  // The snapshot file is git-tracked and must not embed the local DB id;
  // otherwise a fresh install would rewrite every dataset line.
  const value = canonicalCase(input)
  delete value.datasetId
  return JSON.stringify(value)
}

export const serializeCasesJsonl = (cases: DatasetCase[]): string =>
  cases.length === 0 ? '' : `${cases.map((item) => serializeCase(item)).join('\n')}\n`

/* ------------------------------ hashing / files ------------------------------ */

export const sha256 = (value: string | Uint8Array): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

export const datasetSlug = (name: string): string => {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug.slice(0, 64) : 'dataset'
}

const writeFileAtomic = (file: string, content: string): void => {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp, content, 'utf8')
  renameSync(temp, file)
}

const storedPath = (file: string): string => {
  const relative = path.relative(config.root, file)
  return relative.startsWith('..') || path.isAbsolute(relative) ? file : relative
}

export const resolveStoredPath = (stored: string): string =>
  path.isAbsolute(stored) ? stored : path.resolve(config.root, stored)

/* ------------------------------ corpus version ------------------------------ */

export type CorpusVersionInfo = { version: string; documents: number; chunks: number }

/** Fingerprint of the retrieval corpus, so anchor drift can be tied to corpus changes. */
export const corpusVersionInfo = (db: Db = getDb()): CorpusVersionInfo => {
  const documents = db
    .prepare('SELECT id, title, content_hash FROM documents ORDER BY id ASC')
    .all() as { id: string; title: string; content_hash: string }[]
  const chunks = (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n
  const version = sha256(
    JSON.stringify({
      documents: documents.map((row) => [row.id, row.title, row.content_hash]),
      chunks,
    })
  )
  return { version, documents: documents.length, chunks }
}

export const computeCorpusVersion = (db: Db = getDb()): string => corpusVersionInfo(db).version

/* ------------------------------ row mapping ------------------------------ */

type DatasetRow = { id: string; name: string; description: string; created_at: number }
type DatasetListRow = DatasetRow & { case_count: number; latest_version: number | null }
type CaseRow = {
  id: string
  dataset_id: string
  case_key: string
  data_json: string
  updated_at: number
}
type VersionRow = {
  id: string
  dataset_id: string
  version: number
  path: string
  content_hash: string
  case_count: number
  notes: string
  anchor_status_json: string
  created_at: number
}

export const mapDatasetRow = (row: DatasetListRow): Dataset => ({
  id: row.id,
  name: row.name,
  description: row.description,
  createdAt: row.created_at,
  caseCount: row.case_count,
  latestVersion: row.latest_version,
})

type StoredAnchorStatus = AnchorResolution & {
  checkedAt?: number
  corpusVersion?: string
  anchors?: {
    caseId: string
    doc: string
    heading: string | null
    quote: string | null
    resolved: boolean
  }[]
}

export const mapVersionRow = (row: VersionRow): DatasetVersion => {
  const stored = parseJson<StoredAnchorStatus>(row.anchor_status_json, {
    resolved: 0,
    total: 0,
    missing: [],
  })
  return {
    id: row.id,
    datasetId: row.dataset_id,
    version: row.version,
    path: row.path,
    contentHash: row.content_hash,
    caseCount: row.case_count,
    notes: row.notes,
    createdAt: row.created_at,
    anchorStatus: {
      resolved: stored.resolved ?? 0,
      total: stored.total ?? 0,
      missing: stored.missing ?? [],
    },
  }
}

export const mapCaseRow = (row: CaseRow): DatasetCase => {
  const parsed = parseJson<DatasetCase>(row.data_json, {
    id: row.case_key,
    datasetId: row.dataset_id,
    slices: [],
    messages: [],
    expected: {
      behavior: 'any',
      mustContain: [],
      mustNotContain: [],
      anchors: [],
      minCitations: 0,
    },
  })
  return {
    ...parsed,
    id: parsed.id ?? row.case_key,
    datasetId: parsed.datasetId ?? row.dataset_id,
  }
}

/* ------------------------------ dataset CRUD ------------------------------ */

export const listDatasets = (db: Db = getDb()): Dataset[] => {
  const rows = db
    .prepare(
      `SELECT d.id, d.name, d.description, d.created_at,
              (SELECT COUNT(*) FROM cases c WHERE c.dataset_id = d.id) AS case_count,
              (SELECT MAX(version) FROM dataset_versions v WHERE v.dataset_id = d.id) AS latest_version
       FROM datasets d
       ORDER BY d.created_at ASC, d.name ASC`
    )
    .all() as DatasetListRow[]
  return rows.map(mapDatasetRow)
}

export const findDatasetRow = (ref: string, db: Db = getDb()): DatasetListRow | null => {
  const row = db
    .prepare(
      `SELECT d.id, d.name, d.description, d.created_at,
              (SELECT COUNT(*) FROM cases c WHERE c.dataset_id = d.id) AS case_count,
              (SELECT MAX(version) FROM dataset_versions v WHERE v.dataset_id = d.id) AS latest_version
       FROM datasets d WHERE d.id = ? OR d.name = ? LIMIT 1`
    )
    .get(ref, ref) as DatasetListRow | undefined
  return row ?? null
}

export const requireDataset = (ref: string, db: Db = getDb()): DatasetListRow => {
  const row = findDatasetRow(ref, db)
  if (!row) {
    throw new BusinessError(`dataset not found: ${ref}`, 'dataset_not_found', 404)
  }
  return row
}

export const getDataset = (ref: string, db: Db = getDb()): Dataset =>
  mapDatasetRow(requireDataset(ref, db))

export const createDataset = (
  input: { name: string; description?: string },
  db: Db = getDb()
): Dataset => {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name.length === 0) {
    throw new BusinessError('dataset name is required', 'invalid_dataset_name', 400)
  }
  if (name.length > 120) {
    throw new BusinessError(
      'dataset name must be at most 120 characters',
      'invalid_dataset_name',
      400
    )
  }
  if (findDatasetRow(name, db)) {
    throw new BusinessError(`dataset "${name}" already exists`, 'dataset_exists', 409)
  }
  const id = newId('ds')
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  const createdAt = now()
  db.prepare('INSERT INTO datasets(id, name, description, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    name,
    description,
    createdAt
  )
  return { id, name, description, createdAt, caseCount: 0, latestVersion: null }
}

/** Idempotent helper used by the demo and imports. */
export const ensureDataset = (
  input: { name: string; description?: string },
  db: Db = getDb()
): Dataset => {
  const existing = findDatasetRow(input.name, db)
  return existing ? mapDatasetRow(existing) : createDataset(input, db)
}

/* ------------------------------ case CRUD ------------------------------ */

const caseRowData = (
  datasetId: string,
  input: DatasetCase
): { case: DatasetCase; json: string } => {
  const timestamp = now()
  const validated = validateDatasetCase({ ...input, datasetId })
  if (!validated.ok || !validated.case) {
    const details = validated.issues.map((issue) => `${issue.field}: ${issue.message}`).join('; ')
    throw new BusinessError(`invalid dataset case: ${details}`, 'invalid_case', 400)
  }
  const caseValue: DatasetCase = {
    ...validated.case,
    datasetId,
    createdAt: input.createdAt ?? timestamp,
    updatedAt: timestamp,
  }
  return { case: caseValue, json: serializeCase(caseValue) }
}

export const listDraftCases = (datasetId: string, db: Db = getDb()): DatasetCase[] => {
  const rows = db
    .prepare(
      'SELECT id, dataset_id, case_key, data_json, updated_at FROM cases WHERE dataset_id = ? ORDER BY case_key ASC'
    )
    .all(datasetId) as CaseRow[]
  return rows.map(mapCaseRow)
}

export const getDraftCase = (caseId: string, db: Db = getDb()): DatasetCase => {
  const row = db
    .prepare(
      'SELECT id, dataset_id, case_key, data_json, updated_at FROM cases WHERE case_key = ? OR id = ? LIMIT 1'
    )
    .get(caseId, caseId) as CaseRow | undefined
  if (!row) {
    throw new BusinessError(`case not found: ${caseId}`, 'case_not_found', 404)
  }
  return mapCaseRow(row)
}

export type ImportResult = {
  imported: number
  skipped: number
  issues: DatasetIssue[]
  cases: DatasetCase[]
}

/** Import JSONL into a dataset's draft case set. Valid cases are inserted or replaced by case id. */
export const importDatasetJsonl = (
  datasetRef: string,
  jsonl: string,
  db: Db = getDb()
): ImportResult => {
  const dataset = requireDataset(datasetRef, db)
  const parsed = parseDatasetJsonl(jsonl)
  const issues = [...parsed.issues]
  const existing = new Set(listDraftCases(dataset.id, db).map((item) => item.id))
  const imported: DatasetCase[] = []
  let importedCount = 0
  const seen = new Set<string>()
  transaction(db, () => {
    for (const item of parsed.cases) {
      const { case: caseValue, json } = caseRowData(dataset.id, {
        ...item,
        datasetId: dataset.id,
        createdAt: item.createdAt ?? (existing.has(item.id) ? undefined : now()),
      })
      if (seen.has(caseValue.id)) {
        issues.push({
          line: 0,
          caseId: caseValue.id,
          field: 'id',
          message: 'duplicate case id in import',
        })
        continue
      }
      seen.add(caseValue.id)
      const existingRow = db
        .prepare('SELECT id FROM cases WHERE dataset_id = ? AND case_key = ?')
        .get(dataset.id, caseValue.id) as { id: string } | undefined
      const rowId = existingRow?.id ?? newId('case')
      db.prepare(
        `INSERT INTO cases(id, dataset_id, case_key, data_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(dataset_id, case_key) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`
      ).run(rowId, dataset.id, caseValue.id, json, now())
      imported.push(caseValue)
      importedCount += 1
    }
  })
  return {
    imported: importedCount,
    skipped: issues.length,
    issues,
    cases: imported,
  }
}

export const createCase = (input: DatasetCase, db: Db = getDb()): DatasetCase => {
  const datasetRef = input.datasetId
  if (!datasetRef) {
    throw new BusinessError('datasetId is required to create a case', 'missing_dataset_id', 400)
  }
  const dataset = requireDataset(datasetRef, db)
  const id = input.id.trim()
  if (!id) {
    throw new BusinessError('case id is required', 'invalid_case', 400)
  }
  const duplicate = db
    .prepare('SELECT id FROM cases WHERE dataset_id = ? AND case_key = ?')
    .get(dataset.id, id)
  if (duplicate) {
    throw new BusinessError(
      `case ${id} already exists in dataset ${dataset.name}`,
      'case_exists',
      409
    )
  }
  const { case: caseValue, json } = caseRowData(dataset.id, { ...input, datasetId: dataset.id })
  db.prepare(
    'INSERT INTO cases(id, dataset_id, case_key, data_json, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(caseValue.id, dataset.id, caseValue.id, json, now())
  return caseValue
}

export const updateCase = (
  caseId: string,
  patch: Partial<DatasetCase>,
  db: Db = getDb()
): DatasetCase => {
  const current = getDraftCase(caseId, db)
  const row = db
    .prepare('SELECT id, dataset_id FROM cases WHERE dataset_id = ? AND case_key = ?')
    .get(current.datasetId ?? '', current.id) as { id: string; dataset_id: string } | undefined
  if (!row) {
    throw new BusinessError(`case not found: ${caseId}`, 'case_not_found', 404)
  }
  const merged: DatasetCase = {
    ...current,
    ...patch,
    id: current.id,
    datasetId: row.dataset_id,
    expected: {
      ...current.expected,
      ...(patch.expected ?? {}),
      mustContain: patch.expected?.mustContain ?? current.expected.mustContain,
      mustNotContain: patch.expected?.mustNotContain ?? current.expected.mustNotContain,
      anchors: patch.expected?.anchors ?? current.expected.anchors,
    },
    createdAt: current.createdAt,
  }
  const { case: caseValue, json } = caseRowData(row.dataset_id, merged)
  db.prepare('UPDATE cases SET data_json = ?, updated_at = ? WHERE id = ?').run(json, now(), row.id)
  return caseValue
}

export const deleteCase = (caseId: string, db: Db = getDb()): boolean => {
  const result = db.prepare('DELETE FROM cases WHERE id = ? OR case_key = ?').run(caseId, caseId)
  return Number(result.changes) > 0
}

/* ------------------------------ versions ------------------------------ */

export const listDatasetVersions = (datasetRef: string, db: Db = getDb()): DatasetVersion[] => {
  const dataset = requireDataset(datasetRef, db)
  const rows = db
    .prepare('SELECT * FROM dataset_versions WHERE dataset_id = ? ORDER BY version ASC')
    .all(dataset.id) as VersionRow[]
  return rows.map(mapVersionRow)
}

export const getDatasetVersion = (versionId: string, db: Db = getDb()): DatasetVersion => {
  const row = db.prepare('SELECT * FROM dataset_versions WHERE id = ?').get(versionId) as
    | VersionRow
    | undefined
  if (!row) {
    throw new BusinessError(`dataset version not found: ${versionId}`, 'version_not_found', 404)
  }
  return mapVersionRow(row)
}

export const getDatasetVersionByNumber = (
  datasetRef: string,
  version: number,
  db: Db = getDb()
): DatasetVersion => {
  const dataset = requireDataset(datasetRef, db)
  const row = db
    .prepare('SELECT * FROM dataset_versions WHERE dataset_id = ? AND version = ?')
    .get(dataset.id, version) as VersionRow | undefined
  if (!row) {
    throw new BusinessError(
      `dataset ${dataset.name} has no version ${version}`,
      'version_not_found',
      404
    )
  }
  return mapVersionRow(row)
}

export const latestDatasetVersion = (datasetRef: string, db: Db = getDb()): DatasetVersion => {
  const dataset = requireDataset(datasetRef, db)
  const row = db
    .prepare('SELECT * FROM dataset_versions WHERE dataset_id = ? ORDER BY version DESC LIMIT 1')
    .get(dataset.id) as VersionRow | undefined
  if (!row) {
    throw new BusinessError(`dataset ${dataset.name} has no snapshots yet`, 'no_versions', 404)
  }
  return mapVersionRow(row)
}

/** Read the immutable snapshot file for a version. */
export const readVersionCases = (version: DatasetVersion): DatasetCase[] => {
  const file = resolveStoredPath(version.path)
  if (!existsSync(file)) {
    throw new BusinessError(
      `snapshot file missing for ${version.id}: ${file}`,
      'snapshot_file_missing',
      500
    )
  }
  const text = readFileSync(file, 'utf8')
  const parsed = parseDatasetJsonl(text)
  if (parsed.issues.length > 0) {
    throw new BusinessError(
      `snapshot file is corrupt (${version.path}): ${parsed.issues[0]?.field} — ${parsed.issues[0]?.message}`,
      'corrupt_snapshot',
      500
    )
  }
  return parsed.cases
}

/** Export the exact immutable JSONL bytes for a dataset version. */
export const exportDatasetVersionJsonl = (versionId: string, db: Db = getDb()): string => {
  const version = getDatasetVersion(versionId, db)
  const file = resolveStoredPath(version.path)
  if (!existsSync(file)) {
    throw new BusinessError(
      `snapshot file missing for ${version.id}: ${file}`,
      'snapshot_file_missing',
      500
    )
  }
  return readFileSync(file, 'utf8')
}

/* ------------------------------ anchor resolution ------------------------------ */

export type AnchorCheck = {
  caseId: string
  doc: string
  heading: string | null
  quote: string | null
  resolved: boolean
  chunkIds: string[]
  reason: 'resolved' | 'doc_not_found' | 'heading_not_found' | 'quote_not_found'
}

export type CaseAnchorResolution = {
  resolution: AnchorResolution
  checks: AnchorCheck[]
  chunkIds: string[]
}

export type AnchorResolver = {
  resolveCase: (input: DatasetCase) => CaseAnchorResolution
  corpus: () => CorpusVersionInfo
}

type DocumentRow = { id: string; title: string; uri: string | null; meta_json: string }
type ChunkRow = { id: string; document_id: string; breadcrumb: string; text: string }

const normalizeRef = (value: string): string =>
  value.trim().toLowerCase().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')

const normalizeText = (value: string): string =>
  value.toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim()

const normalizeHeading = (value: string): string =>
  normalizeText(value)
    .replace(/\s*>\s*/g, ' > ')
    .replace(/\s*›\s*/g, ' > ')

const documentRefs = (row: DocumentRow): string[] => {
  const refs = [normalizeRef(row.title)]
  if (row.uri) {
    refs.push(normalizeRef(row.uri))
  }
  const meta = parseJson<Record<string, unknown>>(row.meta_json, {})
  for (const key of ['path', 'filePath', 'filepath', 'sourcePath', 'fileName', 'filename']) {
    const value = meta[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      refs.push(normalizeRef(value))
    }
  }
  return [...new Set(refs.filter((ref) => ref.length > 0))]
}

const docMatches = (refs: string[], target: string): boolean =>
  refs.some(
    (ref) =>
      ref === target ||
      ref.endsWith(`/${target}`) ||
      target.endsWith(`/${ref}`) ||
      ref.split('/').pop() === target.split('/').pop()
  )

const anchorDescription = (anchor: GoldAnchor): string => {
  const heading = anchor.heading ? `#${anchor.heading}` : ''
  const quote = anchor.quote
    ? ` "${anchor.quote.length > 60 ? `${anchor.quote.slice(0, 57)}…` : anchor.quote}"`
    : ''
  return `${anchor.doc}${heading}${quote}`
}

/**
 * Build a resolver that matches gold anchors (doc path/title + heading + quote)
 * against the retrieval corpus. Documents and chunks are cached per instance;
 * create one per run or snapshot.
 */
export const createAnchorResolver = (
  options: { db?: Db; collection?: string | null } = {}
): AnchorResolver => {
  const db = options.db ?? getDb()
  let documents = db
    .prepare('SELECT id, title, uri, meta_json FROM documents ORDER BY id ASC')
    .all() as DocumentRow[]
  if (options.collection) {
    const collection = db
      .prepare('SELECT id FROM collections WHERE id = ? OR name = ? LIMIT 1')
      .get(options.collection, options.collection) as { id: string } | undefined
    if (!collection) {
      throw new BusinessError(
        `collection not found: ${options.collection}`,
        'collection_not_found',
        404
      )
    }
    documents = db
      .prepare(
        'SELECT id, title, uri, meta_json FROM documents WHERE collection_id = ? ORDER BY id ASC'
      )
      .all(collection.id) as DocumentRow[]
  }
  const docRefs = new Map<string, string[]>()
  for (const document of documents) {
    docRefs.set(document.id, documentRefs(document))
  }
  const chunkCache = new Map<string, ChunkRow[]>()
  const chunksFor = (documentId: string): ChunkRow[] => {
    const cached = chunkCache.get(documentId)
    if (cached) {
      return cached
    }
    const rows = db
      .prepare(
        'SELECT id, document_id, breadcrumb, text FROM chunks WHERE document_id = ? ORDER BY ordinal ASC'
      )
      .all(documentId) as ChunkRow[]
    chunkCache.set(documentId, rows)
    return rows
  }

  const resolveCase = (input: DatasetCase): CaseAnchorResolution => {
    const checks: AnchorCheck[] = []
    const chunkIds = new Set<string>()
    let resolved = 0
    for (const anchor of input.expected.anchors) {
      const target = normalizeRef(anchor.doc)
      const matches = documents.filter((candidate) =>
        docMatches(docRefs.get(candidate.id) ?? [], target)
      )
      if (matches.length === 0) {
        checks.push({
          caseId: input.id,
          doc: anchor.doc,
          heading: anchor.heading ?? null,
          quote: anchor.quote ?? null,
          resolved: false,
          chunkIds: [],
          reason: 'doc_not_found',
        })
        continue
      }
      let chunks = matches.flatMap((match) => chunksFor(match.id))
      if (anchor.heading) {
        const heading = normalizeHeading(anchor.heading)
        const filtered = chunks.filter((chunk) =>
          normalizeHeading(chunk.breadcrumb).includes(heading)
        )
        if (filtered.length === 0) {
          checks.push({
            caseId: input.id,
            doc: anchor.doc,
            heading: anchor.heading,
            quote: anchor.quote ?? null,
            resolved: false,
            chunkIds: [],
            reason: 'heading_not_found',
          })
          continue
        }
        chunks = filtered
      }
      if (anchor.quote) {
        const quote = normalizeText(anchor.quote)
        const filtered = chunks.filter((chunk) => normalizeText(chunk.text).includes(quote))
        if (filtered.length === 0) {
          checks.push({
            caseId: input.id,
            doc: anchor.doc,
            heading: anchor.heading ?? null,
            quote: anchor.quote,
            resolved: false,
            chunkIds: [],
            reason: 'quote_not_found',
          })
          continue
        }
        chunks = filtered
      }
      const ids = chunks.map((chunk) => chunk.id)
      for (const id of ids) {
        chunkIds.add(id)
      }
      resolved += 1
      checks.push({
        caseId: input.id,
        doc: anchor.doc,
        heading: anchor.heading ?? null,
        quote: anchor.quote ?? null,
        resolved: true,
        chunkIds: ids,
        reason: 'resolved',
      })
    }
    const missing: string[] = []
    for (const check of checks) {
      if (!check.resolved) {
        missing.push(
          `${check.caseId}: ${anchorDescription({ doc: check.doc, ...(check.heading ? { heading: check.heading } : {}), ...(check.quote ? { quote: check.quote } : {}) })} (${check.reason})`
        )
      }
    }
    return {
      resolution: { resolved, total: checks.length, missing },
      checks,
      chunkIds: [...chunkIds],
    }
  }

  return { resolveCase, corpus: () => corpusVersionInfo(db) }
}

export const resolveCaseAnchors = (
  input: DatasetCase,
  options: { db?: Db; collection?: string | null } = {}
): CaseAnchorResolution => createAnchorResolver(options).resolveCase(input)

export type ResolveDatasetAnchorsResult = {
  resolution: AnchorResolution
  byCase: CaseAnchorResolution[]
  corpusVersion: string
}

export const resolveDatasetAnchors = (
  cases: DatasetCase[],
  options: { db?: Db; collection?: string | null } = {}
): ResolveDatasetAnchorsResult => {
  const resolver = createAnchorResolver(options)
  const byCase = cases.map((item) => resolver.resolveCase(item))
  let resolved = 0
  let total = 0
  const missing: string[] = []
  for (const entry of byCase) {
    resolved += entry.resolution.resolved
    total += entry.resolution.total
    missing.push(...entry.resolution.missing)
  }
  return {
    resolution: { resolved, total, missing },
    byCase,
    corpusVersion: resolver.corpus().version,
  }
}

/* ------------------------------ snapshots ------------------------------ */

export type DatasetManifestVersion = {
  version: number
  path: string
  contentHash: string
  caseCount: number
  notes: string
  createdAt: number
  anchorStatus: AnchorResolution
  corpusVersion: string
}

export type DatasetManifest = {
  datasetId: string
  name: string
  slug: string
  description: string
  corpusVersion: string
  updatedAt: number
  versions: DatasetManifestVersion[]
}

export type SnapshotOptions = {
  db?: Db
  datasetsDir?: string
  collection?: string | null
  corpusVersion?: string
}

export type SnapshotOutcome = {
  version: DatasetVersion
  manifest: DatasetManifest
  manifestPath: string
  filePath: string
}

export const datasetManifestPath = (
  datasetRef: string,
  datasetsDir = config.datasetsDir
): string => {
  const slug = datasetSlug(datasetRef)
  return path.join(datasetsDir, slug, 'manifest.json')
}

export const readDatasetManifest = (manifestPath: string): DatasetManifest | null => {
  if (!existsSync(manifestPath)) {
    return null
  }
  const parsed = parseJson<DatasetManifest | null>(readFileSync(manifestPath, 'utf8'), null)
  if (!parsed || typeof parsed.datasetId !== 'string' || !Array.isArray(parsed.versions)) {
    throw new BusinessError(`dataset manifest is corrupt: ${manifestPath}`, 'corrupt_manifest', 500)
  }
  return parsed
}

/**
 * Snapshot current draft cases into an immutable versioned JSONL file plus a
 * manifest. The version number is the next integer for the dataset; the content
 * hash is sha256 of the exact file bytes.
 */
export const snapshotDataset = (
  datasetRef: string,
  input: { notes?: string } = {},
  options: SnapshotOptions = {}
): SnapshotOutcome => {
  const db = options.db ?? getDb()
  const datasetsDir = options.datasetsDir ?? config.datasetsDir
  const dataset = requireDataset(datasetRef, db)
  const cases = listDraftCases(dataset.id, db)
  if (cases.length === 0) {
    throw new BusinessError(
      `dataset "${dataset.name}" has no cases to snapshot`,
      'empty_dataset',
      400
    )
  }
  const anchors = resolveDatasetAnchors(cases, {
    db,
    ...(options.collection !== undefined ? { collection: options.collection } : {}),
  })
  const corpusVersion = options.corpusVersion ?? anchors.corpusVersion
  const versionRow = db
    .prepare('SELECT MAX(version) AS version FROM dataset_versions WHERE dataset_id = ?')
    .get(dataset.id) as { version: number | null }
  const version = (versionRow.version ?? 0) + 1
  const slug = datasetSlug(dataset.name)
  const directory = path.join(datasetsDir, slug)
  const filePath = path.join(directory, `${String(version).padStart(4, '0')}.jsonl`)
  const content = serializeCasesJsonl(cases)
  const contentHash = sha256(content)
  const createdAt = now()
  const anchorsDetail: StoredAnchorStatus = {
    ...anchors.resolution,
    checkedAt: createdAt,
    corpusVersion,
    anchors: anchors.byCase.flatMap((entry) =>
      entry.checks.map((check) => ({
        caseId: check.caseId,
        doc: check.doc,
        heading: check.heading,
        quote: check.quote,
        resolved: check.resolved,
      }))
    ),
  }
  const versionId = newId('dsv')
  const notes = typeof input.notes === 'string' ? input.notes : ''

  writeFileAtomic(filePath, content)

  const manifestPath = path.join(directory, 'manifest.json')
  let previous = readDatasetManifest(manifestPath)
  if (previous && previous.datasetId !== dataset.id) {
    const owner = db.prepare('SELECT id FROM datasets WHERE id = ?').get(previous.datasetId) as
      | { id: string }
      | undefined
    if (owner) {
      throw new BusinessError(
        `datasets directory ${directory} belongs to another dataset (${previous.datasetId})`,
        'dataset_slug_conflict',
        409
      )
    }
    // The manifest is an orphan from a reset/replaced local database. Adopt the
    // directory for this dataset; snapshot files are content-addressed and the
    // new version is written immutably with the next version number.
    previous = null
  }
  const manifest: DatasetManifest = {
    datasetId: dataset.id,
    name: dataset.name,
    slug,
    description: dataset.description,
    corpusVersion,
    updatedAt: createdAt,
    versions: [...(previous?.versions ?? [])],
  }
  manifest.versions = manifest.versions.filter((entry) => entry.version !== version)
  manifest.versions.push({
    version,
    path: storedPath(filePath),
    contentHash,
    caseCount: cases.length,
    notes,
    createdAt,
    anchorStatus: anchors.resolution,
    corpusVersion,
  })
  manifest.versions.sort((a, b) => a.version - b.version)

  try {
    transaction(db, () => {
      db.prepare(
        `INSERT INTO dataset_versions(id, dataset_id, version, path, content_hash, case_count, notes, anchor_status_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        versionId,
        dataset.id,
        version,
        storedPath(filePath),
        contentHash,
        cases.length,
        notes,
        JSON.stringify(anchorsDetail),
        createdAt
      )
      writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    })
  } catch (error) {
    if (existsSync(filePath)) {
      try {
        unlinkSync(filePath)
      } catch {
        // best-effort cleanup; the DB write is the source of truth
      }
    }
    throw error
  }

  const row = db.prepare('SELECT * FROM dataset_versions WHERE id = ?').get(versionId) as VersionRow
  return { version: mapVersionRow(row), manifest, manifestPath, filePath }
}

/* ------------------------------ drift ------------------------------ */

export type AnchorDriftEntry = {
  caseId: string
  doc: string
  heading: string | null
  quote: string | null
  was: 'resolved' | 'missing'
  now: 'resolved' | 'missing'
  reason: string
}

export type AnchorDriftReport = {
  datasetId: string
  datasetName: string
  version: number
  stored: AnchorResolution
  current: AnchorResolution
  corpusVersion: { stored: string | null; current: string }
  drifted: AnchorDriftEntry[]
  ok: boolean
}

const anchorKey = (
  caseId: string,
  doc: string,
  heading: string | null,
  quote: string | null
): string =>
  JSON.stringify([
    caseId,
    normalizeRef(doc),
    heading === null ? null : normalizeHeading(heading),
    quote === null ? null : normalizeText(quote),
  ])

/**
 * Compare the anchor status recorded at snapshot time with a fresh resolution
 * against the current corpus. Reports every anchor that changed state.
 */
export const anchorDrift = (
  datasetRef: string,
  version: number,
  options: { db?: Db; collection?: string | null } = {}
): AnchorDriftReport => {
  const db = options.db ?? getDb()
  const dataset = requireDataset(datasetRef, db)
  const versionRow = db
    .prepare('SELECT * FROM dataset_versions WHERE dataset_id = ? AND version = ?')
    .get(dataset.id, version) as VersionRow | undefined
  if (!versionRow) {
    throw new BusinessError(
      `dataset ${dataset.name} has no version ${version}`,
      'version_not_found',
      404
    )
  }
  const mapped = mapVersionRow(versionRow)
  const cases = readVersionCases(mapped)
  const stored = parseJson<StoredAnchorStatus>(versionRow.anchor_status_json, {
    resolved: 0,
    total: 0,
    missing: [],
    anchors: [],
  })
  const resolver = createAnchorResolver({
    db,
    ...(options.collection !== undefined ? { collection: options.collection } : {}),
  })
  const currentByCase = cases.map((item) => resolver.resolveCase(item))
  const currentResolved = new Map<string, boolean>()
  for (const entry of currentByCase) {
    for (const check of entry.checks) {
      currentResolved.set(
        anchorKey(check.caseId, check.doc, check.heading, check.quote),
        check.resolved
      )
    }
  }
  const drifted: AnchorDriftEntry[] = []
  for (const anchor of stored.anchors ?? []) {
    const key = anchorKey(anchor.caseId, anchor.doc, anchor.heading, anchor.quote)
    const nowResolved = currentResolved.get(key)
    if (nowResolved === undefined) {
      continue
    }
    if (nowResolved !== anchor.resolved) {
      drifted.push({
        caseId: anchor.caseId,
        doc: anchor.doc,
        heading: anchor.heading,
        quote: anchor.quote,
        was: anchor.resolved ? 'resolved' : 'missing',
        now: nowResolved ? 'resolved' : 'missing',
        reason: nowResolved ? 'newly_resolved' : 'newly_missing',
      })
    }
  }
  let resolved = 0
  let total = 0
  const missing: string[] = []
  for (const entry of currentByCase) {
    resolved += entry.resolution.resolved
    total += entry.resolution.total
    missing.push(...entry.resolution.missing)
  }
  const current: AnchorResolution = { resolved, total, missing }
  return {
    datasetId: dataset.id,
    datasetName: dataset.name,
    version,
    stored: {
      resolved: stored.resolved ?? 0,
      total: stored.total ?? 0,
      missing: stored.missing ?? [],
    },
    current,
    corpusVersion: { stored: stored.corpusVersion ?? null, current: resolver.corpus().version },
    drifted,
    ok: !drifted.some((entry) => entry.reason === 'newly_missing'),
  }
}

/* ------------------------------ trace promotion ------------------------------ */

type TraceRow = {
  id: string
  request_json: string
  response_json: string
  profile_name: string | null
  created_at: number
}

type TraceSourceRow = {
  chunk_id: string
  document_id: string
  title: string
  heading: string | null
  page: number | null
  score: number
  snippet: string
}

const extractQuestion = (request: unknown): string | null => {
  if (!isRecord(request)) {
    return null
  }
  const messages = Array.isArray(request.messages) ? request.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message) || message.role !== 'user') {
      continue
    }
    const content = message.content
    if (typeof content === 'string' && content.trim().length > 0) {
      return content
    }
    if (Array.isArray(content)) {
      const text = content
        .map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : ''))
        .filter((value) => value.length > 0)
        .join('\n')
      if (text.trim().length > 0) {
        return text
      }
    }
  }
  if (typeof request.prompt === 'string' && request.prompt.trim().length > 0) {
    return request.prompt
  }
  return null
}

/** Promote a captured trace into a draft dataset case (evaluation seed). */
export const promoteTraceToCase = (
  traceId: string,
  datasetRef: string,
  db: Db = getDb()
): DatasetCase => {
  const dataset = requireDataset(datasetRef, db)
  const trace = db
    .prepare(
      'SELECT id, request_json, response_json, profile_name, created_at FROM traces WHERE id = ?'
    )
    .get(traceId) as TraceRow | undefined
  if (!trace) {
    throw new BusinessError(`trace not found: ${traceId}`, 'trace_not_found', 404)
  }
  const question = extractQuestion(parseJson<unknown>(trace.request_json, {}))
  if (!question) {
    throw new BusinessError('trace has no user message to promote', 'trace_without_question', 400)
  }
  const response = parseJson<{ text?: unknown }>(trace.response_json, {})
  const answer = typeof response.text === 'string' ? response.text : ''
  if (answer.trim().length === 0) {
    throw new BusinessError('trace has no assistant answer to promote', 'trace_without_answer', 400)
  }
  const sources = db
    .prepare(
      'SELECT chunk_id, document_id, title, heading, page, score, snippet FROM trace_sources WHERE trace_id = ? ORDER BY ordinal ASC'
    )
    .all(traceId) as TraceSourceRow[]
  const anchors: GoldAnchor[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    const key = `${source.title}|${source.heading ?? ''}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    const anchor: GoldAnchor = { doc: source.title }
    if (source.heading) {
      anchor.heading = source.heading
    }
    anchors.push(anchor)
  }
  const caseId = newId('case')
  const timestamp = now()
  const caseValue: DatasetCase = {
    id: caseId,
    datasetId: dataset.id,
    slices: ['promoted'],
    messages: [{ role: 'user', content: question }],
    expected: {
      answer,
      behavior: 'answer',
      mustContain: [],
      mustNotContain: [],
      anchors,
      minCitations: sources.length > 0 ? 1 : 0,
    },
    notes: `Promoted from trace ${trace.id}${trace.profile_name ? ` (${trace.profile_name})` : ''}`,
    sourceTraceId: trace.id,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const { case: storedCase, json } = caseRowData(dataset.id, caseValue)
  db.prepare(
    'INSERT INTO cases(id, dataset_id, case_key, data_json, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(newId('case'), dataset.id, storedCase.id, json, timestamp)
  return storedCase
}
