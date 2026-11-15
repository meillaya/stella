/**
 * Stella CLI. Runs without a server unless `serve` is used: `stella gate`,
 * `stella eval run`, `stella seed` and the fine-tuning commands read the SQLite
 * DB and the datasets directory directly.
 *
 * Exit codes: 0 = success / gate pass, 1 = gate fail or business failure,
 * 2 = usage or configuration error.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { config, keyStatus } from '../config.ts'
import { getDb } from '../db/index.ts'
import { formatPercent, formatPp } from '../../../shared/metrics.ts'
import { formatUsd, isPeak, nextOffPeak } from '../../../shared/pricing.ts'
import type {
  DatasetVersion,
  FinetuneFormat,
  Profile,
  Run,
  RunMode,
} from '../../../shared/types.ts'
import { BusinessError, UsageError, errorMessage } from '../evals/errors.ts'
import {
  anchorDrift,
  createDataset,
  ensureDataset,
  exportDatasetVersionJsonl,
  getDataset,
  getDatasetVersion,
  getDatasetVersionByNumber,
  importDatasetJsonl,
  latestDatasetVersion,
  listDatasets,
  listDatasetVersions,
  listDraftCases,
  readVersionCases,
  serializeCasesJsonl,
  sha256,
  snapshotDataset,
} from '../evals/datasets.ts'
import {
  DEMO_PROFILE_NAMES,
  findProfileByName,
  getActiveProfile,
  getProfile,
  getProfileByName,
  seedProfiles,
} from '../evals/profiles.ts'
import { compareRuns, createRun, executeRun, getRunItems, listRuns } from '../evals/runner.ts'
import { createGate, loadGateConfig } from '../evals/gates.ts'
import {
  createRecordingAdapters,
  createReplayStableRetrieveAdapter,
  ensureCollection,
  ingestCorpusPaths,
  searchCorpus,
} from '../evals/adapters.ts'
import {
  createFinetuneJob,
  exportFinetune,
  listFinetuneExports,
  listFinetuneJobs,
  planFinetune,
  preflightFinetune,
  refreshFinetuneJob,
  DEEPSEEK_FINETUNE_DOCS,
  FINETUNE_FORMATS,
  FINETUNE_PROVIDERS,
  type FinetuneFilters,
  type FinetuneProviderId,
} from '../finetune/index.ts'

/* ------------------------------ output helpers ------------------------------ */

const out = (text = ''): void => {
  process.stdout.write(`${text}\n`)
}
const err = (text: string): void => {
  process.stderr.write(`${text}\n`)
}

const printJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

const banner = (title: string): void => {
  out('')
  out(`── ${title} ${'─'.repeat(Math.max(0, 64 - title.length))}`)
}

const table = (headers: string[], rows: string[][]): void => {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length))
  )
  const formatRow = (row: string[]): string =>
    row
      .map((cell, index) => (cell ?? '').padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd()
  out(formatRow(headers))
  out(formatRow(widths.map((width) => '-'.repeat(width))))
  for (const row of rows) {
    out(formatRow(row))
  }
}

/* ------------------------------ argument parsing ------------------------------ */

type Parsed = {
  positionals: string[]
  flags: Map<string, string | true>
}

const parseArgs = (argv: string[]): Parsed => {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(key, next)
      index += 1
    } else {
      flags.set(key, true)
    }
  }
  return { positionals, flags }
}

const flag = (parsed: Parsed, name: string): string | null => {
  const value = parsed.flags.get(name)
  return typeof value === 'string' ? value : null
}

const flagBool = (parsed: Parsed, name: string): boolean => parsed.flags.has(name)

const flagNumber = (parsed: Parsed, name: string): number | null => {
  const raw = flag(parsed, name)
  if (raw === null) {
    return null
  }
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new UsageError(`--${name} must be a number`)
  }
  return value
}

const requiredFlag = (parsed: Parsed, name: string): string => {
  const value = flag(parsed, name)
  if (value === null || value.length === 0) {
    throw new UsageError(`--${name} is required`)
  }
  return value
}

const isJson = (parsed: Parsed): boolean => flagBool(parsed, 'json')

/* ------------------------------ resolution helpers ------------------------------ */

const db = () => getDb()

const resolveDatasetVersion = (parsed: Parsed): DatasetVersion => {
  const versionId = flag(parsed, 'version-id')
  if (versionId) {
    return getDatasetVersion(versionId)
  }
  const version = flag(parsed, 'version')
  const dataset = flag(parsed, 'dataset')
  if (version !== null && dataset !== null) {
    if (!/^\d+$/.test(version)) {
      return getDatasetVersion(version)
    }
    return getDatasetVersionByNumber(dataset, Number(version))
  }
  if (dataset !== null) {
    return latestDatasetVersion(dataset)
  }
  throw new UsageError('provide --dataset (with optional --version) or --version-id')
}

const resolveProfile = (parsed: Parsed): Profile => {
  const ref = flag(parsed, 'profile')
  if (ref === null) {
    throw new UsageError('--profile is required (profile id or name)')
  }
  try {
    return getProfile(ref)
  } catch {
    return getProfileByName(ref)
  }
}

const modeFromFlags = (parsed: Parsed): RunMode => {
  if (flagBool(parsed, 'replay')) {
    return 'replay'
  }
  if (flagBool(parsed, 'live')) {
    return 'live'
  }
  return config.mode
}

const judgeFromFlags = (parsed: Parsed, fallback: boolean): boolean => {
  if (flagBool(parsed, 'no-judge')) {
    return false
  }
  if (flagBool(parsed, 'judge')) {
    return true
  }
  return fallback
}

const concurrencyFromFlags = (parsed: Parsed): number => {
  const value = flagNumber(parsed, 'concurrency')
  return value !== null && value >= 1 ? Math.floor(value) : config.runConcurrency
}

/* ------------------------------ doctor / serve / version ------------------------------ */

const doctor = (): number => {
  const database = db()
  const schema = database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined
  const count = (sql: string): number => (database.prepare(sql).get() as { n: number }).n
  const key = keyStatus()
  const active = getActiveProfile()
  out(`Stella ${config.version} on Node ${process.version}`)
  out(`root        ${config.root}`)
  out(`database    ${config.dbPath} (schema ${schema?.value ?? 'unknown'})`)
  out(`data dir    ${config.dataDir}`)
  out(`datasets    ${config.datasetsDir}`)
  out(`mode        ${config.mode}${config.mode === 'replay' ? ' (cassettes only)' : ''}`)
  out(`bind        ${config.host}:${config.port}`)
  out(`deepseek    ${config.deepseekBaseUrl}`)
  out(
    `api key     ${key.configured ? `configured (…${key.lastFour}, ${key.source})` : 'missing → set DEEPSEEK_API_KEY in .env.local'}`
  )
  out(
    `records     ${count('SELECT COUNT(*) AS n FROM collections')} collections, ${count('SELECT COUNT(*) AS n FROM documents')} documents, ` +
      `${count('SELECT COUNT(*) AS n FROM traces')} traces, ${count('SELECT COUNT(*) AS n FROM datasets')} datasets, ` +
      `${count('SELECT COUNT(*) AS n FROM profiles')} profiles, ${count('SELECT COUNT(*) AS n FROM runs')} runs, ` +
      `${count('SELECT COUNT(*) AS n FROM gates')} gates, ${count('SELECT COUNT(*) AS n FROM finetune_exports')} FT exports`
  )
  out(`active      ${active ? `${active.name} v${active.version} (${active.id})` : 'none'}`)
  return 0
}

