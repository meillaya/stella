import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { DatasetCase } from '../../../shared/types.ts'
import { openDatabase } from '../../src/db/index.ts'
import {
  createDataset,
  importDatasetJsonl,
  serializeCasesJsonl,
  snapshotDataset,
} from '../../src/evals/datasets.ts'
import {
  CONTAMINATION_NGRAM_SIZE,
  assignSplits,
  buildContaminationIndex,
  exportFinetune,
  findNearDuplicates,
  isContaminated,
  minhashSignature,
  jaccardEstimate,
  ngramHashes,
  preflightFinetune,
  redactPii,
  validateFinetuneExample,
  FINETUNE_PROVIDERS,
  createFinetuneJob,
  getFinetuneJob,
  planFinetune,
  pollFinetuneJob,
  readExportManifest,
  readExportSplit,
  refreshFinetuneJob,
  submitFinetuneJob,
} from '../../src/finetune/index.ts'

const caseValue = (index: number, overrides: Partial<DatasetCase> = {}): DatasetCase => ({
  id: `case_${index}`,
  slices: ['direct'],
  messages: [
    {
      role: 'user',
      content: `How do I reset my password for account ${index} when the confirmation email never arrives and the login page keeps rejecting my current password?`,
    },
  ],
  expected: {
    answer: `Open Settings then Security and use the reset link for account ${index} that appears in the confirmation email message before the session expires and the account locks completely.`,
    behavior: 'answer',
    mustContain: ['Settings'],
    mustNotContain: [],
    anchors: [{ doc: index % 2 === 0 ? 'security/passwords.md' : 'account/settings.md' }],
    minCitations: 1,
  },
  ...overrides,
})

const rawCases = (): DatasetCase[] => [
  caseValue(1),
  caseValue(2),
  caseValue(3, {
    messages: [{ role: 'user', content: 'Who do I email for billing help?' }],
    expected: {
      answer: 'Email support@example.com or call +1 415 555 2671 with invoice questions.',
      behavior: 'answer',
      mustContain: ['support'],
      mustNotContain: [],
      anchors: [{ doc: 'billing/contact.md' }],
      minCitations: 1,
    },
  }),
  caseValue(4, {
    messages: [
      {
        role: 'user',
        content:
          'How do I reset my password for account 4 when the confirmation email never arrives and the login page keeps rejecting my current password?',
      },
    ],
    expected: {
      answer:
        'Open Settings then Security and use the reset link for account 4 that appears in the confirmation email message before the session expires and the account locks completely.',
      behavior: 'answer',
      mustContain: ['Settings'],
      mustNotContain: [],
      anchors: [{ doc: 'security/passwords.md' }],
      minCitations: 1,
    },
  }),
  caseValue(5, {
    messages: [{ role: 'user', content: 'What is the CEO home address?' }],
    expected: {
      answer: '',
      behavior: 'refuse',
      mustContain: [],
      mustNotContain: [],
      anchors: [],
      minCitations: 0,
    },
  }),
  caseValue(6, {
    messages: [{ role: 'user', content: 'Hi' }],
    expected: {
      answer: 'Hi.',
      behavior: 'answer',
      mustContain: [],
      mustNotContain: [],
      anchors: [],
      minCitations: 0,
    },
  }),
  caseValue(7, {
    messages: [{ role: 'user', content: 'No gold answer here?' }],
    expected: {
      answer: '',
      behavior: 'any',
      mustContain: [],
      mustNotContain: [],
      anchors: [],
      minCitations: 0,
    },
  }),
]

const makeDataset = (name: string) => {
  const db = openDatabase(':memory:')
  const datasetsDir = mkdtempSync(path.join(tmpdir(), 'stella-ft-ds-'))
  const dataDir = mkdtempSync(path.join(tmpdir(), 'stella-ft-data-'))
  const dataset = createDataset({ name, description: 'finetune fixture' }, db)
  importDatasetJsonl(dataset.id, serializeCasesJsonl(rawCases()), db)
  const snapshot = snapshotDataset(dataset.id, { notes: 'ft fixture' }, { db, datasetsDir })
  return { db, datasetsDir, dataDir, dataset, snapshot }
}

