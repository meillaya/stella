import { config } from './config.ts'

type Level = 'debug' | 'info' | 'warn' | 'error'

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = order[(config.logLevel as Level) in order ? (config.logLevel as Level) : 'info']

const write = (level: Level, message: string, detail?: unknown): void => {
  if (order[level] < threshold) return
  const line = `/stella/ ${level.toUpperCase()} ${message}${detail === undefined ? '' : ` ${safe(detail)}`}`
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`)
  else process.stdout.write(`${line}\n`)
}

const safe = (value: unknown): string => {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text
  } catch {
    return String(value)
  }
}

export const log = {
  debug: (message: string, detail?: unknown) => write('debug', message, detail),
  info: (message: string, detail?: unknown) => write('info', message, detail),
  warn: (message: string, detail?: unknown) => write('warn', message, detail),
  error: (message: string, detail?: unknown) => write('error', message, detail),
}

/** Redact secrets before logging a request or error payload. */
export const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (/key|authorization|token|secret/i.test(key)) out[key] = '[redacted]'
      else out[key] = redact(entry)
    }
    return out
  }
  return value
}
