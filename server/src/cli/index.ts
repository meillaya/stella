import { config, keyStatus } from '../config.ts'
import { getDb, getSetting } from '../db/index.ts'

const help = `stella — local-first quality workbench for DeepSeek assistants

Usage: stella <command> [options]

  serve                 Start the Stella server (default http://127.0.0.1:8787)
  doctor                Check Node, paths, database and API key configuration
  ingest <path|url>     Ingest documents into a collection
  search <query>        Search a collection
  eval run|compare      Run or compare evaluations
  gate                  Evaluate a release gate and write the review artifact
  dataset snapshot      Snapshot a dataset version
  finetune export       Build a validated fine-tuning export
  demo                  Run the end-to-end demo
  record                Record replay cassettes
`

const flags = (args: string[]): Map<string, string | true> => {
  const result = new Map<string, string | true>()
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = args[i + 1]
    if (next && !next.startsWith('--')) {
      result.set(key, next)
      i += 1
    } else {
      result.set(key, true)
    }
  }
  return result
}

const doctor = (): number => {
  const db = getDb()
  const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined
  const counts = {
    collections: (db.prepare('SELECT COUNT(*) AS n FROM collections').get() as { n: number }).n,
    traces: (db.prepare('SELECT COUNT(*) AS n FROM traces').get() as { n: number }).n,
    runs: (db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n,
  }
  const key = keyStatus()
  process.stdout.write(
    [
      `Stella ${config.version} on Node ${process.version}`,
      `root       ${config.root}`,
      `database   ${config.dbPath} (schema ${version?.value ?? 'unknown'})`,
      `data       ${config.dataDir}`,
      `mode       ${config.mode}`,
      `bind       ${config.host}:${config.port}`,
      `deepseek   ${config.deepseekBaseUrl}`,
      `api key    ${key.configured ? `configured (…${key.lastFour}, ${key.source})` : 'missing → set DEEPSEEK_API_KEY in .env.local'}`,
      `records    ${counts.collections} collections, ${counts.traces} traces, ${counts.runs} runs`,
      `profile    ${getSetting('active_profile_id') ?? 'none'}`,
    ].join('\n') + '\n'
  )
  return 0
}

const main = async (): Promise<number> => {
  const [command, ...rest] = process.argv.slice(2)
  const options = flags(rest)
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(help)
      return 0
    case 'doctor':
      return doctor()
    case 'serve': {
      const { startServer } = await import('../index.ts')
      await startServer()
      return 0
    }
    case 'version':
      process.stdout.write(`${config.version}\n`)
      return 0
    default:
      process.stderr.write(`stella: command "${command}" is not implemented yet (${[...options.keys()].join(', ') || 'no flags'}).\n`)
      process.stderr.write(help)
      return 1
  }
}

main()
  .then((code) => {
    if (code !== 0) process.exit(code)
  })
  .catch((error: unknown) => {
    process.stderr.write(`stella: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
