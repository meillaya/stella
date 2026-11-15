import type { Db } from '../db/index.ts'
import type { Collection, Profile, ProfileSpec, RetrievalSpec } from '../../../shared/types.ts'

/** Profile resolution for gateway RAG injection (settings.active_profile_id). */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export type ProfileRow = {
  id: string
  name: string
  version: number
  parent_id: string | null
  spec_json: string
  created_at: number
  published_at: number | null
}

const retrievalOf = (spec: Record<string, unknown>): RetrievalSpec => {
  const retrieval = isRecord(spec.retrieval) ? spec.retrieval : {}
  const rerank = retrieval.rerank === 'llm' ? 'llm' : 'off'
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
  return {
    enabled: retrieval.enabled === true,
    collection: typeof retrieval.collection === 'string' && retrieval.collection ? retrieval.collection : null,
    k: num(retrieval.k, 6),
    candidates: num(retrieval.candidates, 40),
    rerank,
    contextBudgetTokens: num(retrieval.contextBudgetTokens, 2400),
    parentExpansion: retrieval.parentExpansion !== false,
  }
}

/** Parse a profiles row defensively; returns null when the spec is unusable. */
export const profileFromRow = (row: ProfileRow): Profile | null => {
  let spec: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(row.spec_json)
    if (!isRecord(parsed)) {return null}
    spec = parsed
  } catch {
    return null
  }
  const model = isRecord(spec.model) ? spec.model : {}
  const prompt = isRecord(spec.prompt) ? spec.prompt : {}
  const judge = isRecord(spec.judge) ? spec.judge : {}
  const fullSpec: ProfileSpec = {
    model: {
      id: model.id === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash',
      thinking: model.thinking === true,
      effort:
        model.effort === 'low' || model.effort === 'high' || model.effort === 'max'
          ? model.effort
          : undefined,
      maxTokens:
        typeof model.maxTokens === 'number' && Number.isFinite(model.maxTokens) && model.maxTokens > 0
          ? Math.floor(model.maxTokens)
          : 4096,
    },
    retrieval: retrievalOf(spec),
    prompt: {
      template: prompt.template === 'rag-v1' || prompt.template === 'rag-v2' ? prompt.template : 'plain',
      citationStyle: 'bracket',
    },
    judge: {
      rubric: 'judge-v1',
      passScore:
        typeof judge.passScore === 'number' && Number.isFinite(judge.passScore) ? judge.passScore : 0.7,
      model: judge.model === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : undefined,
    },
  }
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    parentId: row.parent_id,
    spec: fullSpec,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  }
}

export const getProfile = (db: Db, id: string): Profile | null => {
  const row = db
    .prepare(
      'SELECT id, name, version, parent_id, spec_json, created_at, published_at FROM profiles WHERE id = ?'
    )
    .get(id) as ProfileRow | undefined
  return row ? profileFromRow(row) : null
}

export const activeProfileId = (db: Db): string | null => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as
    | { value: string }
    | undefined
  const value = row?.value?.trim()
  return value ? value : null
}

/** Active profile from settings, or null when unset/unreadable (retrieval off). */
export const loadActiveProfile = (db: Db): Profile | null => {
  const id = activeProfileId(db)
  if (!id) {return null}
  try {
    return getProfile(db, id)
  } catch {
    return null
  }
}

/** Collection rows are owned by RAG; read-only lookup used for trace metadata. */
export const getCollectionName = (db: Db, collectionId: string): string | null => {
  const row = db.prepare('SELECT name FROM collections WHERE id = ?').get(collectionId) as
    | { name: string }
    | undefined
  return row?.name ?? null
}

export type { Collection }
