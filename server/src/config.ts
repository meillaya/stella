import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const loadedFrom = new Set<string>()

/** Minimal .env loader. Existing process.env values always win. */
const loadEnv = (file: string): void => {
  if (!existsSync(file)) return
  const text = readFileSync(file, 'utf8')
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1] as string
    let value = match[2] ?? ''
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) {
      process.env[key] = value
      loadedFrom.add(key)
    }
  }
}

loadEnv(path.join(ROOT, '.env.local'))
loadEnv(path.join(ROOT, '.env'))

const env = process.env
const bool = (value: string | undefined, fallback = false): boolean =>
  value === undefined ? fallback : value === '1' || value.toLowerCase() === 'true'

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

const dataDir = path.resolve(ROOT, env.STELLA_DATA_DIR ?? 'data')
const apiKey = env.DEEPSEEK_API_KEY?.trim() || null

export const config = {
  root: ROOT,
  name: 'stella',
  version: '0.1.0',
  host: env.STELLA_HOST ?? '127.0.0.1',
  port: int(env.STELLA_PORT, 8787),
  dataDir,
  dbPath: path.resolve(dataDir, 'stella.db'),
  distDir: path.resolve(ROOT, 'dist'),
  corpusDir: path.resolve(ROOT, 'corpus'),
  datasetsDir: path.resolve(ROOT, 'datasets'),
  fixturesDir: path.resolve(ROOT, 'fixtures'),
  deepseekBaseUrl: (env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
  apiKey,
  keySource: apiKey ? (loadedFrom.has('DEEPSEEK_API_KEY') ? 'file' : 'env') : 'none',
  accessToken: env.STELLA_ACCESS_TOKEN?.trim() || null,
  mode: env.STELLA_MODE === 'replay' ? 'replay' : 'live',
  traceRetentionDays: int(env.STELLA_TRACE_RETENTION_DAYS, 30),
  runConcurrency: int(env.STELLA_RUN_CONCURRENCY, 4),
  judgeConcurrency: int(env.STELLA_JUDGE_CONCURRENCY, 4),
  isDev: bool(env.STELLA_DEV),
  logLevel: env.STELLA_LOG ?? 'info',
  bodyLimitBytes: int(env.STELLA_BODY_LIMIT, 32 * 1024 * 1024),
} as const

export const ensureDataDirs = (): void => {
  for (const dir of ['', 'runs', 'finetune', 'cassettes', 'uploads', 'exports']) {
    mkdirSync(path.join(config.dataDir, dir), { recursive: true })
  }
}

export type KeyStatus = {
  configured: boolean
  source: 'env' | 'file' | 'none'
  lastFour: string | null
  baseUrl: string
}

export const keyStatus = (): KeyStatus => ({
  configured: Boolean(config.apiKey),
  source: config.keySource,
  lastFour: config.apiKey ? config.apiKey.slice(-4) : null,
  baseUrl: config.deepseekBaseUrl,
})

export const isLoopback = (address: string | undefined): boolean =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'

ensureDataDirs()
