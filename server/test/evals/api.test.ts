import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerEvalsApi } from '../../src/api/evals.ts'
import { setupEvalFixture, type EvalFixture } from './helpers.ts'

const setup = async (): Promise<{ app: FastifyInstance; fixture: EvalFixture }> => {
  const fixture = await setupEvalFixture()
  const app = Fastify({ logger: false })
  registerEvalsApi(app, {
    db: fixture.db,
    dataDir: fixture.dataDir,
    datasetsDir: fixture.datasetsDir,
  })
  await app.ready()
  return { app, fixture }
}

const json = <T>(response: { body: string }): T => JSON.parse(response.body) as T

test('datasets API: list, create, detail, versions, import and export', async () => {
  const { app, fixture } = await setup()
  try {
    const list = await app.inject({ method: 'GET', url: '/api/datasets' })
    assert.equal(list.statusCode, 200)
    const items = json<{ items: { id: string; name: string }[] }>(list)
    assert.equal(items.items.length, 1)
    assert.equal(items.items[0]?.name, 'support')

    const created = await app.inject({
      method: 'POST',
      url: '/api/datasets',
      payload: { name: 'extra', description: 'x' },
    })
    assert.equal(created.statusCode, 201)
    const dataset = json<{ id: string; name: string; caseCount: number }>(created)
    assert.equal(dataset.name, 'extra')
    assert.equal(dataset.caseCount, 0)

    const detail = await app.inject({ method: 'GET', url: `/api/datasets/${dataset.id}` })
    const detailBody = json<{ dataset: { name: string }; versions: unknown[]; cases: unknown[] }>(
      detail
    )
    assert.equal(detailBody.dataset.name, 'extra')
    assert.deepEqual(detailBody.versions, [])
    assert.deepEqual(detailBody.cases, [])

    const importBody = {
      jsonl: JSON.stringify({
        id: 'case_api_1',
        slices: ['direct'],
        messages: [{ role: 'user', content: 'How long do refunds take?' }],
        expected: {
          answer: 'Within 14 days.',
          behavior: 'answer',
          mustContain: ['14 days'],
          mustNotContain: [],
          anchors: [{ doc: 'corpus/meridian/policies/refunds.md', heading: 'Refund timing' }],
          minCitations: 1,
        },
      }),
    }
    const imported = await app.inject({
      method: 'POST',
      url: `/api/datasets/${dataset.id}/import`,
      payload: importBody,
    })
    assert.equal(imported.statusCode, 200)
    assert.deepEqual(json<{ imported: number; skipped: number }>(imported), {
      imported: 1,
      skipped: 0,
      issues: [],
    })

    const snapshot = await app.inject({
      method: 'POST',
      url: `/api/datasets/${dataset.id}/snapshot`,
      payload: { notes: 'api' },
    })
    assert.equal(snapshot.statusCode, 201)
    const version = json<{
      version: number
      caseCount: number
      anchorStatus: { resolved: number }
    }>(snapshot)
    assert.equal(version.version, 1)
    assert.equal(version.caseCount, 1)
    assert.equal(version.anchorStatus.resolved, 1)

    const versionDetail = await app.inject({
      method: 'GET',
      url: `/api/datasets/${dataset.id}/versions/1`,
    })
    assert.equal(versionDetail.statusCode, 200)
    const versionBody = json<{ version: { version: number }; cases: { id: string }[] }>(
      versionDetail
    )
    assert.equal(versionBody.version.version, 1)
    assert.equal(versionBody.cases[0]?.id, 'case_api_1')

    const exported = await app.inject({
      method: 'GET',
      url: `/api/datasets/${dataset.id}/export?version=1`,
    })
    assert.equal(exported.statusCode, 200)
    assert.match(exported.headers['content-type'] as string, /text\/plain/)
    assert.equal(exported.body.trim().split('\n').length, 1)

    const missing = await app.inject({ method: 'GET', url: '/api/datasets/nope' })
    assert.equal(missing.statusCode, 404)
    assert.equal(json<{ error: { code: string } }>(missing).error.code, 'dataset_not_found')
  } finally {
    await app.close()
    fixture.cleanup()
  }
})

