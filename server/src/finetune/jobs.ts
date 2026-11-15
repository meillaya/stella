/**
 * Fine-tuning job adapter for external providers.
 *
 * A small HTTP adapter (submit + poll) with an injectable transport so tests run
 * against a local mock server and never touch the network. Local providers
 * (Unsloth/Axolotl) are plan-only; DeepSeek is explicitly unavailable.
 */

import { getDb, type Db } from '../db/index.ts'
import { newId, now } from '../../../shared/ids.ts'
import type { FinetuneJob, FinetuneJobStatus } from '../../../shared/types.ts'
import { BusinessError, errorMessage } from '../evals/errors.ts'
import { getFinetuneExport, readExportManifest } from './pipeline.ts'
import {
  DEEPSEEK_FINETUNE_DOCS,
  DEEPSEEK_UNAVAILABLE_MESSAGE,
  FINETUNE_PROVIDERS,
  planFinetune,
  providerApiKeyEnv,
  type FinetuneProviderId,
} from './plans.ts'

export type JobTransport = {
  fetchImpl?: typeof fetch
  /** Overrides the provider default; used by the mock-server test. */
  baseUrl?: string
  /** Overrides the provider env key. */
  apiKey?: string
}

export type JobEndpoints = {
  baseUrl: string
  submitPath: string
  statusPath: (externalId: string) => string
}

export const jobEndpoints = (provider: FinetuneProviderId, baseUrl?: string): JobEndpoints => {
  if (provider === 'together') {
    return {
      baseUrl: (baseUrl ?? 'https://api.together.xyz').replace(/\/+$/, ''),
      submitPath: '/v1/fine-tunes',
      statusPath: (externalId) => `/v1/fine-tunes/${encodeURIComponent(externalId)}`,
    }
  }
  return {
    baseUrl: (baseUrl ?? 'https://api.openai.com').replace(/\/+$/, ''),
    submitPath: '/v1/fine_tuning/jobs',
    statusPath: (externalId) => `/v1/fine_tuning/jobs/${encodeURIComponent(externalId)}`,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const fetchJson = async (
  url: string,
  init: RequestInit,
  transport: JobTransport
): Promise<unknown> => {
  const fetchImpl = transport.fetchImpl ?? fetch
  const response = await fetchImpl(url, init)
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  if (!response.ok) {
    const message =
      isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string'
        ? parsed.error.message
        : `HTTP ${response.status} from ${url}`
    throw new BusinessError(`fine-tuning provider error: ${message}`, 'provider_http_error', 502)
  }
  return parsed
}

/** Map provider-specific job states onto Stella's job statuses. */
export const mapProviderJobStatus = (raw: unknown): FinetuneJobStatus => {
  const status = typeof raw === 'string' ? raw.toLowerCase() : ''
  if (
    status === 'succeeded' ||
    status === 'success' ||
    status === 'completed' ||
    status === 'complete'
  ) {
    return 'succeeded'
  }
  if (status === 'failed' || status === 'error') {
    return 'failed'
  }
  if (status === 'cancelled' || status === 'canceled') {
    return 'cancelled'
  }
  if (status === 'running' || status === 'training' || status === 'in_progress') {
    return 'running'
  }
  if (status === 'submitted') {
    return 'submitted'
  }
  return 'queued'
}

const externalIdOf = (payload: unknown): string | null => {
  if (!isRecord(payload)) {
    return null
  }
  for (const key of ['id', 'job_id', 'fine_tune_id']) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) {
      return value
    }
  }
  if (isRecord(payload.data)) {
    return externalIdOf(payload.data)
  }
  return null
}

const statusOf = (payload: unknown): unknown => {
  if (!isRecord(payload)) {
    return null
  }
  if (typeof payload.status === 'string') {
    return payload.status
  }
  if (isRecord(payload.data)) {
    return statusOf(payload.data)
  }
  return null
}

export type SubmitJobInput = {
  provider: FinetuneProviderId
  baseModel: string
  trainingFile: string
  exportId: string
  transport?: JobTransport
}

export type SubmitJobResult = {
  externalId: string
  status: FinetuneJobStatus
  raw: unknown
  endpoint: string
}