test('redactPii removes emails, phones, cards, IPs, keys and private keys', () => {
  const result = redactPii(
    'Mail support@example.com, call +1 415 555 2671, card 4111 1111 1111 1111, host 192.168.1.20, ' +
      'key sk-abcdefghijklmnopqrstuvwx and Bearer abcdefghijklmnopqrstuvwxyz, date 2024-11-15.'
  )
  assert.match(result.text, /\[EMAIL\]/)
  assert.match(result.text, /\[PHONE\]/)
  assert.match(result.text, /\[CARD\]/)
  assert.match(result.text, /\[IP\]/)
  assert.match(result.text, /\[REDACTED_KEY\]|\[REDACTED_TOKEN\]/)
  assert.doesNotMatch(result.text, /support@example\.com/)
  assert.doesNotMatch(result.text, /4111 1111 1111 1111/)
  assert.ok(result.total >= 5)
  assert.match(result.text, /2024-11-15/) // dates are not phone numbers
  const clean = redactPii('Refunds are processed within 14 days.')
  assert.equal(clean.total, 0)

  const privateKey = redactPii(
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
  )
  assert.match(privateKey.text, /REDACTED_PRIVATE_KEY/)
})

test('MinHash near-duplicate detection is deterministic', () => {
  const tokens = Array.from({ length: 50 }, (_, index) => `token${index}`)
  const base = tokens.join(' ')
  const similarTokens = [...tokens]
  similarTokens[25] = 'changedword'
  const similar = similarTokens.join(' ')
  const nearA = minhashSignature(base)
  const nearB = minhashSignature(similar)
  assert.ok(jaccardEstimate(nearA, nearB) >= 0.8)
  const different = minhashSignature(
    'The annual limit is 500 requests on the Team plan with overage billing and a hard cap per calendar month for enterprise accounts.'
  )
  assert.ok(jaccardEstimate(nearA, different) < 0.8)
  const { duplicateIndexes } = findNearDuplicates([
    base,
    similar,
    'The annual limit is 500 requests on the Team plan with overage billing and a hard cap per calendar month for enterprise accounts.',
  ])
  assert.deepEqual([...duplicateIndexes], [1])
})

test('13-gram contamination detects shared long passages only', () => {
  const shared =
    'the refund policy states that refunds are processed within fourteen days of approval and appear on the next invoice'
  assert.ok(ngramHashes(shared).size > 0)
  const index = buildContaminationIndex([
    `Our documentation says ${shared} for every enterprise customer in the program.`,
  ])
  assert.equal(
    isContaminated(`Unrelated prefix then ${shared} and more words after it.`, index),
    true
  )
  assert.equal(isContaminated('A short mention of refunds within fourteen days.', index), false)
  assert.equal(new Set([...ngramHashes(shared)]).size, ngramHashes(shared).size)
  assert.ok(ngramHashes(shared).size > 0)
  assert.equal(CONTAMINATION_NGRAM_SIZE, 13)
})

test('doc-based splits are deterministic, keep documents whole and respect ratios', () => {
  const docKeys: string[] = []
  for (let doc = 0; doc < 20; doc += 1) {
    for (let item = 0; item < 2; item += 1) {
      docKeys.push(`doc_${doc}`)
    }
  }
  const first = assignSplits(docKeys, { train: 0.8, val: 0.1, holdout: 0.1 })
  const second = assignSplits(docKeys, { train: 0.8, val: 0.1, holdout: 0.1 })
  assert.deepEqual(first, second)
  const docSplits = new Map<string, string>()
  for (const [index, split] of first.entries()) {
    const doc = docKeys[index] as string
    if (docSplits.has(doc)) {
      assert.equal(docSplits.get(doc), split)
    }
    docSplits.set(doc, split)
  }
  const counts = { train: 0, val: 0, holdout: 0 }
  for (const split of first) {
    counts[split] += 1
  }
  assert.equal(counts.train + counts.val + counts.holdout, docKeys.length)
  assert.ok(counts.train > counts.val)
  assert.ok(counts.val > 0 && counts.holdout > 0)
})