const serve = async (): Promise<number> => {
  const { startServer } = await import('../index.ts')
  await startServer()
  return 0
}

/* ------------------------------ seed ------------------------------ */

const SUPPORT_SOURCE_FILE = (): string => path.join(config.datasetsDir, 'support', '0001.jsonl')

export type SeedOutcome = {
  collectionId: string
  datasetId: string
  datasetName: string
  version: DatasetVersion
  snapshotCreated: boolean
  profiles: { baselineId: string; groundedId: string }
  activeProfileId: string | null
  documents: number
  chunks: number
  cases: number
}

const seedDemo = async (
  options: { quiet?: boolean; resnapshot?: boolean } = {}
): Promise<SeedOutcome> => {
  const database = db()
  const quiet = options.quiet === true
  const say = (text: string): void => {
    if (!quiet) {
      out(text)
    }
  }
  say('seeding demo collection "meridian"…')
  const collection = await ensureCollection({
    name: 'meridian',
    description: 'Meridian demo knowledge base (fictional product corpus)',
  })
  const corpusPath = path.join(config.corpusDir, 'meridian')
  if (!existsSync(corpusPath)) {
    throw new BusinessError(
      `demo corpus not found at ${corpusPath}; expected the Meridian markdown corpus`,
      'seed_corpus_missing',
      400
    )
  }
  const ingestion = await ingestCorpusPaths({ collectionId: collection.id, paths: [corpusPath] })
  for (const failure of ingestion.errors) {
    err(`ingest warning: ${failure.path}: ${failure.message}`)
  }
  const documents = (
    database
      .prepare('SELECT COUNT(*) AS n FROM documents WHERE collection_id = ?')
      .get(collection.id) as { n: number }
  ).n
  const chunks = (
    database
      .prepare('SELECT COUNT(*) AS n FROM chunks WHERE collection_id = ?')
      .get(collection.id) as { n: number }
  ).n
  say(
    `  collection ${collection.name}: ${documents} documents, ${chunks} chunks, ${ingestion.documents.length} files ingested`
  )

  say('seeding dataset "support"…')
  const sourceFile = SUPPORT_SOURCE_FILE()
  if (!existsSync(sourceFile)) {
    throw new BusinessError(
      `demo dataset not found at ${sourceFile}; the content workstream provides datasets/support/0001.jsonl`,
      'seed_dataset_missing',
      400
    )
  }
  const dataset = ensureDataset({
    name: 'support',
    description: 'Meridian support gold evaluation suite',
  })
  const imported = importDatasetJsonl(dataset.id, readFileSync(sourceFile, 'utf8'))
  if (imported.issues.length > 0) {
    for (const issue of imported.issues.slice(0, 5)) {
      err(`dataset warning: line ${issue.line} ${issue.field}: ${issue.message}`)
    }
  }
  const cases = listDraftCases(dataset.id)
  let snapshotCreated = false
  let version: DatasetVersion
  const versions = listDatasetVersions(dataset.id)
  const latest = versions[versions.length - 1]
  const currentHash = sha256(serializeCasesJsonl(cases))
  if (!latest || latest.contentHash !== currentHash) {
    const outcome = snapshotDataset(dataset.id, { notes: 'demo seed' })
    version = outcome.version
    snapshotCreated = true
    say(
      `  snapshot v${version.version}: ${version.caseCount} cases, anchors ${version.anchorStatus.resolved}/${version.anchorStatus.total} resolved`
    )
    if (version.anchorStatus.missing.length > 0) {
      for (const missing of version.anchorStatus.missing.slice(0, 5)) {
        err(`  anchor warning: ${missing}`)
      }
    }
  } else {
    version = latest as DatasetVersion
    say(`  reusing snapshot v${version.version} (${version.caseCount} cases, content unchanged)`)
  }

  say('seeding profiles…')
  const seeded = seedProfiles({ collection: 'meridian', activate: true })
  if (seeded.created.length > 0) {
    say(`  created profiles: ${seeded.created.join(', ')}`)
  }
  const active = getActiveProfile()
  say(`  active profile: ${active ? `${active.name} (${active.id})` : 'none'}`)
  return {
    collectionId: collection.id,
    datasetId: dataset.id,
    datasetName: dataset.name,
    version,
    snapshotCreated,
    profiles: { baselineId: seeded.baseline.id, groundedId: seeded.improved.id },
    activeProfileId: active?.id ?? null,
    documents,
    chunks,
    cases: cases.length,
  }
}

const seedCommand = async (parsed: Parsed): Promise<number> => {
  const outcome = await seedDemo({ resnapshot: flagBool(parsed, 'resnapshot') })
  if (isJson(parsed)) {
    printJson(outcome)
    return 0
  }
  banner('seed summary')
  out(
    `collection  meridian (${outcome.collectionId}): ${outcome.documents} docs / ${outcome.chunks} chunks`
  )
  out(
    `dataset     ${outcome.datasetName} v${outcome.version.version} (${outcome.version.id}): ${outcome.cases} cases`
  )
  out(`snapshot    ${outcome.version.path} (${outcome.version.contentHash})`)
  out(
    `profiles    baseline ${outcome.profiles.baselineId} · grounded ${outcome.profiles.groundedId}`
  )
  out(`active      ${outcome.activeProfileId ?? 'none'}`)
  return 0
}

/* ------------------------------ demo / record ------------------------------ */

const CASSETTE_DIR = (): string => path.join(config.dataDir, 'cassettes')

const countCassettes = (directory: string): number => {
  if (!existsSync(directory)) {
    return 0
  }
  return readdirSync(directory).filter((file) => file.endsWith('.json')).length
}

const assertReplayReady = (needsJudge: boolean): void => {
  const directory = CASSETTE_DIR()
  const count = countCassettes(directory)
  if (count === 0) {
    throw new BusinessError(
      `replay mode requires cassettes in ${directory} but none were found. Record them first with a live key:\n` +
        `  DEEPSEEK_API_KEY=... stella record\n` +
        `then re-run: stella demo --replay${needsJudge ? ' --judge' : ''}\n` +
        'Stella never simulates model quality from nothing.',
      'replay_cassettes_missing',
      400
    )
  }
  if (needsJudge) {
    const jsonDir = path.join(directory, 'json-schema')
    if (countCassettes(jsonDir) === 0 && !existsSync(path.join(jsonDir))) {
      throw new BusinessError(
        `replay with --judge requires judge cassettes in ${jsonDir}. Record them with: stella record --judge`,
        'replay_judge_cassettes_missing',
        400
      )
    }
  }
}