/** Submit a fine-tune job to an external provider over HTTP. */
export const submitFinetuneJob = async (
  input: SubmitJobInput,
  transport: JobTransport = {}
): Promise<SubmitJobResult> => {
  if (input.provider === 'deepseek') {
    throw new BusinessError(
      `${DEEPSEEK_UNAVAILABLE_MESSAGE} Docs: ${DEEPSEEK_FINETUNE_DOCS}`,
      'not_offered_by_deepseek',
      400
    )
  }
  if (input.provider === 'unsloth' || input.provider === 'axolotl') {
    throw new BusinessError(
      `${input.provider} runs locally: generate a plan with \`stella finetune plan\` and execute it externally`,
      'external_provider_required',
      400
    )
  }
  const endpoint = jobEndpoints(input.provider, transport.baseUrl)
  const apiKey =
    transport.apiKey ??
    (providerApiKeyEnv(input.provider)
      ? process.env[providerApiKeyEnv(input.provider) as string]?.trim()
      : undefined)
  if (!apiKey) {
    const envKey = providerApiKeyEnv(input.provider) ?? 'PROVIDER_API_KEY'
    throw new BusinessError(`missing provider API key: set ${envKey}`, 'missing_provider_key', 400)
  }
  const payload = await fetchJson(
    `${endpoint.baseUrl}${endpoint.submitPath}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: input.baseModel,
        training_file: input.trainingFile,
        suffix: 'stella',
        metadata: { stella_export_id: input.exportId },
      }),
    },
    transport
  )
  const externalId = externalIdOf(payload)
  if (!externalId) {
    throw new BusinessError('provider did not return a job id', 'provider_protocol_error', 502)
  }
  return {
    externalId,
    status: mapProviderJobStatus(statusOf(payload)),
    raw: payload,
    endpoint: `${endpoint.baseUrl}${endpoint.submitPath}`,
  }
}

export type PollJobInput = {
  provider: FinetuneProviderId
  externalId: string
  transport?: JobTransport
}

export type PollJobResult = {
  status: FinetuneJobStatus
  raw: unknown
  error: string | null
  endpoint: string
}

/** Poll an external job once. */
export const pollFinetuneJob = async (
  input: PollJobInput,
  transport: JobTransport = {}
): Promise<PollJobResult> => {
  if (input.provider === 'deepseek') {
    throw new BusinessError(DEEPSEEK_UNAVAILABLE_MESSAGE, 'not_offered_by_deepseek', 400)
  }
  if (input.provider === 'unsloth' || input.provider === 'axolotl') {
    throw new BusinessError(
      `${input.provider} runs locally; there is no remote job to poll`,
      'external_provider_required',
      400
    )
  }
  const endpoint = jobEndpoints(input.provider, transport.baseUrl)
  const apiKey =
    transport.apiKey ??
    (providerApiKeyEnv(input.provider)
      ? process.env[providerApiKeyEnv(input.provider) as string]?.trim()
      : undefined)
  if (!apiKey) {
    throw new BusinessError(
      `missing provider API key: set ${providerApiKeyEnv(input.provider) ?? 'PROVIDER_API_KEY'}`,
      'missing_provider_key',
      400
    )
  }
  const payload = await fetchJson(
    `${endpoint.baseUrl}${endpoint.statusPath(input.externalId)}`,
    {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
    },
    transport
  )
  const status = mapProviderJobStatus(statusOf(payload))
  let error: string | null = null
  if (status === 'failed' && isRecord(payload)) {
    const raw = payload.error
    if (typeof raw === 'string') {
      error = raw
    } else if (isRecord(raw) && typeof raw.message === 'string') {
      error = raw.message
    }
  }
  return {
    status,
    raw: payload,
    error,
    endpoint: `${endpoint.baseUrl}${endpoint.statusPath(input.externalId)}`,
  }
}

/* ------------------------------ job rows ------------------------------ */

type JobRow = {
  id: string
  provider: string
  base_model: string
  export_id: string
  status: string
  external_id: string | null
  error: string | null
  created_at: number
  updated_at: number
}

export const mapFinetuneJobRow = (row: JobRow): FinetuneJob => ({
  id: row.id,
  provider: row.provider,
  baseModel: row.base_model,
  exportId: row.export_id,
  status: row.status as FinetuneJobStatus,
  externalId: row.external_id,
  error: row.error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export type CreateFinetuneJobInput = {
  exportId: string
  provider: string
  baseModel?: string
}

export type CreateFinetuneJobOptions = { db?: Db; transport?: JobTransport }

/**
 * Create + submit an external fine-tune job. DeepSeek and local providers are
 * rejected with explicit messages; submission failures are recorded on the job.
 */
export const createFinetuneJob = async (
  input: CreateFinetuneJobInput,
  options: CreateFinetuneJobOptions = {}
): Promise<FinetuneJob> => {
  const db = options.db ?? getDb()
  const provider = input.provider as FinetuneProviderId
  if (!FINETUNE_PROVIDERS.includes(provider)) {
    throw new BusinessError(
      `unknown fine-tuning provider "${input.provider}" (choose ${FINETUNE_PROVIDERS.join(', ')})`,
      'invalid_provider',
      400
    )
  }
  if (provider === 'deepseek') {
    throw new BusinessError(
      `${DEEPSEEK_UNAVAILABLE_MESSAGE} Docs: ${DEEPSEEK_FINETUNE_DOCS}`,
      'not_offered_by_deepseek',
      400
    )
  }
  if (provider === 'unsloth' || provider === 'axolotl') {
    throw new BusinessError(
      `${provider} runs locally: generate a plan with \`stella finetune plan --provider ${provider}\` and execute it externally. Stella never claims a tuned model ran.`,
      'external_provider_required',
      400
    )
  }
  const exportValue = getFinetuneExport(input.exportId, db)
  readExportManifest(exportValue, db)
  const plan = planFinetune(
    {
      exportId: exportValue.id,
      provider,
      ...(input.baseModel !== undefined ? { baseModel: input.baseModel } : {}),
    },
    { db }
  )
  const trainingFile = plan.files[0] ?? `${exportValue.path}/${exportValue.format}-train.jsonl`
  const id = newId('ftj')
  const createdAt = now()
  db.prepare(
    `INSERT INTO finetune_jobs(id, provider, base_model, export_id, status, external_id, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', NULL, NULL, ?, ?)`
  ).run(id, provider, plan.baseModel, exportValue.id, createdAt, createdAt)
  try {
    const submitted = await submitFinetuneJob(
      { provider, baseModel: plan.baseModel, trainingFile, exportId: exportValue.id },
      options.transport ?? {}
    )
    db.prepare(
      'UPDATE finetune_jobs SET status = ?, external_id = ?, updated_at = ? WHERE id = ?'
    ).run(submitted.status, submitted.externalId, now(), id)
  } catch (error) {
    db.prepare(
      "UPDATE finetune_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?"
    ).run(errorMessage(error), now(), id)
    throw error
  }
  return getFinetuneJob(id, db)
}

