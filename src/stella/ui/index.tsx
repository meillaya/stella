import clsx from 'clsx'
import type { ReactNode } from 'react'
import { IconChevronLeft, IconStar } from './icons.js'

export type Tone = 'pass' | 'fail' | 'warn' | 'info' | 'neutral'

export const Page = ({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) => (
  <div className={clsx('st-page', className)}>
    <div className="st-page-inner">{children}</div>
  </div>
)

export const PageHeader = ({
  title,
  description,
  actions,
  meta,
  back,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  meta?: ReactNode
  back?: { label: string; onClick: () => void }
}) => (
  <header>
    {back ? (
      <button type="button" className="st-back" onClick={back.onClick}>
        <IconChevronLeft />
        {back.label}
      </button>
    ) : null}
    <div className="st-page-header">
      <div>
        <h1 className="st-page-title">{title}</h1>
        {description ? <p className="st-page-desc">{description}</p> : null}
        {meta ? <div className="st-row st-wrap" style={{ marginTop: 12 }}>{meta}</div> : null}
      </div>
      {actions ? <div className="st-page-actions">{actions}</div> : null}
    </div>
  </header>
)

export const Card = ({
  title,
  subtitle,
  actions,
  children,
  footer,
  flush = false,
  className,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  flush?: boolean
  className?: string
}) => (
  <section className={clsx('st-card', className)}>
    {title || actions ? (
      <div className="st-card-head">
        <div>
          <div className="st-card-title">{title}</div>
          {subtitle ? <div className="st-card-sub">{subtitle}</div> : null}
        </div>
        {actions}
      </div>
    ) : null}
    {children ? <div className={clsx('st-card-body', flush && 'st-card-body-flush')}>{children}</div> : null}
    {footer ? <div className="st-card-foot">{footer}</div> : null}
  </section>
)

export const Badge = ({
  tone = 'neutral',
  dot = false,
  outline = false,
  children,
  title,
}: {
  tone?: Tone
  dot?: boolean
  outline?: boolean
  children: ReactNode
  title?: string
}) => (
  <span
    className={clsx('st-badge', outline && 'st-badge-outline')}
    data-tone={outline ? undefined : tone}
    title={title}
  >
    {dot ? <span className="st-badge-dot" /> : null}
    {children}
  </span>
)

export const Stat = ({
  label,
  value,
  foot,
  delta,
  spark,
}: {
  label: string
  value: ReactNode
  foot?: ReactNode
  delta?: ReactNode
  spark?: ReactNode
}) => (
  <div className="st-stat">
    <div className="st-row-between">
      <span className="st-stat-label">{label}</span>
      {spark}
    </div>
    <div className="st-stat-value">{value}</div>
    {foot || delta ? (
      <div className="st-stat-foot">
        {delta}
        {foot}
      </div>
    ) : null}
  </div>
)

export const Delta = ({
  value,
  suffix = 'pp',
  goodWhenPositive = true,
  digits = 1,
}: {
  value: number | null | undefined
  suffix?: string
  goodWhenPositive?: boolean
  digits?: number
}) => {
  if (value == null || !Number.isFinite(value)) return <span className="st-delta" data-tone="flat">—</span>
  const good = value === 0 ? 'flat' : value > 0 === goodWhenPositive ? 'good' : 'bad'
  const sign = value > 0 ? '+' : ''
  return (
    <span className="st-delta" data-tone={good}>
      {sign}
      {value.toFixed(digits)}
      {suffix ? <span className="st-faint"> {suffix}</span> : null}
    </span>
  )
}

/** The Stella bar: point estimate plus its confidence interval and a threshold tick. */
export const StellaBar = ({
  value,
  low,
  high,
  threshold,
  format = (input: number) => `${Math.round(input * 100)}%`,
  caption,
  compact = false,
}: {
  value: number
  low?: number
  high?: number
  threshold?: number
  format?: (value: number) => string
  caption?: ReactNode
  compact?: boolean
}) => {
  const clamp = (input: number) => Math.min(1, Math.max(0, input))
  const point = clamp(value)
  const lo = clamp(low ?? point)
  const hi = clamp(high ?? point)
  return (
    <div className="st-bar">
      <div
        className="st-bar-track"
        role="img"
        aria-label={`${format(point)}${low != null && high != null ? `, 95% interval ${format(lo)} to ${format(hi)}` : ''}`}
      >
        {low != null && high != null ? (
          <span className="st-bar-ci" style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }} />
        ) : null}
        {threshold != null ? (
          <span className="st-bar-threshold" style={{ left: `${clamp(threshold) * 100}%` }} />
        ) : null}
        <span className="st-bar-value" style={{ left: `${point * 100}%` }} />
      </div>
      {compact ? null : (
        <div className="st-bar-labels">
          <span>{format(lo)}</span>
          {caption ? <span className="st-bar-caption">{caption}</span> : <span>95% CI</span>}
          <span>{format(hi)}</span>
        </div>
      )}
    </div>
  )
}

