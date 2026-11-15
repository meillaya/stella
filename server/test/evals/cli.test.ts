import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const root = path.resolve(import.meta.dirname, '../../..')
const cli = path.join(root, 'server/src/cli/index.ts')

type CliResult = { status: number | null; stdout: string; stderr: string }

const runCli = (args: string[], env: Record<string, string> = {}): CliResult => {
  const baseEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      baseEnv[key] = value
    }
  }
  // Tests must never see the developer's .env.local key.
  baseEnv.DEEPSEEK_API_KEY = ''
  delete baseEnv.STELLA_MODE
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...baseEnv, STELLA_MODE: 'replay', ...env },
    timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('CLI help and version exit 0', () => {
  const help = runCli(['help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Usage: stella <command>/)
  assert.match(help.stdout, /does not offer a fine-tuning endpoint/i)

  const version = runCli(['version'])
  assert.equal(version.status, 0)
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/)
})

test('CLI doctor works headless against a temp data dir', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'stella-cli-doctor-'))
  try {
    const result = runCli(['doctor'], { STELLA_DATA_DIR: dataDir })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /Stella \d+\.\d+\.\d+ on Node/)
    assert.match(result.stdout, /database .*stella\.db/)
    assert.match(result.stdout, /datasets/)
    assert.match(result.stdout, /active/)
    const empty = runCli(['dataset', 'list'], { STELLA_DATA_DIR: dataDir })
    assert.equal(empty.status, 0)
    assert.match(empty.stdout, /datasets/)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('CLI returns exit code 2 for usage errors', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'stella-cli-usage-'))
  try {
    const env = { STELLA_DATA_DIR: dataDir }
    const unknown = runCli(['definitely-not-a-command'], env)
    assert.equal(unknown.status, 2)
    assert.match(unknown.stderr, /unknown command/)

    const gate = runCli(['gate', '--baseline', 'run_1'], env)
    assert.equal(gate.status, 2)
    assert.match(gate.stderr, /--candidate is required/)

    const evalRun = runCli(['eval', 'run'], env)
    assert.equal(evalRun.status, 2)
    assert.match(evalRun.stderr, /--dataset|--version-id/)

    const plan = runCli(['finetune', 'plan', '--export', 'ft_1', '--provider', 'nope'], env)
    assert.equal(plan.status, 2)
    assert.match(plan.stderr, /--provider must be one of/)

    const snapshot = runCli(['dataset', 'snapshot'], env)
    assert.equal(snapshot.status, 2)
    assert.match(snapshot.stderr, /--dataset is required/)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('CLI returns exit code 1 for business failures with actionable messages', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'stella-cli-business-'))
  try {
    const env = { STELLA_DATA_DIR: dataDir }
    const missingDataset = runCli(['eval', 'run', '--dataset', 'support', '--profile', 'x'], env)
    assert.equal(missingDataset.status, 1)
    assert.match(missingDataset.stderr, /dataset not found: support/)

    const replay = runCli(['demo', '--replay'], env)
    assert.equal(replay.status, 1)
    assert.match(replay.stderr, /replay mode requires cassettes/)
    assert.match(replay.stderr, /stella record/)

    const live = runCli(['demo', '--live'], env)
    assert.equal(live.status, 1)
    assert.match(live.stderr, /live demo requires DEEPSEEK_API_KEY/)

    const record = runCli(['record'], env)
    assert.equal(record.status, 1)
    assert.match(record.stderr, /requires a live DeepSeek API key/)

    const deepseekJob = runCli(
      ['finetune', 'job', '--export', 'ft_missing', '--provider', 'deepseek'],
      env
    )
    assert.equal(deepseekJob.status, 1)
    assert.match(deepseekJob.stderr, /does not offer fine-tuning/)

    const gate = runCli(['gate', '--baseline', 'run_a', '--candidate', 'run_b'], env)
    assert.equal(gate.status, 1)
    assert.match(gate.stderr, /run not found/)

    const retry = runCli(['doctor'], env)
    assert.equal(retry.status, 0)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