const printRun = (label: string, run: Run): void => {
  const summary = run.summary
  out(`${label}: run ${run.id} [${run.status}] profile "${run.profileName}" (${run.mode})`)
  if (!summary) {
    out(`  no summary yet${run.error ? ` — ${run.error}` : ''}`)
    return
  }
  out(
    `  pass ${summary.pass}/${summary.cases} = ${formatPercent(summary.passRate)} (95% CI ${formatPercent(summary.ciLow)}–${formatPercent(summary.ciHigh)})`
  )
  out(
    `  cost ${formatUsd(summary.costUsd)} · ${formatUsd(summary.costPerPassUsd)}/successful answer · p50 ${Math.round(summary.p50LatencyMs)} ms · p95 ${Math.round(summary.p95LatencyMs)} ms`
  )
  if (summary.judgeAgreement !== null) {
    out(
      `  judge agreement ${formatPercent(summary.judgeAgreement)}${summary.judgeKappa !== null ? ` · kappa ${summary.judgeKappa.toFixed(3)}` : ''} · grader errors ${summary.graderErrors}`
    )
  }
  if (summary.retrieval) {
    out(
      `  retrieval recall@k ${formatPercent(summary.retrieval.recallAtK ?? null)} · MRR ${(summary.retrieval.mrr ?? 0).toFixed(3)} · nDCG@k ${(summary.retrieval.ndcgAtK ?? 0).toFixed(3)} (${summary.retrieval.evaluated} cases)`
    )
  }
  out(
    `  slices: ${Object.entries(summary.slices)
      .map(
        ([name, slice]) => `${name} ${formatPercent(slice.passRate)} (${slice.pass}/${slice.cases})`
      )
      .join(' · ')}`
  )
  if (run.error) {
    out(`  error: ${run.error}`)
  }
}

const assertReplayRunUsable = (label: string, run: Run): void => {
  if (run.mode !== 'replay') {
    return
  }
  const items = getRunItems(run.id)
  const misses = items.filter((item) =>
    (item.error ?? '').toLowerCase().includes('cassette missing')
  )
  if (misses.length > 0) {
    throw new BusinessError(
      `${label}: ${misses.length} replay cassette(s) are missing. Record them first with a live key:\n  DEEPSEEK_API_KEY=... stella record\nThen re-run: stella demo --replay. Stella never simulates model quality.`,
      'replay_cassettes_missing',
      400
    )
  }
}

const runProfileForDemo = async (input: {
  label: string
  datasetVersionId: string
  profileId: string
  mode: RunMode
  budgetUsd: number
  judge: boolean
  concurrency: number
}): Promise<Run> => {
  const created = createRun(
    {
      datasetVersionId: input.datasetVersionId,
      profileId: input.profileId,
      budgetUsd: input.budgetUsd,
      mode: input.mode,
      config: { judge: input.judge, calibration: input.judge },
    },
    { queue: false }
  )
  const finished = await executeRun(created.id, {
    concurrency: input.concurrency,
    ...(input.judge ? {} : { judge: false }),
  })
  printRun(input.label, finished)
  assertReplayRunUsable(input.label, finished)
  return finished
}

const defaultFiltersForSuite = (payload: Parsed): FinetuneFilters | undefined => {
  const evalSuite = flag(payload, 'eval-suite')
  const includeRunIds = flag(payload, 'run-ids')
  const filters: Record<string, unknown> = {}
  if (evalSuite !== null) {
    filters.evalSuite = evalSuite
  }
  if (includeRunIds !== null) {
    filters.includeRunIds = includeRunIds
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  }
  if (flagBool(payload, 'no-pii')) {
    filters.redactPii = false
  }
  const contamination = flag(payload, 'contamination')
  if (contamination === 'drop' || contamination === 'fail') {
    filters.contamination = contamination
  }
  return Object.keys(filters).length > 0 ? (filters as unknown as FinetuneFilters) : undefined
}