test('preflight filters refusals, PII, near-duplicates and short examples; splits stay valid', () => {
  const fixture = makeDataset('train-data')
  try {
    const report = preflightFinetune(
      { datasetVersionId: fixture.snapshot.version.id, format: 'sft' },
      { db: fixture.db }
    )
    assert.equal(report.format, 'sft')
    assert.ok(report.stats.examples > 0)
    assert.equal(report.stats.examples + report.stats.dropped + report.stats.duplicates, 7)
    assert.ok(report.stats.duplicates >= 1) // near-duplicate password questions
    assert.ok(report.stats.piiRedactions >= 2) // email + phone
    assert.equal(report.stats.contamination, 0)
    const train = report.splits.train.length
    assert.ok(train >= report.splits.val.length)
    assert.ok(report.checks.some((check) => check.id === 'splits' && check.ok))
    assert.ok(report.checks.some((check) => check.id === 'pii' && check.ok))
    assert.equal(report.ok, true)
    assert.match(report.manifest.notes[0] ?? '', /DeepSeek does not offer a fine-tuning endpoint/)
    assert.ok(report.manifest.provenance.caseIds.length > 0)
    assert.match(report.manifest.provenance.datasetContentHash, /^sha256:/)
  } finally {
    fixture.db.close()
    rmSync(fixture.datasetsDir, { recursive: true, force: true })
    rmSync(fixture.dataDir, { recursive: true, force: true })
  }
})

test('self-suite analysis warns but does not block export', () => {
  const fixture = makeDataset('support')
  try {
    const report = preflightFinetune(
      { datasetVersionId: fixture.snapshot.version.id, format: 'sft' },
      { db: fixture.db }
    )
    assert.equal(report.ok, true)
    assert.equal(report.contamination.checked, false)
    assert.equal(report.contamination.self, true)
    assert.ok(report.warnings.some((warning) => /self-overlap/.test(warning)))
  } finally {
    fixture.db.close()
    rmSync(fixture.datasetsDir, { recursive: true, force: true })
    rmSync(fixture.dataDir, { recursive: true, force: true })
  }
})

test('contamination against a different eval suite hard-blocks by default and can drop', () => {
  const source = makeDataset('train-data')
  try {
    const suite = createDataset({ name: 'support' }, source.db)
    // Same cases under a different dataset name: guaranteed 13-gram overlap.
    importDatasetJsonl(suite.id, serializeCasesJsonl(rawCases().slice(0, 4)), source.db)
    snapshotDataset(
      suite.id,
      { notes: 'suite' },
      { db: source.db, datasetsDir: source.datasetsDir }
    )

    const blocked = preflightFinetune(
      { datasetVersionId: source.snapshot.version.id, format: 'sft' },
      { db: source.db }
    )
    assert.equal(blocked.ok, false)
    assert.ok(blocked.failures.some((failure) => /contamination/.test(failure)))
    assert.ok(blocked.stats.contamination > 0)
    assert.ok(blocked.checks.some((check) => check.id === 'contamination' && check.ok === false))

    const dropped = preflightFinetune(
      {
        datasetVersionId: source.snapshot.version.id,
        format: 'sft',
        filters: { contamination: 'drop' },
      },
      { db: source.db }
    )
    assert.equal(dropped.ok, true)
    assert.ok(dropped.stats.contamination > 0)
    assert.ok(dropped.warnings.some((warning) => /contamination/.test(warning)))
  } finally {
    source.db.close()
    rmSync(source.datasetsDir, { recursive: true, force: true })
    rmSync(source.dataDir, { recursive: true, force: true })
  }
})

test('explicit missing eval suite is reported as a warning, not fabricated', () => {
  const fixture = makeDataset('train-data')
  try {
    const report = preflightFinetune(
      {
        datasetVersionId: fixture.snapshot.version.id,
        format: 'sft',
        filters: { evalSuite: 'does-not-exist' },
      },
      { db: fixture.db }
    )
    assert.equal(report.contamination.checked, false)
    assert.ok(report.warnings.some((warning) => /was not found/.test(warning)))
  } finally {
    fixture.db.close()
    rmSync(fixture.datasetsDir, { recursive: true, force: true })
    rmSync(fixture.dataDir, { recursive: true, force: true })
  }
})

