/**
 * Eval/gate/fine-tune HTTP API (owned by the eval workstream).
 *
 * Registered by `server/src/api/router.ts` via `registerEvalsApi(app)`. Routes
 * follow docs/API.md: datasets & cases, profiles, runs, gates and fine-tuning.
 * Errors use `{ error: { message, code } }`.
 *
 * `POST /api/runs` persists a queued Run and returns it immediately (202); the
 * in-process worker executes it asynchronously.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { DatasetCase, FinetuneFormat } from '../../../shared/types.ts'
import { config } from '../config.ts'
import { getDb, type Db } from '../db/index.ts'
import {
  createDataset,
  deleteCase,
  exportDatasetVersionJsonl,
  getDataset,
  getDatasetVersion,
  importDatasetJsonl,
  latestDatasetVersion,
  listDatasets,
  listDatasetVersions,
  listDraftCases,
  readVersionCases,
  promoteTraceToCase,
  snapshotDataset,
  updateCase,
  createCase,
} from '../evals/datasets.ts'
import { BusinessError, UsageError, errorCode, errorMessage } from '../evals/errors.ts'
import { createProfile, listProfiles, publishProfile } from '../evals/profiles.ts'
import {
  cancelRun,
  compareRuns,
  createRun,
  getRun,
  getRunItems,
  listRuns,
} from '../evals/runner.ts'
import {
  createGate,
  getGate,
  getGateArtifact,
  listGates,
  type GateArtifactFormat,
} from '../evals/gates.ts'
import {
  createFinetuneJob,
  exportFinetune,
  getFinetuneExport,
  listFinetuneExports,
  listFinetuneJobs,
  preflightFinetune,
  readExportManifest,
  FINETUNE_FORMATS,
} from '../finetune/index.ts'
import type { RunMode, RunStatus } from '../../../shared/types.ts'

export type EvalsApiOptions = {
  /** In-memory DB override for tests; defaults to the process DB. */
  db?: Db
  dataDir?: string
  datasetsDir?: string
}

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const bodyOf = (request: FastifyRequest): Record<string, unknown> =>
  isRecord(request.body) ? request.body : {}

const queryOf = (request: FastifyRequest): Record<string, string | undefined> =>
  (request.query ?? {}) as Record<string, string | undefined>

const paramOf = (request: FastifyRequest, key: string): string => {
  const params = (request.params ?? {}) as Record<string, string | undefined>
  const value = params[key]
  if (!value) {
    throw new BusinessError(`missing path parameter: ${key}`, 'invalid_request', 400)
  }
  return value
}

const requiredString = (body: Record<string, unknown>, key: string): string => {
  const value = body[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BusinessError(
      `"${key}" is required and must be a non-empty string`,
      'invalid_request',
      400
    )
  }
  return value
}

const optionalNumber = (body: Record<string, unknown>, key: string): number | undefined => {
  const value = body[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BusinessError(`"${key}" must be a number`, 'invalid_request', 400)
  }
  return value
}

const sendError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof BusinessError) {
    return reply.code(error.status).send({ error: { message: error.message, code: error.code } })
  }
  if (error instanceof UsageError) {
    return reply.code(400).send({ error: { message: error.message, code: error.code } })
  }
  const code = errorCode(error)
  if (code === 'not_found') {
    return reply.code(404).send({ error: { message: errorMessage(error), code } })
  }
  return reply
    .code(500)
    .send({ error: { message: errorMessage(error), code: code ?? 'internal_error' } })
}

