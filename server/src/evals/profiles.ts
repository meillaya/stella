/**
 * Eval profiles: immutable, versioned specs (model, retrieval, prompt, judge).
 * A profile version is never mutated; editing creates a new version. Publishing
 * a version sets `settings.active_profile_id`, which the gateway reads for chat.
 */

import { getDb, type Db } from '../db/index.ts'
import { DEFAULT_MODEL, asModelId } from '../../../shared/pricing.ts'
import type {
  JudgeSpec,
  ModelId,
  ModelSpec,
  Profile,
  ProfileSpec,
  PromptSpec,
  RetrievalSpec,
} from '../../../shared/types.ts'
import { newId, now } from '../../../shared/ids.ts'
import { BusinessError } from './errors.ts'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const ACTIVE_PROFILE_KEY = 'active_profile_id'

/** Settings helpers that honor an explicit DB (API tests, CLI sandboxes). */
const readSetting = (db: Db, key: string): string | null => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

const writeSetting = (db: Db, key: string, value: string): void => {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

export const DEFAULT_PROFILE_SPEC: ProfileSpec = {
  model: { id: DEFAULT_MODEL, thinking: false, maxTokens: 2048 },
  retrieval: {
    enabled: true,
    collection: 'meridian',
    k: 6,
    candidates: 24,
    rerank: 'off',
    contextBudgetTokens: 2600,
    parentExpansion: true,
  },
  prompt: { template: 'rag-v2', citationStyle: 'bracket' },
  judge: { rubric: 'judge-v1', passScore: 2, model: DEFAULT_MODEL },
}

const integer = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  field: string,
  issues: string[]
): number => {
  if (value === undefined || value === null) {
    return fallback
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    issues.push(`${field} must be an integer`)
    return fallback
  }
  if (value < min || value > max) {
    issues.push(`${field} must be between ${min} and ${max}`)
    return fallback
  }
  return value
}

const boolean = (value: unknown, fallback: boolean, field: string, issues: string[]): boolean => {
  if (value === undefined || value === null) {
    return fallback
  }
  if (typeof value !== 'boolean') {
    issues.push(`${field} must be a boolean`)
    return fallback
  }
  return value
}

const normalizeModelSpec = (input: unknown, issues: string[]): ModelSpec => {
  const record = isRecord(input) ? input : {}
  if (input !== undefined && !isRecord(input)) {
    issues.push('model must be an object')
  }
  const model: ModelSpec = {
    id: asModelId(record.id),
    thinking: boolean(record.thinking, false, 'model.thinking', issues),
    maxTokens: integer(record.maxTokens, 2048, 64, 384_000, 'model.maxTokens', issues),
  }
  if (record.effort !== undefined && record.effort !== null) {
    if (record.effort === 'low' || record.effort === 'high' || record.effort === 'max') {
      model.effort = record.effort
    } else {
      issues.push('model.effort must be one of "low", "high", "max"')
    }
  }
  return model
}

const normalizeRetrievalSpec = (input: unknown, issues: string[]): RetrievalSpec => {
  const record = isRecord(input) ? input : {}
  if (input !== undefined && !isRecord(input)) {
    issues.push('retrieval must be an object')
  }
  const spec: RetrievalSpec = {
    enabled: boolean(record.enabled, true, 'retrieval.enabled', issues),
    collection:
      record.collection === null || record.collection === undefined
        ? null
        : typeof record.collection === 'string' && record.collection.trim().length > 0
          ? record.collection.trim()
          : null,
    k: integer(record.k, 6, 1, 100, 'retrieval.k', issues),
    candidates: integer(record.candidates, 40, 1, 1000, 'retrieval.candidates', issues),
    rerank: record.rerank === 'llm' ? 'llm' : 'off',
    contextBudgetTokens: integer(
      record.contextBudgetTokens,
      2400,
      0,
      500_000,
      'retrieval.contextBudgetTokens',
      issues
    ),
    parentExpansion: boolean(record.parentExpansion, true, 'retrieval.parentExpansion', issues),
  }
  if (record.rerank !== undefined && record.rerank !== 'off' && record.rerank !== 'llm') {
    issues.push('retrieval.rerank must be "off" or "llm"')
  }
  if (
    record.collection !== undefined &&
    record.collection !== null &&
    typeof record.collection !== 'string'
  ) {
    issues.push('retrieval.collection must be a string or null')
  }
  if (spec.candidates < spec.k) {
    spec.candidates = spec.k
  }
  return spec
}