test('DPO export builds prompt/chosen/rejected from failed run items', () => {
  const fixture = makeDataset('train-data')
  const runId = 'run_dpo_fixture'
  try {
    const createdAt = Date.now()
    fixture.db
      .prepare(
        `INSERT INTO runs(id, dataset_id, dataset_version_id, profile_id, provider, mode, status, budget_usd, config_json, created_at)
         VALUES (?, ?, ?, 'prof_x', 'replay', 'replay', 'done', 0, '{}', ?)`
      )
      .run(runId, fixture.dataset.id, fixture.snapshot.version.id, createdAt)
    const insertItem = fixture.db.prepare(
      `INSERT INTO run_items(id, run_id, case_id, status, answer, usage_json, cost_usd, latency_ms, sources_json,
         retrieval_json, grader_results_json, pass, error)
       VALUES (?, ?, ?, 'ok', ?, '{}', 0, 1, '[]', NULL, '[]', ?, NULL)`
    )
    insertItem.run('item_1', runId, 'case_1', 'I cannot help with that.', 0)

    const report = preflightFinetune(
      {
        datasetVersionId: fixture.snapshot.version.id,
        format: 'dpo',
        filters: { includeRunIds: [runId], dropRefusals: false, minChars: 1 },
      },
      { db: fixture.db }
    )
    assert.equal(report.format, 'dpo')
    const examples = [...report.splits.train, ...report.splits.val, ...report.splits.holdout]
    assert.ok(examples.length >= 1)
    for (const entry of examples) {
      assert.equal(validateFinetuneExample('dpo', entry.example).ok, true)
    }
    const withReject = examples.find((entry) => entry.caseId === 'case_1')
    assert.ok(withReject)
    const rejected = withReject.example as { rejected: string }
    assert.equal(rejected.rejected, 'I cannot help with that.')
  } finally {
    fixture.db.close()
    rmSync(fixture.datasetsDir, { recursive: true, force: true })
    rmSync(fixture.dataDir, { recursive: true, force: true })
  }
})

test('up/down-voted trace annotations supply SFT answers and DPO rejects', () => {
  const fixture = makeDataset('train-data')
  try {
    const timestamp = Date.now()
    const insertTrace = fixture.db.prepare(
      `INSERT INTO traces(id, session_id, session_key, created_at, status, model, thinking, profile_id, profile_name,
         retrieval_enabled, latency_ms, ttfb_ms, usage_json, cost_usd, pricing_basis, request_json, response_json,
         injected_context, error, feedback, annotation)
       VALUES (?, NULL, 'sk', ?, 'ok', 'deepseek-flash', 0, NULL, NULL, 0, 10, NULL, '{}', 0, 'off-peak', ?, ?, NULL, NULL, ?, ?)`
    )
    insertTrace.run(
      'trace_up',
      timestamp,
      JSON.stringify({ messages: [{ role: 'user', content: 'No gold answer here?' }] }),
      JSON.stringify({
        text: 'Recovered from a human-approved annotation answer that is long enough.',
      }),
      'up',
      null
    )
    insertTrace.run(
      'trace_down',
      timestamp,
      JSON.stringify({
        messages: [{ role: 'user', content: rawCases()[1]?.messages[0]?.content ?? '' }],
      }),
      JSON.stringify({ text: 'A down-voted answer that should be the DPO rejected completion.' }),
      'down',
      null
    )
    const report = preflightFinetune(
      {
        datasetVersionId: fixture.snapshot.version.id,
        format: 'dpo',
        filters: { includeRunIds: [], dropRefusals: false, minChars: 1 },
      },
      { db: fixture.db }
    )
    const examples = [...report.splits.train, ...report.splits.val, ...report.splits.holdout]
    const fromAnnotation = examples.find((entry) => entry.caseId === 'case_2')
    assert.ok(fromAnnotation)
    const annotationRejected = fromAnnotation.example as { rejected: string }
    assert.equal(
      annotationRejected.rejected,
      'A down-voted answer that should be the DPO rejected completion.'
    )
    assert.ok(report.manifest.provenance.traceIds.includes('trace_down'))

    const sft = preflightFinetune(
      {
        datasetVersionId: fixture.snapshot.version.id,
        format: 'sft',
        filters: { dropRefusals: false, minChars: 1 },
      },
      { db: fixture.db }
    )
    const sftExamples = [...sft.splits.train, ...sft.splits.val, ...sft.splits.holdout]
    const approved = sftExamples.find((entry) => entry.caseId === 'case_7')
    assert.ok(approved)
    assert.match(JSON.stringify(approved?.example), /human-approved annotation answer/)
    assert.ok(sft.manifest.provenance.traceIds.includes('trace_up'))
  } finally {
    fixture.db.close()
    rmSync(fixture.datasetsDir, { recursive: true, force: true })
    rmSync(fixture.dataDir, { recursive: true, force: true })
  }
})