const demo = async (parsed: Parsed): Promise<number> => {
  const mode = modeFromFlags(parsed)
  const judge = judgeFromFlags(parsed, mode === 'live' && keyStatus().configured)
  if (mode === 'live' && !keyStatus().configured) {
    throw new BusinessError(
      'live demo requires DEEPSEEK_API_KEY in .env.local. Without a key use `stella demo --replay` with cassettes recorded by `stella record`.',
      'missing_api_key',
      400
    )
  }
  const budgetUsd = flagNumber(parsed, 'budget') ?? 0.5
  const concurrency = concurrencyFromFlags(parsed)
  if (mode === 'replay') {
    assertReplayReady(judge)
  }
  banner('1/7 seed')
  const seeded = await seedDemo()
  const version = seeded.version
  const baseline = findProfileByName(DEMO_PROFILE_NAMES.baseline)
  const grounded = findProfileByName(DEMO_PROFILE_NAMES.improved)
  if (!baseline || !grounded) {
    throw new BusinessError(
      'demo profiles are missing; run `stella seed`',
      'seed_profiles_missing',
      400
    )
  }
  banner(`2/7 baseline run — ${baseline.name} (${mode})`)
  const baselineRun = await runProfileForDemo({
    label: 'baseline',
    datasetVersionId: version.id,
    profileId: baseline.id,
    mode,
    budgetUsd,
    judge,
    concurrency,
  })
  banner(`3/7 candidate run — ${grounded.name} (${mode})`)
  const candidateRun = await runProfileForDemo({
    label: 'candidate',
    datasetVersionId: version.id,
    profileId: grounded.id,
    mode,
    budgetUsd,
    judge,
    concurrency,
  })
  banner('4/7 release gate')
  let gatePass = true
  let gateResult: Awaited<ReturnType<typeof createGate>> | null = null
  try {
    gateResult = createGate({
      baselineRunId: baselineRun.id,
      candidateRunId: candidateRun.id,
      dataDir: config.dataDir,
    })
    gatePass = gateResult.result.pass
    out(
      `gate ${gateResult.id}: ${gateResult.result.pass ? 'PASS' : 'FAIL'} (${gateResult.result.verdict})`
    )
    for (const failure of gateResult.result.failures) {
      err(`  ✗ ${failure.rule}: ${failure.message}`)
    }
    for (const warning of gateResult.result.warnings) {
      err(`  ! ${warning}`)
    }
    out(`  artifacts: ${gateResult.artifacts.mdPath}`)
    out(`             ${gateResult.artifacts.jsonPath}`)
    out(`             ${gateResult.artifacts.htmlPath}`)
  } catch (error) {
    gatePass = false
    err(`gate error: ${errorMessage(error)}`)
  }
  banner('5/7 fine-tune data export')
  let exportPath: string | null = null
  let ftNote = 'not run'
  try {
    const preflight = preflightFinetune(
      { datasetVersionId: version.id, format: 'sft' },
      { db: db() }
    )
    out(
      `preflight: ${preflight.ok ? 'ok' : 'blocked'} · ${preflight.stats.examples} examples (train ${preflight.stats.train}/val ${preflight.stats.val}/holdout ${preflight.stats.holdout}) · ` +
        `${preflight.stats.dropped} dropped · ${preflight.stats.duplicates} duplicates · ${preflight.stats.piiRedactions} PII redactions · ${preflight.stats.contamination} contaminated`
    )
    for (const check of preflight.checks.filter((entry) => !entry.ok)) {
      err(`  ✗ ${check.id}: ${check.message}`)
    }
    for (const warning of preflight.warnings) {
      err(`  ! ${warning}`)
    }
    if (preflight.ok) {
      const result = exportFinetune({ datasetVersionId: version.id, format: 'sft' }, { db: db() })
      exportPath = result.export.path
      out(
        `export ${result.export.id}: ${result.export.stats.examples} examples → ${result.export.path}`
      )
      out(`manifest: ${result.export.manifestPath}`)
      ftNote = 'exported SFT data (execution is external)'
    } else {
      ftNote = 'blocked by preflight'
    }
  } catch (error) {
    ftNote = `failed: ${errorMessage(error)}`
    err(`fine-tune export failed: ${errorMessage(error)}`)
  }
  banner('6/7 comparison')
  try {
    const comparison = compareRuns(baselineRun.id, candidateRun.id, { db: db() })
    out(`paired cases: ${comparison.overall.cases}`)
    out(
      `pass rate: ${formatPercent(comparison.overall.passRate.baseline)} → ${formatPercent(comparison.overall.passRate.candidate)} (${formatPp(comparison.overall.passRate.delta)}` +
        `${comparison.overall.passRate.ciLowPp !== undefined ? `, 95% CI ${formatPp(comparison.overall.passRate.ciLowPp)}…${formatPp(comparison.overall.passRate.ciHighPp ?? null)}` : ''})`
    )
    out(
      `cost/successful answer: ${formatUsd(comparison.overall.costPerPassUsd.baseline)} → ${formatUsd(comparison.overall.costPerPassUsd.candidate)} · ` +
        `p95: ${Math.round(comparison.overall.p95LatencyMs.baseline ?? 0)} ms → ${Math.round(comparison.overall.p95LatencyMs.candidate ?? 0)} ms`
    )
    out(
      `improved ${comparison.overall.improved} · regressed ${comparison.overall.regressed} · unchanged ${comparison.overall.unchanged}`
    )
    for (const slice of comparison.slices) {
      if (slice.regressed) {
        err(
          `  ! slice "${slice.slice}" regressed (${formatPp(slice.passRate.delta)} on ${slice.cases} cases)`
        )
      }
    }
  } catch (error) {
    err(`comparison error: ${errorMessage(error)}`)
  }
  banner('7/7 summary')
  const b = baselineRun.summary
  const c = candidateRun.summary
  out(
    `baseline   ${baseline.name}: ${formatPercent(b?.passRate ?? null)} pass · ${formatUsd(b?.costPerPassUsd ?? null)}/answer · p95 ${Math.round(b?.p95LatencyMs ?? 0)} ms`
  )
  out(
    `candidate  ${grounded.name}: ${formatPercent(c?.passRate ?? null)} pass · ${formatUsd(c?.costPerPassUsd ?? null)}/answer · p95 ${Math.round(c?.p95LatencyMs ?? 0)} ms`
  )
  out(
    `gate       ${gatePass ? 'PASS' : 'FAIL'}${gateResult ? ` — ${gateResult.result.failures.length} failure(s)` : ''}`
  )
  out(`fine-tune  ${ftNote}${exportPath ? ` → ${exportPath}` : ''}`)
  out('')
  out(
    'Honest limits: DeepSeek does not offer a fine-tuning endpoint. Stella produced validated data and a gate;'
  )
  out(
    'any training run happens externally (Unsloth/Axolotl/Together/OpenAI-compatible). Replay mode proves mechanics, not model quality.'
  )
  if (!gatePass) {
    err('')
    err(
      'demo failed: the release gate did not pass. See the review artifact above for the regression diff.'
    )
    return 1
  }
  return 0
}

const record = async (parsed: Parsed): Promise<number> => {
  if (!keyStatus().configured) {
    throw new BusinessError(
      'recording requires a live DeepSeek API key (DEEPSEEK_API_KEY in .env.local). Replay cassettes are recorded from real model calls; they cannot be invented.',
      'recording_requires_live_key',
      400
    )
  }
  const outDir = path.resolve(flag(parsed, 'out') ?? CASSETTE_DIR())
  mkdirSync(outDir, { recursive: true })
  const judge = judgeFromFlags(parsed, true)
  const seeded = await seedDemo({ quiet: true })
  const baseline = findProfileByName(DEMO_PROFILE_NAMES.baseline)
  const grounded = findProfileByName(DEMO_PROFILE_NAMES.improved)
  if (!baseline || !grounded) {
    throw new BusinessError(
      'demo profiles are missing; run `stella seed`',
      'seed_profiles_missing',
      400
    )
  }
  const budgetUsd = flagNumber(parsed, 'budget') ?? 0.5
  const concurrency = concurrencyFromFlags(parsed)
  const recording = createRecordingAdapters({ cassetteDir: outDir })
  const lexicalRetrieve = createReplayStableRetrieveAdapter()
  out(`recording cassettes to ${outDir} (live calls, budget cap ${formatUsd(budgetUsd)} per run)`)
  out(
    'note: replay cannot reproduce LLM rerank calls, so recording and replay both use lexical retrieval order;'
  )
  out(
    '      the recorded prompts are exactly what replay recomputes (mechanics, not a quality claim).'
  )
  for (const [label, profile] of [
    ['baseline', baseline],
    ['candidate', grounded],
  ] as const) {
    const created = createRun(
      {
        datasetVersionId: seeded.version.id,
        profileId: profile.id,
        budgetUsd,
        mode: 'live',
        config: { judge, calibration: judge },
      },
      { queue: false }
    )
    const finished = await executeRun(created.id, {
      concurrency,
      adapters: { ...recording, retrieve: lexicalRetrieve, mode: 'live' },
      ...(judge ? {} : { judge: false }),
    })
    out(`${label}: ${finished.status} — ${formatPercent(finished.summary?.passRate ?? null)} pass`)
  }
  const count = countCassettes(outDir) + countCassettes(path.join(outDir, 'json-schema'))
  if (count === 0) {
    throw new BusinessError(
      'no cassettes were written; check the API key and errors above',
      'recording_empty',
      500
    )
  }
  out(`recorded ${count} cassette(s) in ${outDir}`)
  out('replay now: stella demo --replay' + (judge ? ' --judge' : ''))
  return 0
}

/* ------------------------------ collections ------------------------------ */

