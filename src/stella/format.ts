/** Presentation helpers for the Stella workbench. */

export const formatDate = (timestamp: number | null | undefined): string => {
  if (!timestamp) return '—'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

export const formatDateOnly = (timestamp: number | null | undefined): string => {
  if (!timestamp) return '—'
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(
    timestamp
  )
}

export const formatRelative = (timestamp: number | null | undefined, now = Date.now()): string => {
  if (!timestamp) return '—'
  const delta = Math.round((now - timestamp) / 1000)
  if (Math.abs(delta) < 60) return 'just now'
  const minutes = Math.round(delta / 60)
  if (Math.abs(minutes) < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 30) return `${days}d ago`
  return formatDateOnly(timestamp)
}

export const formatDuration = (milliseconds: number | null | undefined): string => {
  if (milliseconds == null || !Number.isFinite(milliseconds)) return '—'
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1000)}s`
}

export const shortId = (id: string | null | undefined): string =>
  id ? (id.length > 14 ? id.slice(0, 6) + '…' + id.slice(-4) : id) : '—'

export const percent = (value: number | null | undefined, digits = 1): string =>
  value == null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(digits)}%`

export const pp = (value: number | null | undefined, digits = 1): string => {
  if (value == null || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(digits)} pp`
}

export const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text

export const pluralize = (count: number, singular: string, plural?: string): string =>
  `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`

export const clamp = (value: number, min = 0, max = 1): number =>
  Math.min(max, Math.max(min, value))