export const registerEvalsApi = (app: FastifyInstance, options: EvalsApiOptions = {}): void => {
  const db = options.db ?? getDb()
  const dataDir = options.dataDir ?? config.dataDir
  const datasetsDir = options.datasetsDir ?? config.datasetsDir

  const route = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    handler: Handler
  ): void => {
    const methodName = method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete'
    app[methodName](url, async (request, reply) => {
      try {
        return await handler(request, reply)
      } catch (error) {
        return sendError(reply, error)
      }
    })
  }

  /* ------------------------------ datasets ------------------------------ */

  route('GET', '/api/datasets', async () => ({ items: listDatasets(db) }))

  route('POST', '/api/datasets', async (request, reply) => {
    const body = bodyOf(request)
    const dataset = createDataset(
      {
        name: requiredString(body, 'name'),
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
      },
      db
    )
    return reply.code(201).send(dataset)
  })

  route('GET', '/api/datasets/:id', async (request) => {
    const dataset = getDataset(paramOf(request, 'id'), db)
    return {
      dataset,
      versions: listDatasetVersions(dataset.id, db),
      cases: listDraftCases(dataset.id, db),
    }
  })

  route('POST', '/api/datasets/:id/snapshot', async (request, reply) => {
    const body = bodyOf(request)
    const outcome = snapshotDataset(
      paramOf(request, 'id'),
      typeof body.notes === 'string' ? { notes: body.notes } : {},
      { db, datasetsDir }
    )
    return reply.code(201).send(outcome.version)
  })

  route('GET', '/api/datasets/:id/versions/:version', async (request) => {
    const dataset = getDataset(paramOf(request, 'id'), db)
    const versionRef = paramOf(request, 'version')
    const version = /^\d+$/.test(versionRef)
      ? (listDatasetVersions(dataset.id, db).find(
          (entry) => entry.version === Number(versionRef)
        ) ?? getDatasetVersion(versionRef, db))
      : getDatasetVersion(versionRef, db)
    return { version, cases: readVersionCases(version) }
  })

  route('POST', '/api/datasets/:id/import', async (request) => {
    const body = bodyOf(request)
    const jsonl = requiredString(body, 'jsonl')
    const result = importDatasetJsonl(paramOf(request, 'id'), jsonl, db)
    return { imported: result.imported, skipped: result.skipped, issues: result.issues }
  })

  route('GET', '/api/datasets/:id/export', async (request, reply) => {
    const dataset = getDataset(paramOf(request, 'id'), db)
    const query = queryOf(request)
    const versionRef = query.version
    const version = versionRef
      ? /^\d+$/.test(versionRef)
        ? (listDatasetVersions(dataset.id, db).find(
            (entry) => entry.version === Number(versionRef)
          ) ??
          (() => {
            throw new BusinessError(
              `dataset ${dataset.name} has no version ${versionRef}`,
              'version_not_found',
              404
            )
          })())
        : getDatasetVersion(versionRef, db)
      : latestDatasetVersion(dataset.id, db)
    const jsonl = exportDatasetVersionJsonl(version.id, db)
    return reply.type('text/plain; charset=utf-8').send(jsonl)
  })

  /* ------------------------------ cases ------------------------------ */

  route('POST', '/api/cases', async (request, reply) => {
    const created = createCase(bodyOf(request) as unknown as DatasetCase, db)
    return reply.code(201).send(created)
  })

  route('PATCH', '/api/cases/:id', async (request) => {
    const updated = updateCase(
      paramOf(request, 'id'),
      bodyOf(request) as unknown as Partial<DatasetCase>,
      db
    )
    return updated
  })

  route('DELETE', '/api/cases/:id', async (request) => {
    const deleted = deleteCase(paramOf(request, 'id'), db)
    if (!deleted) {
      throw new BusinessError(`case not found: ${paramOf(request, 'id')}`, 'case_not_found', 404)
    }
    return { ok: true }
  })

  /* ------------------------------ trace promote ------------------------------ */

  route('POST', '/api/traces/:id/promote', async (request, reply) => {
    const body = bodyOf(request)
    const datasetId = requiredString(body, 'datasetId')
    const created = promoteTraceToCase(paramOf(request, 'id'), datasetId, db)
    return reply.code(201).send(created)
  })

  /* ------------------------------ profiles ------------------------------ */

  route('GET', '/api/profiles', async () => ({ items: listProfiles(db) }))

  route('POST', '/api/profiles', async (request, reply) => {
    const body = bodyOf(request)
    const created = createProfile(
      {
        name: requiredString(body, 'name'),
        ...(body.spec !== undefined ? { spec: body.spec } : {}),
        ...(typeof body.parentId === 'string' ? { parentId: body.parentId } : {}),
      },
      db
    )
    return reply.code(201).send(created)
  })

  route('POST', '/api/profiles/:id/publish', async (request) =>
    publishProfile(paramOf(request, 'id'), { db })
  )

  /* ------------------------------ runs ------------------------------ */

  route('GET', '/api/runs', async (request) => {
    const query = queryOf(request)
    const limit =
      query.limit !== undefined && /^\d+$/.test(query.limit) ? Number(query.limit) : undefined
    return {
      items: listRuns(
        {
          ...(limit !== undefined ? { limit } : {}),
          ...(query.datasetId ? { datasetId: query.datasetId } : {}),
          ...(query.status ? { status: query.status as RunStatus } : {}),
          ...(query.mode ? { mode: query.mode as RunMode } : {}),
        },
        db
      ),
    }
  })

  route('POST', '/api/runs', async (request, reply) => {
    const body = bodyOf(request)
    const run = createRun(
      {
        datasetVersionId: requiredString(body, 'datasetVersionId'),
        profileId: requiredString(body, 'profileId'),
        ...(optionalNumber(body, 'budgetUsd') !== undefined
          ? { budgetUsd: optionalNumber(body, 'budgetUsd') }
          : {}),
        ...(body.offPeak === true ? { offPeak: true } : {}),
        ...(body.mode === 'replay' || body.mode === 'live' ? { mode: body.mode } : {}),
        ...(isRecord(body.config) ? { config: body.config } : {}),
      },
      { db }
    )
    return reply.code(202).send(run)
  })

  route('GET', '/api/runs/compare', async (request) => {
    const query = queryOf(request)
    const baseline = query.baseline
    const candidate = query.candidate
    if (!baseline || !candidate) {
      throw new BusinessError(
        'baseline and candidate query parameters are required',
        'invalid_request',
        400
      )
    }
    return compareRuns(baseline, candidate, { db })
  })

  route('GET', '/api/runs/:id', async (request) => getRun(paramOf(request, 'id'), db))

  route('GET', '/api/runs/:id/items', async (request) => ({
    items: getRunItems(paramOf(request, 'id'), db),
  }))

  route('POST', '/api/runs/:id/cancel', async (request) =>
    cancelRun(paramOf(request, 'id'), { db })
  )

  /* ------------------------------ gates ------------------------------ */

  route('POST', '/api/gates', async (request, reply) => {
    const body = bodyOf(request)
    const result = createGate(
      {
        baselineRunId: requiredString(body, 'baselineRunId'),
        candidateRunId: requiredString(body, 'candidateRunId'),
        ...(body.config !== undefined ? { config: body.config } : {}),
        ...(isRecord(body.override)
          ? {
              override: {
                ...(typeof body.override.reason === 'string'
                  ? { reason: body.override.reason }
                  : {}),
                ...(typeof body.override.by === 'string' ? { by: body.override.by } : {}),
              },
            }
          : {}),
        dataDir,
      },
      { db }
    )
    return reply.code(201).send({
      id: result.id,
      baselineRunId: result.baselineRunId,
      candidateRunId: result.candidateRunId,
      config: result.config,
      result: result.result,
      createdAt: result.createdAt,
      artifacts: result.artifacts,
    })
  })

  route('GET', '/api/gates', async (request) => {
    const query = queryOf(request)
    const limit =
      query.limit !== undefined && /^\d+$/.test(query.limit) ? Number(query.limit) : undefined
    return { items: listGates({ ...(limit !== undefined ? { limit } : {}) }, db) }
  })

  route('GET', '/api/gates/:id', async (request) => getGate(paramOf(request, 'id'), db))

  route('GET', '/api/gates/:id/artifact', async (request, reply) => {
    const query = queryOf(request)
    const format: GateArtifactFormat =
      query.format === 'json' || query.format === 'html' || query.format === 'md'
        ? query.format
        : 'md'
    const artifact = getGateArtifact(paramOf(request, 'id'), format, { db, dataDir })
    return reply.type(artifact.contentType).send(artifact.body)
  })

  /* ------------------------------ fine-tuning ------------------------------ */

  const finetuneFormat = (body: Record<string, unknown>): FinetuneFormat => {
    const format = body.format
    if (typeof format !== 'string' || !FINETUNE_FORMATS.includes(format as FinetuneFormat)) {
      throw new BusinessError(
        `format must be one of ${FINETUNE_FORMATS.join(', ')}`,
        'invalid_finetune_format',
        400
      )
    }
    return format as FinetuneFormat
  }

  route('POST', '/api/finetune/preflight', async (request) => {
    const body = bodyOf(request)
    return preflightFinetune(
      {
        datasetVersionId: requiredString(body, 'datasetVersionId'),
        format: finetuneFormat(body),
        ...(body.filters !== undefined ? { filters: body.filters } : {}),
      },
      { db }
    )
  })

  route('POST', '/api/finetune/exports', async (request, reply) => {
    const body = bodyOf(request)
    const result = exportFinetune(
      {
        datasetVersionId: requiredString(body, 'datasetVersionId'),
        format: finetuneFormat(body),
        ...(body.filters !== undefined ? { filters: body.filters } : {}),
      },
      { db, dataDir }
    )
    return reply.code(201).send(result.export)
  })

  route('GET', '/api/finetune/exports', async (request) => {
    const query = queryOf(request)
    const limit =
      query.limit !== undefined && /^\d+$/.test(query.limit) ? Number(query.limit) : undefined
    return { items: listFinetuneExports({ ...(limit !== undefined ? { limit } : {}) }, db) }
  })

  route('GET', '/api/finetune/exports/:id', async (request) => {
    const exportValue = getFinetuneExport(paramOf(request, 'id'), db)
    return { export: exportValue, manifest: readExportManifest(exportValue, db) }
  })

  route('POST', '/api/finetune/jobs', async (request, reply) => {
    const body = bodyOf(request)
    const job = await createFinetuneJob(
      {
        exportId: requiredString(body, 'exportId'),
        provider: requiredString(body, 'provider'),
        ...(typeof body.baseModel === 'string' ? { baseModel: body.baseModel } : {}),
      },
      { db }
    )
    return reply.code(201).send(job)
  })

  route('GET', '/api/finetune/jobs', async (request) => {
    const query = queryOf(request)
    const limit =
      query.limit !== undefined && /^\d+$/.test(query.limit) ? Number(query.limit) : undefined
    return { items: listFinetuneJobs({ ...(limit !== undefined ? { limit } : {}) }, db) }
  })
}
