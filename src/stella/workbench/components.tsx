import clsx from 'clsx'
import {
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { Modal } from '../../components/base/Modal.js'
import type { Feedback, Profile, RunStatus, SourceRef, TokenUsage, TraceStatus } from '../../../shared/types.js'
import {
  formatInteger,
  isMissingEndpointMessage,
  profileRetrievalLabel,
  runStatusLabel,
  runStatusTone,
  traceStatusLabel,
  traceStatusTone,
} from './lib.js'
import { IconAlert, IconCheck, IconChevronRight, IconInfo, IconThumbDown, IconThumbUp } from '../ui/icons.js'
import { Badge, Field, KeyValue, SourceCard } from '../ui/index.js'

/* ------------------------------ buttons and links ------------------------------ */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export const WorkButton = ({
  variant = 'secondary',
  size = 'm',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: 's' | 'm'
}) => (
  <button
    type="button"
    className={clsx('st-w-btn', `st-w-btn-${variant}`, `st-w-btn-${size}`, className)}
    {...props}
  />
)

export const WorkLink = ({
  href,
  variant = 'secondary',
  children,
  className,
  download,
  target,
  rel,
}: {
  href: string
  variant?: ButtonVariant
  children: ReactNode
  className?: string
  download?: string | boolean
  target?: string
  rel?: string
}) => (
  <a
    href={href}
    className={clsx('st-w-btn', `st-w-btn-${variant}`, 'st-w-btn-m', className)}
    download={download}
    target={target}
    rel={rel}
  >
    {children}
    {target === '_blank' ? <IconChevronRight size={13} /> : null}
  </a>
)

/* ------------------------------ notices and errors ------------------------------ */

export const InlineNotice = ({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'success' | 'warn' | 'error'
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
}) => {
  const Icon = tone === 'success' ? IconCheck : tone === 'error' ? IconAlert : tone === 'warn' ? IconAlert : IconInfo
  return (
    <div className="st-w-notice" data-tone={tone} role={tone === 'error' ? 'alert' : undefined}>
      <span className="st-w-notice-icon">
        <Icon size={15} />
      </span>
      <div className="st-w-notice-body">
        {title ? <div className="st-w-notice-title">{title}</div> : null}
        {children ? <div className="st-w-notice-text">{children}</div> : null}
      </div>
      {action ? <div className="st-w-notice-action">{action}</div> : null}
    </div>
  )
}

export const LoadError = ({
  message,
  title,
  onRetry,
  children,
}: {
  message: string
  title?: string
  onRetry?: () => void
  children?: ReactNode
}) => {
  const missing = isMissingEndpointMessage(message)
  return (
    <InlineNotice
      tone="error"
      title={title ?? (missing ? 'This API is not available yet' : 'Could not load this data')}
      action={
        onRetry ? (
          <WorkButton size="s" onClick={onRetry}>
            Retry
          </WorkButton>
        ) : null
      }
    >
      <p className="st-w-notice-para">{message}</p>
      {missing ? (
        <p className="st-w-notice-para st-w-muted">
          The Stella backend is being built in parallel. Reads and writes will work once this endpoint lands; nothing
          was changed.
        </p>
      ) : null}
      {children}
    </InlineNotice>
  )
}

/* ------------------------------ status badges ------------------------------ */

export const RunStatusBadge = ({ status }: { status: RunStatus }) => (
  <Badge tone={runStatusTone(status)} dot={status === 'running'}>
    {runStatusLabel[status]}
  </Badge>
)

export const TraceStatusBadge = ({ status }: { status: TraceStatus }) => (
  <Badge tone={traceStatusTone(status)} dot={status === 'error'}>
    {traceStatusLabel[status]}
  </Badge>
)

export const FeedbackBadge = ({ value }: { value: Feedback | null }) =>
  value ? (
    <Badge tone={value === 'up' ? 'pass' : 'fail'}>
      {value === 'up' ? <IconThumbUp size={12} /> : <IconThumbDown size={12} />}
      {value === 'up' ? 'Up' : 'Down'}
    </Badge>
  ) : (
    <Badge tone="neutral" outline>
      None
    </Badge>
  )

export const BehaviorBadge = ({ behavior }: { behavior: 'answer' | 'refuse' | 'any' }) => (
  <Badge tone="neutral" outline>
    {behavior === 'answer' ? 'Answer' : behavior === 'refuse' ? 'Refuse' : 'Any'}
  </Badge>
)

export const ProfileLabel = ({ profile }: { profile: Profile }) => (
  <div className="st-hint">
    {profile.spec.model.id} · thinking {profile.spec.model.thinking ? 'on' : 'off'} ·{' '}
    {profileRetrievalLabel(profile.spec)} · judge pass ≥{profile.spec.judge.passScore}/3
  </div>
)

/* ------------------------------ form primitives ------------------------------ */

export const SelectField = ({
  label,
  value,
  onChange,
  options,
  hint,
  disabled,
  id: providedId,
  placeholder,
}: {
  label: ReactNode
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string; disabled?: boolean }[]
  hint?: ReactNode
  disabled?: boolean
  id?: string
  placeholder?: string
}) => {
  const generated = useId()
  const id = providedId ?? generated
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <select
        id={id}
        className="st-w-select"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  )
}