const ingest = async (parsed: Parsed): Promise<number> => {
  const paths = parsed.positionals.slice(1)
  if (paths.length === 0) {
    throw new UsageError('usage: stella ingest <path-or-dir> [more paths] [--collection name]')
  }
  const collectionName = flag(parsed, 'collection') ?? 'meridian'
  const collection = await ensureCollection({ name: collectionName })
  const result = await ingestCorpusPaths({
    collectionId: collection.id,
    paths: paths.map((item) => path.resolve(item)),
  })
  if (isJson(parsed)) {
    printJson(result)
    return result.errors.length > 0 && result.documents.length === 0 ? 1 : 0
  }
  banner(`ingest → ${collection.name}`)
  for (const document of result.documents) {
    out(
      `  ${document.deduped ? 'updated' : 'added'} ${document.document.title} (${document.chunks} chunks)`
    )
  }
  for (const failure of result.errors) {
    err(`  failed ${failure.path}: ${failure.message}`)
  }
  out(`done: ${result.documents.length} documents, ${result.errors.length} errors`)
  return result.errors.length > 0 && result.documents.length === 0 ? 1 : 0
}

const search = async (parsed: Parsed): Promise<number> => {
  const query = parsed.positionals.slice(1).join(' ')
  if (query.trim().length === 0) {
    throw new UsageError('usage: stella search <query> [--collection name] [--k N]')
  }
  const collectionName = flag(parsed, 'collection') ?? 'meridian'
  const results = await searchCorpus({
    collectionId: collectionName,
    query,
    ...(flagNumber(parsed, 'k') !== null
      ? { k: Math.floor(flagNumber(parsed, 'k') as number) }
      : {}),
    ...(flag(parsed, 'rerank') === 'llm' ? { rerank: 'llm' } : {}),
  })
  if (isJson(parsed)) {
    printJson({ results })
    return 0
  }
  banner(`search "${query}" in ${collectionName}`)
  if (results.length === 0) {
    out('  no results')
  }
  for (const chunk of results) {
    out(
      `  [${chunk.id}] ${chunk.title}${chunk.heading ? ` — ${chunk.heading}` : ''} (score ${chunk.score.toFixed(3)})`
    )
    out(`      ${chunk.snippet.replace(/\s+/g, ' ').slice(0, 160)}`)
  }
  return 0
}

/* ------------------------------ dataset commands ------------------------------ */

const datasetCommand = async (parsed: Parsed): Promise<number> => {
  const action = parsed.positionals[1]
  switch (action) {
    case 'list': {
      const items = listDatasets()
      if (isJson(parsed)) {
        printJson({ items })
        return 0
      }
      banner('datasets')
      table(
        ['name', 'cases', 'latest', 'id'],
        items.map((item) => [
          item.name,
          String(item.caseCount),
          item.latestVersion === null ? '—' : `v${item.latestVersion}`,
          item.id,
        ])
      )
      return 0
    }
    case 'show': {
      const dataset = getDataset(requiredFlag(parsed, 'dataset'))
      const versions = listDatasetVersions(dataset.id)
      const queryVersion = flag(parsed, 'version')
      if (queryVersion !== null) {
        const version = /^\d+$/.test(queryVersion)
          ? (versions.find((entry) => entry.version === Number(queryVersion)) ??
            getDatasetVersionByNumber(dataset.id, Number(queryVersion)))
          : getDatasetVersion(queryVersion)
        const cases = readVersionCases(version)
        if (isJson(parsed)) {
          printJson({ dataset, version, cases })
          return 0
        }
        banner(`${dataset.name} v${version.version}`)
        out(`path ${version.path}`)
        out(`hash ${version.contentHash}`)
        out(
          `cases ${version.caseCount} · anchors ${version.anchorStatus.resolved}/${version.anchorStatus.total} resolved`
        )
        for (const missing of version.anchorStatus.missing) {
          err(`  missing anchor: ${missing}`)
        }
        for (const caseValue of cases.slice(0, 5)) {
          out(`  ${caseValue.id}: ${caseValue.messages[0]?.content.slice(0, 80) ?? ''}`)
        }
        if (cases.length > 5) {
          out(`  … ${cases.length - 5} more`)
        }
        return 0
      }
      if (isJson(parsed)) {
        printJson({ dataset, versions, draftCases: listDraftCases(dataset.id).length })
        return 0
      }
      banner(dataset.name)
      out(`id ${dataset.id} · ${dataset.caseCount} draft cases · ${versions.length} snapshot(s)`)
      out(`description ${dataset.description}`)
      for (const version of versions) {
        out(
          `  v${version.version} ${version.createdAt ? new Date(version.createdAt).toISOString() : ''} · ${version.caseCount} cases · anchors ${version.anchorStatus.resolved}/${version.anchorStatus.total} · ${version.path}`
        )
      }
      return 0
    }
    case 'import': {
      const dataset = getDataset(requiredFlag(parsed, 'dataset'))
      const file = requiredFlag(parsed, 'file')
      if (!existsSync(file)) {
        throw new UsageError(`file not found: ${file}`)
      }
      const result = importDatasetJsonl(dataset.id, readFileSync(file, 'utf8'))
      if (isJson(parsed)) {
        printJson({ imported: result.imported, skipped: result.skipped, issues: result.issues })
        return result.imported > 0 ? 0 : 1
      }
      out(`imported ${result.imported} case(s), ${result.skipped} skipped`)
      for (const issue of result.issues.slice(0, 10)) {
        err(`  line ${issue.line} ${issue.field}: ${issue.message}`)
      }
      return result.imported > 0 ? 0 : 1
    }
    case 'snapshot': {
      const ref = requiredFlag(parsed, 'dataset')
      const outcome = snapshotDataset(ref, { notes: flag(parsed, 'notes') ?? '' })
      if (isJson(parsed)) {
        printJson(outcome.version)
        return 0
      }
      banner(`snapshot ${outcome.manifest.name} v${outcome.version.version}`)
      out(
        `cases ${outcome.version.caseCount} · anchors ${outcome.version.anchorStatus.resolved}/${outcome.version.anchorStatus.total} resolved`
      )
      out(`file ${outcome.filePath}`)
      out(`hash ${outcome.version.contentHash}`)
      out(`manifest ${outcome.manifestPath}`)
      for (const missing of outcome.version.anchorStatus.missing.slice(0, 10)) {
        err(`  missing anchor: ${missing}`)
      }
      return 0
    }
    case 'export': {
      const ref = requiredFlag(parsed, 'dataset')
      const versionFlagValue = flag(parsed, 'version')
      const version =
        versionFlagValue !== null
          ? /^\d+$/.test(versionFlagValue)
            ? getDatasetVersionByNumber(ref, Number(versionFlagValue))
            : getDatasetVersion(versionFlagValue)
          : latestDatasetVersion(ref)
      const jsonl = exportDatasetVersionJsonl(version.id)
      const outFile = flag(parsed, 'out')
      if (outFile) {
        writeFileSync(outFile, jsonl, 'utf8')
        out(`wrote ${version.caseCount} cases (v${version.version}) to ${outFile}`)
      } else {
        process.stdout.write(jsonl)
      }
      return 0
    }
    case 'anchors': {
      const ref = requiredFlag(parsed, 'dataset')
      const version = resolveDatasetVersionFor(parsed, ref)
      const drift = flagBool(parsed, 'drift')
      if (drift) {
        const report = anchorDrift(ref, version.version)
        if (isJson(parsed)) {
          printJson(report)
          return report.ok ? 0 : 1
        }
        banner(`anchor drift ${report.datasetName} v${report.version}`)
        out(
          `stored  ${report.stored.resolved}/${report.stored.total} resolved (corpus ${report.corpusVersion.stored ?? 'unknown'})`
        )
        out(
          `current ${report.current.resolved}/${report.current.total} resolved (corpus ${report.corpusVersion.current})`
        )
        for (const entry of report.drifted) {
          err(
            `  ${entry.reason}: ${entry.caseId} ${entry.doc}${entry.heading ? `#${entry.heading}` : ''}`
          )
        }
        if (report.drifted.length === 0) {
          out('no drift')
        }
        for (const missing of report.current.missing) {
          err(`  unresolved: ${missing}`)
        }
        return report.ok ? 0 : 1
      }
      const cases = readVersionCases(version)
      const resolved = cases.map((caseValue) => ({
        caseId: caseValue.id,
        anchors: caseValue.expected.anchors,
      }))
      if (isJson(parsed)) {
        printJson({
          version: version.version,
          anchorStatus: version.anchorStatus,
          anchors: resolved,
        })
        return version.anchorStatus.missing.length === 0 ? 0 : 1
      }
      banner(`anchors ${ref} v${version.version}`)
      out(`${version.anchorStatus.resolved}/${version.anchorStatus.total} resolved`)
      for (const missing of version.anchorStatus.missing) {
        err(`  ${missing}`)
      }
      return version.anchorStatus.missing.length === 0 ? 0 : 1
    }
    case 'create': {
      const created = createDataset({
        name: requiredFlag(parsed, 'name'),
        description: flag(parsed, 'description') ?? '',
      })
      printJson(created)
      return 0
    }
    case undefined:
      err('usage: stella dataset list|show|create|import|snapshot|export|anchors [flags]')
      return 2
    default:
      throw new UsageError(`unknown dataset command: ${action}`)
  }
}