test('cases API: create, patch, delete and promote trace', async () => {
  const { app, fixture } = await setup()
  try {
    const datasetId = fixture.baselineRun.datasetId
    const created = await app.inject({
      method: 'POST',
      url: '/api/cases',
      payload: {
        id: 'case_manual_1',
        datasetId,
        slices: ['direct'],
        messages: [{ role: 'user', content: 'What is the annual limit?' }],
        expected: {
          answer: '500 requests.',
          behavior: 'answer',
          mustContain: ['500'],
          mustNotContain: [],
          anchors: [],
          minCitations: 0,
        },
      },
    })
    assert.equal(created.statusCode, 201)
    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/cases/case_manual_1',
      payload: { slices: ['direct', 'numbers'] },
    })
    assert.equal(patched.statusCode, 200)
    assert.deepEqual(json<{ slices: string[] }>(patched).slices, ['direct', 'numbers'])

    const deleted = await app.inject({ method: 'DELETE', url: '/api/cases/case_manual_1' })
    assert.equal(deleted.statusCode, 200)
    assert.deepEqual(json(deleted), { ok: true })
    const deletedAgain = await app.inject({ method: 'DELETE', url: '/api/cases/case_manual_1' })
    assert.equal(deletedAgain.statusCode, 404)

    const promoteMissing = await app.inject({
      method: 'POST',
      url: '/api/traces/trace_missing/promote',
      payload: { datasetId },
    })
    assert.equal(promoteMissing.statusCode, 404)
  } finally {
    await app.close()
    fixture.cleanup()
  }
})

test('profiles API: list, create and publish activates the profile', async () => {
  const { app, fixture } = await setup()
  try {
    const list = await app.inject({ method: 'GET', url: '/api/profiles' })
    const profiles = json<{ items: { id: string; name: string }[] }>(list)
    assert.ok(profiles.items.length >= 2)

    const created = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: {
        name: 'API custom',
        spec: {
          model: { id: 'deepseek-v4-pro', thinking: false, maxTokens: 900 },
          retrieval: {
            enabled: true,
            collection: 'meridian',
            k: 4,
            candidates: 20,
            rerank: 'off',
            contextBudgetTokens: 2000,
            parentExpansion: true,
          },
          prompt: { template: 'rag-v1', citationStyle: 'bracket' },
          judge: { rubric: 'judge-v1', passScore: 2 },
        },
      },
    })
    assert.equal(created.statusCode, 201)
    const profile = json<{ id: string; version: number; publishedAt: number | null }>(created)
    assert.equal(profile.version, 1)
    assert.equal(profile.publishedAt, null)

    const published = await app.inject({
      method: 'POST',
      url: `/api/profiles/${profile.id}/publish`,
    })
    assert.equal(published.statusCode, 200)
    const publishedProfile = json<{ publishedAt: number | null }>(published)
    assert.ok(publishedProfile.publishedAt !== null)
    assert.equal(
      fixture.db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get()?.value,
      profile.id
    )

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      payload: { name: 'bad', spec: { retrieval: { k: -1 } } },
    })
    assert.equal(invalid.statusCode, 400)
  } finally {
    await app.close()
    fixture.cleanup()
  }
})