export const InputField = ({
  label,
  hint,
  id: providedId,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode
  hint?: ReactNode
  id?: string
}) => {
  const generated = useId()
  const id = providedId ?? generated
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <input id={id} className="st-w-input" {...props} />
    </Field>
  )
}

export const TextareaField = ({
  label,
  hint,
  id: providedId,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: ReactNode
  hint?: ReactNode
  id?: string
}) => {
  const generated = useId()
  const id = providedId ?? generated
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <textarea id={id} className="st-w-textarea" {...props} />
    </Field>
  )
}

/* ------------------------------ modal helpers ------------------------------ */

export const ConfirmModal = ({
  title,
  confirmLabel = 'Confirm',
  tone = 'primary',
  busy = false,
  error,
  onConfirm,
  onClose,
  children,
}: {
  title: ReactNode
  confirmLabel?: ReactNode
  tone?: 'primary' | 'danger'
  busy?: boolean
  error?: string | null
  onConfirm: () => void
  onClose: () => void
  children?: ReactNode
}) => (
  <Modal
    title={title}
    closable
    className="st-w-modal st-w-modal-sm"
    onClose={onClose}
    footer={
      <>
        <WorkButton onClick={onClose} disabled={busy}>
          Cancel
        </WorkButton>
        <WorkButton
          variant={tone === 'danger' ? 'danger' : 'primary'}
          onClick={onConfirm}
          disabled={busy}
          aria-busy={busy}
        >
          {busy ? 'Working…' : confirmLabel}
        </WorkButton>
      </>
    }
  >
    <div className="st-w-stack-sm">
      {children}
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    </div>
  </Modal>
)

/* ------------------------------ data display ------------------------------ */

export const TokenBreakdown = ({ usage }: { usage: TokenUsage }) => {
  const total = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens + usage.outputTokens
  return (
    <KeyValue
      items={[
        { label: 'Input (cache miss)', value: formatInteger(usage.inputTokens) },
        { label: 'Cache read', value: formatInteger(usage.cacheReadTokens) },
        { label: 'Cache write', value: formatInteger(usage.cacheCreationTokens) },
        { label: 'Output', value: formatInteger(usage.outputTokens) },
        ...(usage.thinkingTokens != null
          ? [{ label: 'Thinking tokens', value: formatInteger(usage.thinkingTokens) }]
          : []),
        { label: 'Total', value: formatInteger(total) },
        ...(usage.estimated ? [{ label: 'Source', value: 'Estimated from request shape' }] : []),
      ]}
    />
  )
}

export const SourceList = ({ sources }: { sources: SourceRef[] }) => {
  if (sources.length === 0) {
    return <p className="st-w-muted st-small">No sources were attached to this answer.</p>
  }
  return (
    <div className="st-w-source-list">
      {sources.map((source, index) => (
        <SourceCard
          key={source.chunkId || `${source.documentId}-${index}`}
          rank={index + 1}
          title={source.title || source.documentId}
          meta={
            <span>
              {[source.heading, source.page != null ? `page ${source.page}` : null, source.documentId]
                .filter(Boolean)
                .join(' · ')}
            </span>
          }
          text={source.snippet}
          score={source.score}
        />
      ))}
    </div>
  )
}

/* ------------------------------ hooks ------------------------------ */

export const useDebouncedValue = <T,>(value: T, delay = 250): T => {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/* ------------------------------ small bits ------------------------------ */

export const TableFoot = ({
  children,
  actions,
}: {
  children: ReactNode
  actions?: ReactNode
}) => (
  <div className="st-w-table-foot">
    <div className="st-small st-w-muted">{children}</div>
    {actions ? <div className="st-row">{actions}</div> : null}
  </div>
)

export const SectionNote = ({ children }: { children: ReactNode }) => (
  <p className="st-w-section-note">{children}</p>
)