test('sharegpt and sft examples match their schemas; bad examples are rejected', () => {
  assert.equal(
    validateFinetuneExample('sft', {
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ],
    }).ok,
    true
  )
  assert.equal(validateFinetuneExample('sft', { messages: [] }).ok, false)
  assert.equal(
    validateFinetuneExample('sharegpt', {
      conversations: [
        { from: 'human', value: 'q' },
        { from: 'gpt', value: 'a' },
      ],
    }).ok,
    true
  )
  assert.equal(
    validateFinetuneExample('sharegpt', { conversations: [{ from: 'gpt', value: 'a' }] }).ok,
    false
  )
  assert.equal(
    validateFinetuneExample('dpo', { prompt: 'q', chosen: 'a', rejected: 'a' }).ok,
    false
  )
})

test('export writes split files and a provenance manifest; plans cover all providers', () => {
  const fixture = makeDataset('train-data')
  try {
    const result = exportFinetune(
      { datasetVersionId: fixture.snapshot.version.id, format: 'sft' },
      { db: fixture.db, dataDir: fixture.dataDir }
    )
    assert.ok(existsSync(result.export.manifestPath))
    assert.ok(existsSync(result.export.path))
    const manifest = readExportManifest(result.export, fixture.db)
    assert.equal(manifest.exportId, result.export.id)
    assert.equal(manifest.format, 'sft')
    assert.equal(manifest.counts.examples, result.export.stats.examples)
    assert.deepEqual(manifest.provenance.caseIds.length > 0, true)
    const trainText = readExportSplit(result.export, 'train')
    const trainLines = trainText.trim().length === 0 ? [] : trainText.trim().split('\n')
    assert.equal(trainLines.length, result.export.stats.train)
    for (const line of trainLines) {
      assert.equal(validateFinetuneExample('sft', JSON.parse(line)).ok, true)
    }

    for (const provider of FINETUNE_PROVIDERS) {
      const plan = planFinetune({ exportId: result.export.id, provider }, { db: fixture.db })
      assert.equal(plan.provider, provider)
      assert.equal(plan.exportId, result.export.id)
      assert.equal(plan.dataset.name, 'train-data')
      if (provider === 'deepseek') {
        assert.equal(plan.available, false)
        assert.equal(plan.plan, null)
        assert.match(plan.reason ?? '', /does not offer fine-tuning/)
        assert.ok(plan.docs.length > 0)
      } else {
        assert.equal(plan.available, true)
        assert.ok((plan.plan ?? '').length > 20)
        assert.ok(plan.files.length >= 1)
      }
    }
    const axolotl = planFinetune(
      { exportId: result.export.id, provider: 'axolotl' },
      { db: fixture.db }
    )
    assert.equal(axolotl.planFormat, 'yaml')
    assert.match(axolotl.plan ?? '', /base_model:/)
    const unsloth = planFinetune(
      { exportId: result.export.id, provider: 'unsloth' },
      { db: fixture.db }
    )
    assert.match(unsloth.plan ?? '', /FastLanguageModel/)
  } finally {
    fixture.db.close()
    rmSync(fixture.datasetsDir, { recursive: true, force: true })
    rmSync(fixture.dataDir, { recursive: true, force: true })
  }
})

/* ------------------------------ job adapter (mock HTTP) ------------------------------ */

type MockServer = {
  url: string
  requests: { method: string; url: string; body: string; authorization: string | null }[]
  close: () => Promise<void>
}