test('runs API: list, detail, items and compare', async () => {
  const { app, fixture } = await setup()
  try {
    const list = await app.inject({ method: 'GET', url: '/api/runs' })
    assert.equal(list.statusCode, 200)
    const runs = json<{ items: { id: string; status: string }[] }>(list)
    assert.ok(runs.items.length >= 2)

    const detail = await app.inject({ method: 'GET', url: `/api/runs/${fixture.baselineRun.id}` })
    assert.equal(detail.statusCode, 200)
    const run = json<{
      id: string
      datasetName: string
      status: string
      summary: { passRate: number }
    }>(detail)
    assert.equal(run.datasetName, 'support')
    assert.equal(run.status, 'done')
    assert.equal(run.summary.passRate, 1)

    const items = await app.inject({
      method: 'GET',
      url: `/api/runs/${fixture.baselineRun.id}/items`,
    })
    const itemBody = json<{ items: { caseId: string; pass: boolean; slices: string[] }[] }>(items)
    assert.equal(itemBody.items.length, 4)
    assert.ok(itemBody.items[0]?.slices.length !== undefined)

    const compared = await app.inject({
      method: 'GET',
      url: `/api/runs/compare?baseline=${fixture.baselineRun.id}&candidate=${fixture.candidateRun.id}`,
    })
    assert.equal(compared.statusCode, 200)
    const comparison = json<{
      baseline: { id: string }
      candidate: { id: string }
      overall: { cases: number; passRate: { delta: number | null } }
      slices: unknown[]
    }>(compared)
    assert.equal(comparison.baseline.id, fixture.baselineRun.id)
    assert.equal(comparison.overall.cases, 4)
    assert.equal(comparison.overall.passRate.delta, 0)

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/runs/${fixture.baselineRun.id}/cancel`,
    })
    assert.equal(cancelled.statusCode, 200)
    assert.equal(json<{ status: string }>(cancelled).status, 'done')

    const missing = await app.inject({ method: 'GET', url: '/api/runs/run_nope' })
    assert.equal(missing.statusCode, 404)
    const badCreate = await app.inject({ method: 'POST', url: '/api/runs', payload: {} })
    assert.equal(badCreate.statusCode, 400)
  } finally {
    await app.close()
    fixture.cleanup()
  }
})

test('gates API: create, list, detail and artifacts in all formats', async () => {
  const { app, fixture } = await setup()
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/gates',
      payload: {
        baselineRunId: fixture.baselineRun.id,
        candidateRunId: fixture.candidateRun.id,
        config: {
          suite: 'support',
          minCases: 3,
          thresholds: {
            passRate: 0.8,
            faithfulness: 0.7,
            citationValidity: 0.9,
            refusalAccuracy: 0.8,
            maxCostPerCaseUsd: 0.02,
            maxP95LatencyMs: 60_000,
          },
        },
      },
    })
    assert.equal(created.statusCode, 201)
    const gate = json<{
      id: string
      result: { pass: boolean; failures: unknown[] }
      artifacts: { htmlPath: string }
    }>(created)
    assert.equal(gate.result.pass, true)
    assert.ok(gate.artifacts.htmlPath.endsWith('review.html'))

    const listed = await app.inject({ method: 'GET', url: '/api/gates' })
    assert.equal(json<{ items: unknown[] }>(listed).items.length, 1)
    const detail = await app.inject({ method: 'GET', url: `/api/gates/${gate.id}` })
    assert.equal(detail.statusCode, 200)

    for (const format of ['md', 'json', 'html']) {
      const artifact = await app.inject({
        method: 'GET',
        url: `/api/gates/${gate.id}/artifact?format=${format}`,
      })
      assert.equal(artifact.statusCode, 200)
      assert.ok(artifact.body.length > 100)
      if (format === 'html') {
        assert.match(artifact.headers['content-type'] as string, /text\/html/)
        assert.doesNotMatch(artifact.body, /<script/i)
      }
      if (format === 'json') {
        assert.match(artifact.headers['content-type'] as string, /application\/json/)
      }
    }
    const fallback = await app.inject({ method: 'GET', url: `/api/gates/${gate.id}/artifact` })
    assert.match(fallback.headers['content-type'] as string, /text\/markdown/)

    const missing = await app.inject({ method: 'GET', url: '/api/gates/gate_nope' })
    assert.equal(missing.statusCode, 404)
  } finally {
    await app.close()
    fixture.cleanup()
  }
})

test('fine-tuning API: preflight, export, manifest and DeepSeek unavailability', async () => {
  const { app, fixture } = await setup()
  try {
    const versionId = fixture.datasetVersionId
    const preflight = await app.inject({
      method: 'POST',
      url: '/api/finetune/preflight',
      payload: { datasetVersionId: versionId, format: 'sft' },
    })
    assert.equal(preflight.statusCode, 200)
    const report = json<{
      ok: boolean
      stats: { examples: number }
      checks: unknown[]
      manifest: unknown
    }>(preflight)
    assert.equal(report.ok, true)
    assert.ok(report.stats.examples > 0)
    assert.ok(report.checks.length > 0)

    const invalidFormat = await app.inject({
      method: 'POST',
      url: '/api/finetune/preflight',
      payload: { datasetVersionId: versionId, format: 'chatml' },
    })
    assert.equal(invalidFormat.statusCode, 400)

    const created = await app.inject({
      method: 'POST',
      url: '/api/finetune/exports',
      payload: { datasetVersionId: versionId, format: 'sft' },
    })
    assert.equal(created.statusCode, 201)
    const exportValue = json<{
      id: string
      path: string
      manifestPath: string
      stats: { examples: number }
    }>(created)
    assert.ok(exportValue.stats.examples > 0)

    const listed = await app.inject({ method: 'GET', url: '/api/finetune/exports' })
    assert.equal(json<{ items: unknown[] }>(listed).items.length, 1)
    const detail = await app.inject({
      method: 'GET',
      url: `/api/finetune/exports/${exportValue.id}`,
    })
    const detailBody = json<{
      export: { id: string }
      manifest: { provenance: { caseIds: string[] } }
    }>(detail)
    assert.equal(detailBody.export.id, exportValue.id)
    assert.ok(detailBody.manifest.provenance.caseIds.length > 0)

    const deepseek = await app.inject({
      method: 'POST',
      url: '/api/finetune/jobs',
      payload: { exportId: exportValue.id, provider: 'deepseek' },
    })
    assert.equal(deepseek.statusCode, 400)
    assert.equal(
      json<{ error: { code: string; message: string } }>(deepseek).error.code,
      'not_offered_by_deepseek'
    )
    assert.match(
      json<{ error: { message: string } }>(deepseek).error.message,
      /does not offer fine-tuning/
    )

    const jobs = await app.inject({ method: 'GET', url: '/api/finetune/jobs' })
    assert.deepEqual(json<{ items: unknown[] }>(jobs).items, [])
  } finally {
    await app.close()
    fixture.cleanup()
  }
})