const normalizePromptSpec = (input: unknown, issues: string[]): PromptSpec => {
  const record = isRecord(input) ? input : {}
  if (input !== undefined && !isRecord(input)) {
    issues.push('prompt must be an object')
  }
  const template =
    record.template === 'plain' || record.template === 'rag-v1' || record.template === 'rag-v2'
      ? record.template
      : (() => {
          if (record.template !== undefined) {
            issues.push('prompt.template must be "plain", "rag-v1" or "rag-v2"')
          }
          return 'rag-v2' as const
        })()
  if (record.citationStyle !== undefined && record.citationStyle !== 'bracket') {
    issues.push('prompt.citationStyle must be "bracket"')
  }
  return { template, citationStyle: 'bracket' }
}

const normalizeJudgeSpec = (input: unknown, issues: string[]): JudgeSpec => {
  const record = isRecord(input) ? input : {}
  if (input !== undefined && !isRecord(input)) {
    issues.push('judge must be an object')
  }
  if (record.rubric !== undefined && record.rubric !== 'judge-v1') {
    issues.push('judge.rubric must be "judge-v1"')
  }
  const judge: JudgeSpec = {
    rubric: 'judge-v1',
    passScore: integer(record.passScore, 2, 0, 3, 'judge.passScore', issues),
  }
  if (record.model !== undefined) {
    judge.model = asModelId(record.model)
  }
  return judge
}

/** Validate and fill defaults for a ProfileSpec. Throws BusinessError on invalid input. */
export const normalizeProfileSpec = (input: unknown): ProfileSpec => {
  if (!isRecord(input)) {
    throw new BusinessError('profile spec must be an object', 'invalid_profile_spec', 400)
  }
  const issues: string[] = []
  const spec: ProfileSpec = {
    model: normalizeModelSpec(input.model, issues),
    retrieval: normalizeRetrievalSpec(input.retrieval, issues),
    prompt: normalizePromptSpec(input.prompt, issues),
    judge: normalizeJudgeSpec(input.judge, issues),
  }
  if (issues.length > 0) {
    throw new BusinessError(
      `invalid profile spec: ${issues.join('; ')}`,
      'invalid_profile_spec',
      400
    )
  }
  return spec
}

/* ------------------------------ row mapping ------------------------------ */

type ProfileRow = {
  id: string
  name: string
  version: number
  parent_id: string | null
  spec_json: string
  created_at: number
  published_at: number | null
}

const readSpec = (row: ProfileRow): ProfileSpec => {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.spec_json)
  } catch {
    throw new BusinessError(`profile ${row.id} has a corrupt spec`, 'corrupt_profile', 500)
  }
  return normalizeProfileSpec(parsed)
}

export const mapProfileRow = (row: ProfileRow): Profile => ({
  id: row.id,
  name: row.name,
  version: row.version,
  parentId: row.parent_id,
  spec: readSpec(row),
  createdAt: row.created_at,
  publishedAt: row.published_at,
})

/* ------------------------------ CRUD ------------------------------ */

export const listProfiles = (db: Db = getDb()): Profile[] => {
  const rows = db
    .prepare('SELECT * FROM profiles ORDER BY created_at ASC, version ASC')
    .all() as ProfileRow[]
  return rows.map(mapProfileRow)
}

export const getProfile = (profileId: string, db: Db = getDb()): Profile => {
  const row = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId) as
    | ProfileRow
    | undefined
  if (!row) {
    throw new BusinessError(`profile not found: ${profileId}`, 'profile_not_found', 404)
  }
  return mapProfileRow(row)
}

export const findProfileByName = (name: string, db: Db = getDb()): Profile | null => {
  const row = db
    .prepare('SELECT * FROM profiles WHERE name = ? ORDER BY version DESC LIMIT 1')
    .get(name) as ProfileRow | undefined
  return row ? mapProfileRow(row) : null
}

export const getProfileByName = (name: string, db: Db = getDb()): Profile => {
  const profile = findProfileByName(name, db)
  if (!profile) {
    throw new BusinessError(`profile not found: ${name}`, 'profile_not_found', 404)
  }
  return profile
}

export const getProfileByNameAndVersion = (
  name: string,
  version: number,
  db: Db = getDb()
): Profile => {
  const row = db
    .prepare('SELECT * FROM profiles WHERE name = ? AND version = ?')
    .get(name, version) as ProfileRow | undefined
  if (!row) {
    throw new BusinessError(`profile not found: ${name} v${version}`, 'profile_not_found', 404)
  }
  return mapProfileRow(row)
}

export type CreateProfileInput = { name: string; spec?: unknown; parentId?: string | null }