export const getFinetuneJob = (jobId: string, db: Db = getDb()): FinetuneJob => {
  const row = db.prepare('SELECT * FROM finetune_jobs WHERE id = ?').get(jobId) as
    | JobRow
    | undefined
  if (!row) {
    throw new BusinessError(`fine-tune job not found: ${jobId}`, 'job_not_found', 404)
  }
  return mapFinetuneJobRow(row)
}

export const listFinetuneJobs = (
  options: { limit?: number } = {},
  db: Db = getDb()
): FinetuneJob[] => {
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)))
  const rows = db
    .prepare('SELECT * FROM finetune_jobs ORDER BY created_at DESC, id ASC LIMIT ?')
    .all(limit) as JobRow[]
  return rows.map(mapFinetuneJobRow)
}

/** Poll the provider and persist the latest status. */
export const refreshFinetuneJob = async (
  jobId: string,
  options: CreateFinetuneJobOptions = {}
): Promise<FinetuneJob> => {
  const db = options.db ?? getDb()
  const job = getFinetuneJob(jobId, db)
  if (!job.externalId) {
    return job
  }
  if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
    return job
  }
  const result = await pollFinetuneJob(
    { provider: job.provider as FinetuneProviderId, externalId: job.externalId },
    options.transport ?? {}
  )
  db.prepare('UPDATE finetune_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(
    result.status,
    result.error,
    now(),
    job.id
  )
  return getFinetuneJob(job.id, db)
}
