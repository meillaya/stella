import type { FastifyInstance } from 'fastify'
import { asModelId } from '../../../shared/pricing.ts'
import type { Gate, GateConfig, GateResult, Overview, Profile, Run, RunStatus, RunSummary, StellaSettings, TraceSummary } from '../../../shared/types.ts'
import { config, keyStatus } from '../config.ts'
import { deleteSetting, getDb, getSetting, parseJson, setSetting } from '../db/index.ts'

type RunRow = {
  id: string
  dataset_id: string
  dataset_version_id: string
  profile_id: string
  provider: string
  mode: string
  status: string
  budget_usd: number
  config_json: string
  summary_json: string | null
  error: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
  dataset_name?: string
  dataset_version?: number
  profile_name?: string
}

type TraceRow = {
  id: string
  session_key: string
  created_at: number
  status: string
  model: string
  profile_name: string | null
  retrieval_enabled: number
  latency_ms: number
  cost_usd: number
  feedback: string | null
  request_json: string
  response_json: string
}

const runSelect = `
  SELECT r.*, d.name AS dataset_name, dv.version AS dataset_version, p.name AS profile_name
  FROM runs r
  JOIN datasets d ON d.id = r.dataset_id
  JOIN dataset_versions dv ON dv.id = r.dataset_version_id
  JOIN profiles p ON p.id = r.profile_id
`

const rowToRun = (row: RunRow): Run => ({
  id: row.id,
  datasetId: row.dataset_id,
  datasetName: row.dataset_name ?? 'dataset',
  datasetVersion: row.dataset_version ?? 0,
  profileId: row.profile_id,
  profileName: row.profile_name ?? 'profile',
  provider: (row.provider as Run['provider']) ?? 'replay',
  mode: (row.mode as Run['mode']) ?? 'replay',
  status: (row.status as RunStatus) ?? 'queued',
  budgetUsd: row.budget_usd,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  summary: parseJson<RunSummary | null>(row.summary_json, null),
  error: row.error,
})

const latestRun = (status?: string): Run | null => {
  const db = getDb()
  const row = status
    ? (db.prepare(`${runSelect} WHERE r.status = ? ORDER BY r.created_at DESC LIMIT 1`).get(status) as RunRow | undefined)
    : (db.prepare(`${runSelect} ORDER BY r.created_at DESC LIMIT 1`).get() as RunRow | undefined)
  return row ? rowToRun(row) : null
}

const previousCompleted = (excludeId: string): Run | null => {
  const row = getDb()
    .prepare(`${runSelect} WHERE r.status = 'done' AND r.id != ? ORDER BY r.created_at DESC LIMIT 1`)
    .get(excludeId) as RunRow | undefined
  return row ? rowToRun(row) : null
}

const rowToTraceSummary = (row: TraceRow): TraceSummary => {
  const request = parseJson<{ messages?: { role?: string; content?: unknown }[] }>(row.request_json, {})
  const response = parseJson<{ text?: string }>(row.response_json, {})
  const question = (request.messages ?? [])
    .filter((message) => message.role === 'user')
    .map((message) => messageText(message.content))
    .at(-1) ?? ''
  const sources = getDb()
    .prepare('SELECT COUNT(*) AS n FROM trace_sources WHERE trace_id = ?')
    .get(row.id) as { n: number }
  return {
    id: row.id,
    sessionKey: row.session_key,
    createdAt: row.created_at,
    status: (row.status as TraceSummary['status']) ?? 'ok',
    model: row.model,
    profileName: row.profile_name,
    retrievalEnabled: Boolean(row.retrieval_enabled),
    latencyMs: row.latency_ms,
    costUsd: row.cost_usd,
    feedback: row.feedback === 'up' || row.feedback === 'down' ? row.feedback : null,
    question: question || '(no question recorded)',
    answerPreview: (response.text ?? '').slice(0, 180),
    sourceCount: sources.n,
  }
}

const messageText = (content: unknown): string => {
  if (typeof content === 'string') {return content}
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {return block.text}
        return ''
      })
      .join(' ')
  }
  return ''
}

export const activeProfile = (): Profile | null => {
  const id = getSetting('active_profile_id')
  if (!id) {return null}
  const row = getDb().prepare('SELECT * FROM profiles WHERE id = ?').get(id) as
    | { id: string; name: string; version: number; parent_id: string | null; spec_json: string; created_at: number; published_at: number | null }
    | undefined
  if (!row) {return null}
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    parentId: row.parent_id,
    spec: JSON.parse(row.spec_json) as Profile['spec'],
    createdAt: row.created_at,
    publishedAt: row.published_at,
  }
}

export const readSettings = (): StellaSettings => ({
  activeProfileId: getSetting('active_profile_id') || null,
  traceRetentionDays: Number(getSetting('trace_retention_days') ?? config.traceRetentionDays),
  defaultModel: asModelId(getSetting('default_model') ?? 'deepseek-flash'),
})

const latestGate = (): Gate | null => {
  const row = getDb().prepare('SELECT * FROM gates ORDER BY created_at DESC LIMIT 1').get() as
    | {
        id: string
        baseline_run_id: string
        candidate_run_id: string
        config_json: string
        result_json: string
        created_at: number
      }
    | undefined
  if (!row) {return null}
  return {
    id: row.id,
    baselineRunId: row.baseline_run_id,
    candidateRunId: row.candidate_run_id,
    config: parseJson<GateConfig>(row.config_json, {} as GateConfig),
    result: parseJson<GateResult>(row.result_json, {} as GateResult),
    createdAt: row.created_at,
  }
}