export const createProfile = (input: CreateProfileInput, db: Db = getDb()): Profile => {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name.length === 0) {
    throw new BusinessError('profile name is required', 'invalid_profile_name', 400)
  }
  if (name.length > 120) {
    throw new BusinessError(
      'profile name must be at most 120 characters',
      'invalid_profile_name',
      400
    )
  }
  let parent: Profile | null = null
  if (input.parentId) {
    parent = getProfile(input.parentId, db)
  }
  const specSource = input.spec ?? parent?.spec
  if (specSource === undefined) {
    throw new BusinessError(
      'profile spec is required (or provide parentId to inherit)',
      'invalid_profile_spec',
      400
    )
  }
  const spec = normalizeProfileSpec(specSource)
  const versionRow = db
    .prepare('SELECT MAX(version) AS version FROM profiles WHERE name = ?')
    .get(name) as { version: number | null }
  const version = (versionRow.version ?? 0) + 1
  const id = newId('prof')
  const createdAt = now()
  db.prepare(
    'INSERT INTO profiles(id, name, version, parent_id, spec_json, created_at, published_at) VALUES (?, ?, ?, ?, ?, ?, NULL)'
  ).run(id, name, version, parent?.id ?? input.parentId ?? null, JSON.stringify(spec), createdAt)
  return getProfile(id, db)
}

/** Publish a profile version. Publishing touches `settings.active_profile_id` unless `activate:false`. */
export const publishProfile = (
  profileId: string,
  options: { db?: Db; activate?: boolean } = {}
): Profile => {
  const db = options.db ?? getDb()
  const profile = getProfile(profileId, db)
  const publishedAt = profile.publishedAt ?? now()
  db.prepare('UPDATE profiles SET published_at = ? WHERE id = ?').run(publishedAt, profile.id)
  if (options.activate !== false) {
    writeSetting(db, ACTIVE_PROFILE_KEY, profile.id)
  }
  return getProfile(profile.id, db)
}

export const getActiveProfile = (db: Db = getDb()): Profile | null => {
  const profileId = readSetting(db, ACTIVE_PROFILE_KEY)
  if (!profileId) {
    return null
  }
  const row = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId) as
    | ProfileRow
    | undefined
  return row ? mapProfileRow(row) : null
}

/* ------------------------------ demo seeds ------------------------------ */

export const DEMO_PROFILE_NAMES = {
  baseline: 'Support baseline',
  improved: 'Support grounded',
} as const

const baselineSpec = (collection: string): ProfileSpec => ({
  model: { id: 'deepseek-flash', thinking: false, maxTokens: 1200 },
  retrieval: {
    enabled: true,
    collection,
    k: 3,
    candidates: 20,
    rerank: 'off',
    contextBudgetTokens: 2400,
    parentExpansion: true,
  },
  prompt: { template: 'rag-v1', citationStyle: 'bracket' },
  judge: { rubric: 'judge-v1', passScore: 2, model: 'deepseek-flash' },
})

const improvedSpec = (collection: string): ProfileSpec => ({
  model: { id: 'deepseek-flash', thinking: false, maxTokens: 1600 },
  retrieval: {
    enabled: true,
    collection,
    k: 8,
    candidates: 60,
    rerank: 'llm',
    contextBudgetTokens: 6000,
    parentExpansion: true,
  },
  prompt: { template: 'rag-v2', citationStyle: 'bracket' },
  judge: { rubric: 'judge-v1', passScore: 2, model: 'deepseek-flash' },
})

export type SeedProfilesResult = {
  baseline: Profile
  improved: Profile
  created: string[]
  activeProfileId: string | null
}

/**
 * Seed the two demo profiles: "Support baseline" (k=3, rerank off, rag-v1) and
 * "Support grounded" (k=8, rerank on, rag-v2 with citation instruction).
 * Idempotent: existing profile names are reused. Only sets the active profile
 * when none is configured, and then to the baseline.
 */
export const seedProfiles = (
  options: { db?: Db; collection?: string; activate?: boolean } = {}
): SeedProfilesResult => {
  const db = options.db ?? getDb()
  const collection = options.collection ?? 'meridian'
  const created: string[] = []
  const ensure = (name: string, spec: ProfileSpec): Profile => {
    const existing = findProfileByName(name, db)
    if (existing) {
      return existing
    }
    created.push(name)
    return createProfile({ name, spec }, db)
  }
  let baseline = ensure(DEMO_PROFILE_NAMES.baseline, baselineSpec(collection))
  let improved = ensure(DEMO_PROFILE_NAMES.improved, improvedSpec(collection))
  const publishTs = now()
  for (const profile of [baseline, improved]) {
    if (profile.publishedAt === null) {
      db.prepare('UPDATE profiles SET published_at = ? WHERE id = ?').run(publishTs, profile.id)
    }
  }
  baseline = getProfile(baseline.id, db)
  improved = getProfile(improved.id, db)
  const active = getActiveProfile(db)
  if (!active || options.activate !== false) {
    writeSetting(db, ACTIVE_PROFILE_KEY, baseline.id)
  }
  return {
    baseline,
    improved,
    created,
    activeProfileId: getActiveProfile(db)?.id ?? null,
  }
}

export const profileModelId = (spec: ProfileSpec): ModelId => spec.model.id

export type { JudgeSpec, ModelSpec, PromptSpec, RetrievalSpec }