export const Sparkline = ({
  values,
  width = 84,
  height = 26,
  ariaLabel,
}: {
  values: number[]
  width?: number
  height?: number
  ariaLabel?: string
}) => {
  if (values.length === 0) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const step = values.length > 1 ? width / (values.length - 1) : width
  const points = values.map((value, index) => {
    const x = values.length > 1 ? index * step : width
    const y = height - ((value - min) / span) * (height - 4) - 2
    return [x, y] as const
  })
  const path = points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const last = points.at(-1)
  return (
    <svg
      className="st-spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel}
    >
      <path d={path} fill="none" stroke="var(--st-blue)" strokeWidth="1.5" strokeLinecap="round" />
      {last ? <circle cx={last[0]} cy={last[1]} r="2.4" fill="var(--st-blue)" /> : null}
    </svg>
  )
}

export type Column<T> = {
  key: string
  header: ReactNode
  width?: number | string
  align?: 'left' | 'right'
  render: (row: T) => ReactNode
}

export const DataTable = <T,>({
  columns,
  rows,
  getKey,
  onRowClick,
  empty,
  loading = false,
  ariaLabel,
  footer,
}: {
  columns: Column<T>[]
  rows: T[]
  getKey: (row: T) => string
  onRowClick?: (row: T) => void
  empty?: ReactNode
  loading?: boolean
  ariaLabel?: string
  footer?: ReactNode
}) => {
  if (loading) {
    return (
      <div className="st-table-wrap" aria-busy="true">
        <div style={{ padding: 20, display: 'grid', gap: 14 }}>
          {[0, 1, 2, 3, 4].map((item) => (
            <div key={item} className="st-skeleton" style={{ width: `${92 - item * 9}%` }} />
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="st-table-wrap">
      <table className="st-table" aria-label={ariaLabel}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                style={{ width: column.width, textAlign: column.align === 'right' ? 'right' : 'left' }}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="st-table-empty">
                {empty ?? 'Nothing here yet.'}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={getKey(row)}
                data-clickable={onRowClick ? 'true' : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          onRowClick(row)
                        }
                      }
                    : undefined
                }
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    style={{ textAlign: column.align === 'right' ? 'right' : 'left' }}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
      {footer}
    </div>
  )
}

export const Tabs = <T extends string>({
  items,
  value,
  onChange,
}: {
  items: { value: T; label: ReactNode; count?: number }[]
  value: T
  onChange: (value: T) => void
}) => (
  <div className="st-tabs" role="tablist">
    {items.map((item) => (
      <button
        key={item.value}
        type="button"
        role="tab"
        aria-selected={item.value === value}
        className="st-tab"
        onClick={() => onChange(item.value)}
      >
        {item.label}
        {item.count != null ? <span className="st-tab-count">{item.count}</span> : null}
      </button>
    ))}
  </div>
)

export const EmptyState = ({
  title,
  description,
  action,
  icon,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  icon?: ReactNode
}) => (
  <div className="st-empty">
    <div className="st-empty-icon">{icon ?? <IconStar size={18} />}</div>
    <div className="st-empty-title">{title}</div>
    {description ? <div className="st-empty-desc">{description}</div> : null}
    {action}
  </div>
)

export const Field = ({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  children: ReactNode
  htmlFor?: string
}) => (
  <div className="st-field">
    <label className="st-label" htmlFor={htmlFor}>
      {label}
    </label>
    {children}
    {error ? <div className="st-error-text">{error}</div> : hint ? <div className="st-hint">{hint}</div> : null}
  </div>
)

export const KeyValue = ({ items }: { items: { label: ReactNode; value: ReactNode }[] }) => (
  <dl className="st-kv">
    {items.map((item, index) => (
      <div key={index} style={{ display: 'contents' }}>
        <dt>{item.label}</dt>
        <dd>{item.value}</dd>
      </div>
    ))}
  </dl>
)

export const SourceCard = ({
  rank,
  title,
  meta,
  text,
  score,
}: {
  rank: number | string
  title: string
  meta?: ReactNode
  text?: string
  score?: number
}) => (
  <div className="st-source">
    <div className="st-source-head">
      <span className="st-source-rank">{rank}</span>
      <span className="st-source-title">{title}</span>
      <span className="st-spacer" />
      {score != null ? <span className="st-source-meta st-mono">{score.toFixed(2)}</span> : null}
    </div>
    {meta ? <div className="st-source-meta">{meta}</div> : null}
    {text ? <div className="st-source-text">{text}</div> : null}
  </div>
)

export const InlineCode = ({ children }: { children: ReactNode }) => (
  <code className="st-code">{children}</code>
)

export const LoadingBlock = ({ label = 'Loading' }: { label?: string }) => (
  <div style={{ padding: 24 }} role="status" aria-label={label}>
    <div className="st-skeleton" style={{ width: '55%', marginBottom: 12 }} />
    <div className="st-skeleton" style={{ width: '82%', marginBottom: 12 }} />
    <div className="st-skeleton" style={{ width: '68%' }} />
  </div>
)