const overview = (): Overview => {
  const db = getDb()
  const latest = latestRun()
  const previous = latest ? previousCompleted(latest.id) : null
  const summary = latest?.summary ?? null
  const previousSummary = previous?.summary ?? null
  const trendRows = db
    .prepare(
      `${runSelect} WHERE r.status = 'done' AND r.summary_json IS NOT NULL ORDER BY r.created_at DESC LIMIT 10`
    )
    .all() as RunRow[]
  const trend = trendRows
    .map((row) => {
      const run = rowToRun(row)
      return {
        runId: run.id,
        createdAt: run.createdAt,
        passRate: run.summary?.passRate ?? 0,
        costPerPassUsd: run.summary?.costPerPassUsd ?? 0,
      }
    })
    .reverse()

  const failingRows = latest
    ? (db
        .prepare(
          `SELECT ri.case_id, ri.answer, ri.grader_results_json, c.data_json
           FROM run_items ri
           LEFT JOIN cases c ON c.id = ri.case_id OR c.case_key = ri.case_id
           WHERE ri.run_id = ? AND ri.pass = 0
           LIMIT 5`
        )
        .all(latest.id) as { case_id: string; answer: string; grader_results_json: string; data_json: string | null }[])
    : []
  const failingCases = failingRows.map((row) => {
    const caseData = parseJson<{ slices?: string[] }>(row.data_json, {})
    const graders = parseJson<{ kind: string; pass: boolean }[]>(row.grader_results_json, [])
    return {
      caseId: row.case_id,
      answer: row.answer.slice(0, 240),
      slices: caseData.slices ?? [],
      failedGraders: graders.filter((grader) => !grader.pass).map((grader) => grader.kind),
    }
  })

  const traces24h = db
    .prepare('SELECT COUNT(*) AS n FROM traces WHERE created_at > ?')
    .get(Date.now() - 24 * 60 * 60 * 1000) as { n: number }
  const negative24h = db
    .prepare("SELECT COUNT(*) AS n FROM traces WHERE created_at > ? AND feedback = 'down'")
    .get(Date.now() - 24 * 60 * 60 * 1000) as { n: number }

  const reviewRows = db
    .prepare("SELECT * FROM traces WHERE feedback = 'down' ORDER BY created_at DESC LIMIT 5")
    .all() as TraceRow[]

  const dataset = db
    .prepare(
      `SELECT d.id, d.name, dv.version, dv.case_count
       FROM datasets d JOIN dataset_versions dv ON dv.dataset_id = d.id
       ORDER BY dv.version DESC LIMIT 1`
    )
    .get() as { id: string; name: string; version: number; case_count: number } | undefined

  const delta = (current: number | null | undefined, prior: number | null | undefined): number | null =>
    current == null || prior == null ? null : current - prior
  const pct = (current: number | null | undefined, prior: number | null | undefined): number | null =>
    current == null || prior == null || prior === 0 ? null : ((current - prior) / prior) * 100

  return {
    hasKey: keyStatus().configured,
    activeProfile: activeProfile(),
    dataset: dataset
      ? { id: dataset.id, name: dataset.name, version: dataset.version, cases: dataset.case_count }
      : null,
    latestRun: latest,
    baselineRun: previous,
    gate: latestGate(),
    metrics: {
      passRate: summary?.passRate ?? null,
      passRateDeltaPp:
        delta(summary?.passRate, previousSummary?.passRate) === null
          ? null
          : (delta(summary?.passRate, previousSummary?.passRate) as number) * 100,
      costPerPassUsd: summary?.costPerPassUsd ?? null,
      costDeltaPct: pct(summary?.costPerPassUsd, previousSummary?.costPerPassUsd),
      p95LatencyMs: summary?.p95LatencyMs ?? null,
      latencyDeltaPct: pct(summary?.p95LatencyMs, previousSummary?.p95LatencyMs),
      cases: summary?.cases ?? 0,
      traces24h: traces24h.n,
      negativeFeedback24h: negative24h.n,
    },
    trend,
    failingCases,
    reviewQueue: reviewRows.map(rowToTraceSummary),
  }
}

export const registerCoreApi = (app: FastifyInstance): void => {
  app.get('/api/settings', async () => readSettings())

  app.patch('/api/settings', async (request, reply) => {
    const body = (request.body ?? {}) as {
      activeProfileId?: string | null
      traceRetentionDays?: number
      defaultModel?: string
    }
    if (body.activeProfileId !== undefined) {
      if (body.activeProfileId !== null) {
        const exists = getDb().prepare('SELECT id FROM profiles WHERE id = ?').get(body.activeProfileId)
        if (!exists) {return reply.code(400).send({ error: { message: 'Unknown profile' } })}
      }
      if (body.activeProfileId === null) {deleteSetting('active_profile_id')}
      else {setSetting('active_profile_id', body.activeProfileId)}
    }
    if (body.traceRetentionDays !== undefined) {
      if (!Number.isFinite(body.traceRetentionDays) || body.traceRetentionDays < 1 || body.traceRetentionDays > 365) {
        return reply.code(400).send({ error: { message: 'traceRetentionDays must be between 1 and 365' } })
      }
      setSetting('trace_retention_days', String(Math.floor(body.traceRetentionDays)))
    }
    if (body.defaultModel !== undefined) {setSetting('default_model', asModelId(body.defaultModel))}
    return readSettings()
  })

  app.get('/api/overview', async () => overview())
}
