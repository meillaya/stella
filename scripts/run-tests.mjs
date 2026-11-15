import { readdirSync, statSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const roots = ['server/test', 'test']
const files = []

const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full)
    } else if (entry.endsWith('.test.ts') || entry.endsWith('.test.mjs')) {
      files.push(path.relative(root, full))
    }
  }
}

for (const dir of roots) {
  const full = path.join(root, dir)
  if (existsSync(full)) {walk(full)}
}

if (files.length === 0) {
  console.log('[test] no tests yet')
  process.exit(0)
}

console.log(`[test] ${files.length} file(s)`)
const env = { ...process.env, DEEPSEEK_API_KEY: '' }
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', env })
process.exit(result.status ?? 1)