const resolveDatasetVersionFor = (parsed: Parsed, datasetRef: string): DatasetVersion => {
  const versionFlagValue = flag(parsed, 'version')
  if (versionFlagValue === null) {
    return latestDatasetVersion(datasetRef)
  }
  return /^\d+$/.test(versionFlagValue)
    ? getDatasetVersionByNumber(datasetRef, Number(versionFlagValue))
    : getDatasetVersion(versionFlagValue)
}

/* ------------------------------ eval commands ------------------------------ */

const evalRunCommand = async (parsed: Parsed): Promise<number> => {
  const version = resolveDatasetVersion(parsed)
  const profile = resolveProfile(parsed)
  const mode = modeFromFlags(parsed)
  const judge = judgeFromFlags(parsed, mode === 'live' && keyStatus().configured)
  const budgetUsd = flagNumber(parsed, 'budget') ?? 0
  const offPeak = flagBool(parsed, 'off-peak')
  if (mode === 'replay') {
    assertReplayReady(judge)
  }
  if (offPeak && isPeak(Date.now())) {
    const window = nextOffPeak(Date.now())
    const created = createRun(
      {
        datasetVersionId: version.id,
        profileId: profile.id,
        budgetUsd,
        mode,
        offPeak: true,
        config: { judge, calibration: judge },
      },
      { queue: true }
    )
    out(`off-peak scheduling requested; it is peak pricing now.`)
    out(`run ${created.id} is queued for ${new Date(window.start).toISOString()}.`)
    out(
      'Scheduled execution lives in the server process: run `stella serve` (or POST /api/runs with offPeak from the app).'
    )
    out('A one-shot CLI process exits, so use the API/server for a scheduled run.')
    return 0
  }
  const created = createRun(
    {
      datasetVersionId: version.id,
      profileId: profile.id,
      budgetUsd,
      mode,
      config: { judge, calibration: judge },
    },
    { queue: false }
  )
  const finished = await executeRun(created.id, { concurrency: concurrencyFromFlags(parsed) })
  if (isJson(parsed)) {
    printJson(finished)
    return finished.status === 'done' ? 0 : 1
  }
  printRun('eval', finished)
  if (finished.status === 'done' && finished.summary) {
    const items = getRunItems(finished.id)
    const failing = items.filter((item) => !item.pass).slice(0, 5)
    for (const item of failing) {
      err(
        `  ✗ ${item.caseId}: ${
          item.error ??
          item.graderResults
            .filter((result) => !result.pass)
            .map((result) => result.detail)
            .join('; ')
        }`
      )
    }
  }
  assertReplayRunUnsafe(finished)
  return finished.status === 'done' ? 0 : 1
}

const assertReplayRunUnsafe = (run: Run): void => {
  if (run.mode !== 'replay') {
    return
  }
  const misses = getRunItems(run.id).filter((item) =>
    (item.error ?? '').toLowerCase().includes('cassette missing')
  )
  if (misses.length > 0) {
    err(
      `warning: ${misses.length} replay cassette(s) missing — results are not evidence of model quality. Record with \`stella record\`.`
    )
  }
}

const evalCompareCommand = async (parsed: Parsed): Promise<number> => {
  const baseline = requiredFlag(parsed, 'baseline')
  const candidate = requiredFlag(parsed, 'candidate')
  const comparison = compareRuns(baseline, candidate, { db: db() })
  if (isJson(parsed)) {
    printJson(comparison)
    return 0
  }
  banner('run comparison')
  out(
    `baseline  ${comparison.baseline.profileName} (${comparison.baseline.id}) — ${formatPercent(comparison.baseline.summary?.passRate ?? null)} pass`
  )
  out(
    `candidate ${comparison.candidate.profileName} (${comparison.candidate.id}) — ${formatPercent(comparison.candidate.summary?.passRate ?? null)} pass`
  )
  out(`paired cases ${comparison.overall.cases}`)
  out(`pass rate delta ${formatPp(comparison.overall.passRate.delta)}`)
  out(
    `improved ${comparison.overall.improved} · regressed ${comparison.overall.regressed} · unchanged ${comparison.overall.unchanged}`
  )
  for (const slice of comparison.slices) {
    out(
      `  ${slice.regressed ? '⚠' : '·'} ${slice.slice}: ${formatPp(slice.passRate.delta)} (${slice.cases} cases)`
    )
  }
  return 0
}

const sweepCommand = async (parsed: Parsed): Promise<number> => {
  const version = resolveDatasetVersion(parsed)
  const profileNames = requiredFlag(parsed, 'profiles')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  if (profileNames.length === 0) {
    throw new UsageError('--profiles requires at least one profile name')
  }
  const mode = modeFromFlags(parsed)
  const judge = judgeFromFlags(parsed, mode === 'live' && keyStatus().configured)
  const budgetUsd = flagNumber(parsed, 'budget') ?? 0.5
  if (mode === 'replay') {
    assertReplayReady(judge)
  }
  banner(`sweep — dataset ${version.path}, ${profileNames.length} profiles`)
  const rows: string[][] = []
  let failures = 0
  for (const name of profileNames) {
    let profile: Profile
    try {
      profile = getProfileByName(name)
    } catch {
      err(`  profile not found: ${name}`)
      failures += 1
      continue
    }
    const created = createRun(
      {
        datasetVersionId: version.id,
        profileId: profile.id,
        budgetUsd,
        mode,
        config: { judge, calibration: judge },
      },
      { queue: false }
    )
    const finished = await executeRun(created.id, { concurrency: concurrencyFromFlags(parsed) })
    const summary = finished.summary
    rows.push([
      profile.name,
      finished.id,
      finished.status,
      formatPercent(summary?.passRate ?? null),
      formatUsd(summary?.costPerPassUsd ?? null),
      `${Math.round(summary?.p95LatencyMs ?? 0)} ms`,
    ])
    if (finished.status !== 'done') {
      failures += 1
    }
  }
  table(['profile', 'run', 'status', 'pass', 'cost/answer', 'p95'], rows)
  return failures === 0 ? 0 : 1
}

