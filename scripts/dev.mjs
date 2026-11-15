import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bin = (name) => path.join(root, 'node_modules', '.bin', name)

const children = []
const run = (label, command, args, env = {}) => {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  child.on('exit', (code) => {
    if (code !== 0 && !stopping) {
      console.error(`[dev] ${label} exited with ${code}`)
      stop(code ?? 1)
    }
  })
  children.push(child)
  return child
}

let stopping = false
const stop = (code = 0) => {
  if (stopping) {return}
  stopping = true
  for (const child of children) {
    child.kill('SIGTERM')
  }
  setTimeout(() => process.exit(code), 150)
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

console.log('[dev] server  http://127.0.0.1:8787')
console.log('[dev] app     http://127.0.0.1:8090  (rspack dev server proxies /api, /models, /anthropic, /v1)')

run('server', process.execPath, ['--watch', 'server/src/index.ts'], { STELLA_DEV: '1' })
run('app', bin('rspack'), ['serve', '-c', 'rspack.config.ts'])