const startMockServer = async (): Promise<MockServer> => {
  const requests: MockServer['requests'] = []
  let polls = 0
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        body,
        authorization: request.headers.authorization ?? null,
      })
      response.setHeader('content-type', 'application/json')
      if (request.method === 'POST') {
        response.end(JSON.stringify({ id: 'job_ext_1', status: 'queued' }))
        return
      }
      polls += 1
      response.end(
        JSON.stringify({ id: 'job_ext_1', status: polls >= 2 ? 'succeeded' : 'running' })
      )
    })
  }
  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('mock server failed')
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

test('job adapter submits and polls over HTTP against a mock server', async () => {
  const mock = await startMockServer()
  const fixture = makeDataset('train-data')
  try {
    const exported = exportFinetune(
      { datasetVersionId: fixture.snapshot.version.id, format: 'sft' },
      { db: fixture.db, dataDir: fixture.dataDir }
    )
    const submitted = await submitFinetuneJob(
      {
        provider: 'openai-compatible',
        baseModel: 'gpt-4o-mini',
        trainingFile: `${exported.export.path}/${exported.export.format}-train.jsonl`,
        exportId: exported.export.id,
      },
      { baseUrl: mock.url, apiKey: 'test-key' }
    )
    assert.equal(submitted.externalId, 'job_ext_1')
    assert.equal(submitted.status, 'queued')
    assert.equal(mock.requests[0]?.method, 'POST')
    assert.equal(mock.requests[0]?.url, '/v1/fine_tuning/jobs')
    assert.equal(mock.requests[0]?.authorization, 'Bearer test-key')
    const body = JSON.parse(mock.requests[0]?.body ?? '{}') as Record<string, unknown>
    assert.equal(
      body.training_file,
      `${exported.export.path}/${exported.export.format}-train.jsonl`
    )

    const first = await pollFinetuneJob(
      { provider: 'openai-compatible', externalId: 'job_ext_1' },
      { baseUrl: mock.url, apiKey: 'test-key' }
    )
    assert.equal(first.status, 'running')
    const second = await pollFinetuneJob(
      { provider: 'openai-compatible', externalId: 'job_ext_1' },
      { baseUrl: mock.url, apiKey: 'test-key' }
    )
    assert.equal(second.status, 'succeeded')

    const job = await createFinetuneJob(
      { exportId: exported.export.id, provider: 'openai-compatible', baseModel: 'gpt-4o-mini' },
      { db: fixture.db, transport: { baseUrl: mock.url, apiKey: 'test-key' } }
    )
    assert.equal(job.status, 'queued')
    assert.equal(job.externalId, 'job_ext_1')
    assert.equal(getFinetuneJob(job.id, fixture.db).externalId, 'job_ext_1')
    const refreshed = await refreshFinetuneJob(job.id, {
      db: fixture.db,
      transport: { baseUrl: mock.url, apiKey: 'test-key' },
    })
    assert.equal(['running', 'succeeded'].includes(refreshed.status), true)
  } finally {
    await mock.close()
    fixture.db.close()
    rmSync(fixture.datasetsDir, { recursive: true, force: true })
    rmSync(fixture.dataDir, { recursive: true, force: true })
  }
})

test('deepseek job submission is explicitly unavailable with a docs link', async () => {
  const fixture = makeDataset('train-data')
  try {
    const exported = exportFinetune(
      { datasetVersionId: fixture.snapshot.version.id, format: 'sft' },
      { db: fixture.db, dataDir: fixture.dataDir }
    )
    await assert.rejects(
      () =>
        createFinetuneJob(
          { exportId: exported.export.id, provider: 'deepseek' },
          { db: fixture.db }
        ),
      (error: Error & { code?: string }) =>
        error.code === 'not_offered_by_deepseek' &&
        /does not offer fine-tuning/i.test(error.message)
    )
    await assert.rejects(
      () =>
        submitFinetuneJob(
          { provider: 'deepseek', baseModel: 'deepseek-flash', trainingFile: 'x', exportId: 'x' },
          { apiKey: 'test' }
        ),
      /does not offer fine-tuning/
    )
    await assert.rejects(
      () =>
        createFinetuneJob(
          { exportId: exported.export.id, provider: 'unsloth' },
          { db: fixture.db }
        ),
      /runs locally/
    )
  } finally {
    fixture.db.close()
    rmSync(fixture.datasetsDir, { recursive: true, force: true })
    rmSync(fixture.dataDir, { recursive: true, force: true })
  }
})