const evalCommand = async (parsed: Parsed): Promise<number> => {
  const action = parsed.positionals[1]
  switch (action) {
    case 'run':
      return evalRunCommand(parsed)
    case 'compare':
      return evalCompareCommand(parsed)
    case 'list': {
      const runs = listRuns({ limit: 20 })
      if (isJson(parsed)) {
        printJson({ items: runs })
        return 0
      }
      banner('runs')
      table(
        ['run', 'status', 'dataset', 'profile', 'pass'],
        runs.map((run) => [
          run.id,
          run.status,
          `${run.datasetName} v${run.datasetVersion}`,
          run.profileName,
          formatPercent(run.summary?.passRate ?? null),
        ])
      )
      return 0
    }
    case 'items': {
      const items = getRunItems(requiredFlag(parsed, 'run'))
      if (isJson(parsed)) {
        printJson({ items })
        return 0
      }
      banner(`run items ${requiredFlag(parsed, 'run')}`)
      table(
        ['case', 'status', 'pass', 'cost', 'latency'],
        items.map((item) => [
          item.caseId,
          item.status,
          item.pass ? 'yes' : 'no',
          formatUsd(item.costUsd),
          `${item.latencyMs} ms`,
        ])
      )
      return 0
    }
    case undefined:
      err('usage: stella eval run|compare|list|items [flags]')
      return 2
    default:
      throw new UsageError(`unknown eval command: ${action}`)
  }
}

/* ------------------------------ gate ------------------------------ */

const gateCommand = async (parsed: Parsed): Promise<number> => {
  const baselineRunId = requiredFlag(parsed, 'baseline')
  const candidateRunId = requiredFlag(parsed, 'candidate')
  const configFile = flag(parsed, 'config')
  const overrideReason = flag(parsed, 'override-reason')
  const overrideBy = flag(parsed, 'override-by')
  const loaded = loadGateConfig(configFile !== null ? { file: configFile } : {})
  const gate = createGate(
    {
      baselineRunId,
      candidateRunId,
      config: loaded.config,
      configPath: loaded.path,
      configHash: loaded.hash,
      dataDir: config.dataDir,
      ...(overrideReason !== null
        ? {
            override: {
              reason: overrideReason,
              ...(overrideBy !== null ? { by: overrideBy } : {}),
            },
          }
        : {}),
    },
    { db: db() }
  )
  if (isJson(parsed)) {
    printJson(gate)
    return gate.result.pass ? 0 : 1
  }
  banner(`gate ${gate.result.pass ? 'PASS' : 'FAIL'} (${gate.result.verdict})`)
  out(`suite ${gate.config.suite} · baseline ${baselineRunId} → candidate ${candidateRunId}`)
  out(`config ${loaded.path ?? 'built-in defaults'} (${loaded.hash})`)
  if (gate.result.override) {
    out(`override by ${gate.result.override.by ?? 'unknown'}: ${gate.result.override.reason}`)
  }
  for (const failure of gate.result.failures) {
    err(`  ✗ ${failure.rule}: ${failure.message}`)
  }
  for (const warning of gate.result.warnings) {
    err(`  ! ${warning}`)
  }
  out(`artifacts`)
  out(`  ${gate.artifacts.mdPath}`)
  out(`  ${gate.artifacts.jsonPath}`)
  out(`  ${gate.artifacts.htmlPath}`)
  return gate.result.pass ? 0 : 1
}

/* ------------------------------ fine-tune ------------------------------ */

const finetuneFormatFlag = (parsed: Parsed): FinetuneFormat => {
  const format = flag(parsed, 'format') ?? 'sft'
  if (!FINETUNE_FORMATS.includes(format as FinetuneFormat)) {
    throw new UsageError(`--format must be one of ${FINETUNE_FORMATS.join(', ')}`)
  }
  return format as FinetuneFormat
}

const finetuneProviderFlag = (parsed: Parsed): FinetuneProviderId => {
  const provider = requiredFlag(parsed, 'provider') as FinetuneProviderId
  if (!FINETUNE_PROVIDERS.includes(provider)) {
    throw new UsageError(`--provider must be one of ${FINETUNE_PROVIDERS.join(', ')}`)
  }
  return provider
}

const finetuneCommand = async (parsed: Parsed): Promise<number> => {
  const action = parsed.positionals[1]
  switch (action) {
    case 'preflight': {
      const version = resolveDatasetVersion(parsed)
      const report = preflightFinetune({
        datasetVersionId: version.id,
        format: finetuneFormatFlag(parsed),
        ...(defaultFiltersForSuite(parsed) !== undefined
          ? { filters: defaultFiltersForSuite(parsed) }
          : {}),
      })
      if (isJson(parsed)) {
        printJson(report)
        return report.ok ? 0 : 1
      }
      banner(`fine-tune preflight — ${report.format}`)
      out(
        `examples ${report.stats.examples} (train ${report.stats.train}/val ${report.stats.val}/holdout ${report.stats.holdout}) · ` +
          `dropped ${report.stats.dropped} · duplicates ${report.stats.duplicates} · PII ${report.stats.piiRedactions} · contamination ${report.stats.contamination}`
      )
      out(`estimated tokens ${report.stats.estimatedTokens}`)
      for (const check of report.checks) {
        out(`  ${check.ok ? '✓' : '✗'} ${check.id}: ${check.message}`)
      }
      for (const warning of report.warnings) {
        err(`  ! ${warning}`)
      }
      out(
        report.ok
          ? 'preflight OK — export is safe'
          : `preflight BLOCKED: ${report.failures.join('; ')}`
      )
      return report.ok ? 0 : 1
    }
    case 'export': {
      const version = resolveDatasetVersion(parsed)
      const result = exportFinetune({
        datasetVersionId: version.id,
        format: finetuneFormatFlag(parsed),
        ...(defaultFiltersForSuite(parsed) !== undefined
          ? { filters: defaultFiltersForSuite(parsed) }
          : {}),
      })
      if (isJson(parsed)) {
        printJson(result.export)
        return 0
      }
      banner(`fine-tune export ${result.export.id}`)
      out(
        `examples ${result.export.stats.examples} (train ${result.export.stats.train}/val ${result.export.stats.val}/holdout ${result.export.stats.holdout})`
      )
      out(`dir      ${result.export.path}`)
      out(`manifest ${result.export.manifestPath}`)
      for (const note of result.manifest.notes) {
        err(`  note: ${note}`)
      }
      return 0
    }
    case 'plan': {
      const exportId = requiredFlag(parsed, 'export')
      const provider = finetuneProviderFlag(parsed)
      const plan = planFinetune({
        exportId,
        provider,
        ...(flag(parsed, 'base-model') !== null
          ? { baseModel: requiredFlag(parsed, 'base-model') }
          : {}),
      })
      if (isJson(parsed)) {
        printJson(plan)
        return plan.available ? 0 : 1
      }
      banner(`fine-tune plan — ${plan.provider}`)
      out(
        `dataset ${plan.dataset.name} v${plan.dataset.version} · export ${plan.exportId} · base model ${plan.baseModel}`
      )
      if (!plan.available) {
        err(`unavailable: ${plan.reason ?? 'provider unavailable'}`)
        for (const docs of plan.docs) {
          err(`docs: ${docs}`)
        }
        return 1
      }
      out(`plan (${plan.planFormat}):`)
      out(plan.plan ?? '')
      for (const note of plan.notes) {
        err(`note: ${note}`)
      }
      return 0
    }
    case 'job': {
      const provider = finetuneProviderFlag(parsed)
      if (provider === 'deepseek') {
        throw new BusinessError(
          `DeepSeek does not offer fine-tuning. Nothing was submitted. Docs: ${DEEPSEEK_FINETUNE_DOCS}`,
          'not_offered_by_deepseek',
          400
        )
      }
      const job = await createFinetuneJob(
        {
          exportId: requiredFlag(parsed, 'export'),
          provider,
          ...(flag(parsed, 'base-model') !== null
            ? { baseModel: requiredFlag(parsed, 'base-model') }
            : {}),
        },
        {
          db: db(),
          ...(flag(parsed, 'base-url') !== null
            ? { transport: { baseUrl: requiredFlag(parsed, 'base-url') } }
            : {}),
        }
      )
      if (isJson(parsed)) {
        printJson(job)
        return 0
      }
      banner(`fine-tune job ${job.id}`)
      out(
        `provider ${job.provider} · base model ${job.baseModel} · status ${job.status}${job.externalId ? ` · external ${job.externalId}` : ''}`
      )
      if (job.error) {
        err(`error: ${job.error}`)
      }
      return 0
    }
    case 'jobs': {
      const jobs = listFinetuneJobs({ limit: 20 })
      if (isJson(parsed)) {
        printJson({ items: jobs })
        return 0
      }
      banner('fine-tune jobs')
      table(
        ['job', 'provider', 'model', 'status', 'external'],
        jobs.map((job) => [job.id, job.provider, job.baseModel, job.status, job.externalId ?? '—'])
      )
      return 0
    }
    case 'poll': {
      const job = await refreshFinetuneJob(requiredFlag(parsed, 'job'), { db: db() })
      printJson(job)
      return 0
    }
    case 'exports': {
      const exports = listFinetuneExports({ limit: 20 })
      if (isJson(parsed)) {
        printJson({ items: exports })
        return 0
      }
      banner('fine-tune exports')
      table(
        ['export', 'dataset', 'format', 'examples', 'created'],
        exports.map((entry) => [
          entry.id,
          `${entry.datasetName} v${entry.datasetVersion}`,
          entry.format,
          String(entry.stats.examples),
          new Date(entry.createdAt).toISOString(),
        ])
      )
      return 0
    }
    case undefined:
      err('usage: stella finetune preflight|export|plan|job|poll|exports|jobs [flags]')
      return 2
    default:
      throw new UsageError(`unknown finetune command: ${action}`)
  }
}

/* ------------------------------ help / main ------------------------------ */

const help = `stella — local-first quality workbench for DeepSeek assistants

Usage: stella <command> [subcommand] [options]

Loop commands
  seed                        Create/refresh the demo collection, dataset snapshot and profiles
  demo [--replay] [--judge]   End-to-end demo: seed → baseline → candidate → gate → FT export
  record [--judge] [--out D]  Record replay cassettes from live model calls (needs a key)
  doctor                      Check Node, paths, database and API key configuration
  serve                       Start the Stella server (default http://127.0.0.1:8787)

Data and retrieval
  ingest <path...> [--collection name]
  search <query> [--collection name] [--k N] [--rerank llm]
  dataset list|show|create|import|snapshot|export|anchors

Evaluation
  eval run --dataset <name> [--version N] --profile <id|name> [--budget USD] [--judge] [--replay|--live] [--off-peak]
  eval compare --baseline <runId> --candidate <runId>
  eval list | eval items --run <runId>
  sweep --dataset <name> [--version N] --profiles "a,b" [--budget USD]
  gate --baseline <runId> --candidate <runId> [--config stella.gate.json] [--override-reason "..."] [--override-by name]

Fine-tuning
  finetune preflight --dataset <name> [--version N] --format sft|sharegpt|dpo [--eval-suite name] [--run-ids id,id]
  finetune export    --dataset <name> [--version N] --format sft|sharegpt|dpo [same filters]
  finetune plan --export <id> --provider ${FINETUNE_PROVIDERS.join('|')} [--base-model name]
  finetune job  --export <id> --provider together|openai-compatible [--base-url URL] [--base-model name]
  finetune poll --job <id> | finetune exports | finetune jobs

Global flags: --json (machine-readable output), --help
Exit codes: 0 pass/success · 1 gate fail or business failure · 2 usage/config error

DeepSeek does not offer a fine-tuning endpoint: Stella produces validated data and plans; training runs externally.
`

const main = async (): Promise<number> => {
  const parsed = parseArgs(process.argv.slice(2))
  const [command, subcommand] = parsed.positionals
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(help)
      return 0
    case 'version':
      out(config.version)
      return 0
    case 'doctor':
      return doctor()
    case 'serve':
      return serve()
    case 'seed':
      return seedCommand(parsed)
    case 'demo':
      return demo(parsed)
    case 'record':
      return record(parsed)
    case 'ingest':
      return ingest(parsed)
    case 'search':
      return search(parsed)
    case 'dataset':
      return datasetCommand(parsed)
    case 'eval':
      return evalCommand(parsed)
    case 'sweep':
      return sweepCommand(parsed)
    case 'gate':
      return gateCommand(parsed)
    case 'finetune':
      return finetuneCommand(parsed)
    default:
      err(`stella: unknown command "${command}"${subcommand ? ` ${subcommand}` : ''}`)
      err(help)
      return 2
  }
}

main()
  .then((code) => {
    if (code !== 0) {
      process.exit(code)
    }
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      err(`stella: ${error.message}`)
      process.exit(2)
    }
    if (error instanceof BusinessError) {
      err(`stella: ${error.message}`)
      if (error.code === 'finetune_preflight_failed') {
        err('run `stella finetune preflight ...` to see the individual checks')
      }
      process.exit(1)
    }
    err(`stella: ${errorMessage(error)}`)
    process.exit(1)
  })
