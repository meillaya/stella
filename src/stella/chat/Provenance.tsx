import clsx from 'clsx'
import { useEffect, useState } from 'react'
import type { Dataset, Feedback } from '../../../shared/types.js'
import { formatUsd } from '../../../shared/pricing.js'
import type { AssistantMessage as AssistantMessageType } from '../../services/chat/types.js'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../../components/base/Button.js'
import { Modal } from '../../components/base/Modal.js'
import { showToast } from '../../components/base/toastState.js'
import { api } from '../api.js'
import { formatDuration } from '../format.js'
import { navigate } from '../router.js'
import {
  IconClock,
  IconCoin,
  IconPlus,
  IconThumbDown,
  IconThumbUp,
  IconTraces,
} from '../ui/icons.js'
import styles from './Provenance.module.css'

type LanternSource = NonNullable<
  NonNullable<AssistantMessageType['usage']>['lantern_sources']
>[number]

const sourceTitle = (t: ReturnType<typeof useTranslate>, source: LanternSource): string => {
  const parts = [source.title]
  if (source.heading) {
    parts.push(source.heading)
  }
  if (source.page != null) {
    parts.push(t('stellaPageLabel', { page: source.page }))
  }
  return parts.join(' — ')
}

/**
 * Chat provenance: sources, cost, latency, trace, feedback and promotion.
 * It only appears for completed, non-refused answers that carry a gateway trace;
 * answers that never went through the gateway stay plain chat.
 */
export const Provenance = ({ message }: { message: AssistantMessageType }) => {
  const t = useTranslate()
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [pending, setPending] = useState(false)
  const [promoteOpen, setPromoteOpen] = useState(false)
  const usage = message.usage
  const traceId = usage?.lantern_trace_id

  if (message.status !== 'done' || message.stopReason === 'refusal' || !traceId) {
    return null
  }

  const tracePath = `/traces/${encodeURIComponent(traceId)}`
  const sources = (usage.lantern_sources ?? []).slice(0, 4)
  const cost =
    typeof usage.lantern_cost_usd === 'number' ? formatUsd(usage.lantern_cost_usd) : null
  const latency =
    typeof usage.lantern_latency_ms === 'number'
      ? formatDuration(usage.lantern_latency_ms)
      : null
  const basis =
    usage.lantern_pricing_basis === 'peak'
      ? t('stellaPricingPeak')
      : usage.lantern_pricing_basis === 'off-peak'
        ? t('stellaPricingOffPeak')
        : null

  const submitFeedback = async (next: Feedback | null) => {
    if (pending) {
      return
    }
    const previous = feedback
    setFeedback(next)
    setPending(true)
    try {
      await api.patch(`/api/traces/${encodeURIComponent(traceId)}`, { feedback: next })
    } catch {
      setFeedback(previous)
      showToast({ key: 'stellaFeedbackFailed', type: 'error' })
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <div className={clsx('st-prov', styles.strip)} role="group" aria-label={t('stellaProvenance')}>
        {sources.map((source) => (
          <button
            key={source.id}
            type="button"
            className="st-source-chip"
            title={sourceTitle(t, source)}
            aria-label={`${t('stellaSource')}: ${source.title}`}
            onClick={() => navigate(tracePath)}
          >
            <span>{source.title}</span>
          </button>
        ))}
        {sources.length > 0 ? <span className="st-prov-sep" aria-hidden /> : null}
        {cost ? (
          <span
            className={styles.metric}
            title={basis ? `${t('stellaCost')} · ${basis}` : t('stellaCost')}
            aria-label={`${t('stellaCost')}: ${cost}${basis ? `, ${basis}` : ''}`}
          >
            <IconCoin size={12} />
            {cost}
          </span>
        ) : null}
        {latency ? (
          <span
            className={styles.metric}
            title={t('stellaLatency')}
            aria-label={`${t('stellaLatency')}: ${latency}`}
          >
            <IconClock size={12} />
            {latency}
          </span>
        ) : null}
        {cost || latency ? <span className="st-prov-sep" aria-hidden /> : null}
        <button
          type="button"
          className="st-prov-btn"
          title={t('stellaOpenTrace')}
          onClick={() => navigate(tracePath)}
        >
          <IconTraces size={13} />
          {t('stellaTrace')}
        </button>
        <span className="st-prov-sep" aria-hidden />
        <button
          type="button"
          className="st-prov-btn"
          aria-pressed={feedback === 'up'}
          aria-label={t('stellaHelpful')}
          title={t('stellaHelpful')}
          disabled={pending}
          onClick={() => void submitFeedback(feedback === 'up' ? null : 'up')}
        >
          <IconThumbUp size={13} />
        </button>
        <button
          type="button"
          className="st-prov-btn"
          aria-pressed={feedback === 'down'}
          aria-label={t('stellaNotHelpful')}
          title={t('stellaNotHelpful')}
          disabled={pending}
          onClick={() => void submitFeedback(feedback === 'down' ? null : 'down')}
        >
          <IconThumbDown size={13} />
        </button>
        <button
          type="button"
          className="st-prov-btn"
          disabled={!traceId || pending}
          onClick={() => setPromoteOpen(true)}
        >
          <IconPlus size={13} />
          {t('stellaMakeTestCase')}
        </button>
      </div>
      {promoteOpen ? (
        <PromoteDialog traceId={traceId} onClose={() => setPromoteOpen(false)} />
      ) : null}
    </>
  )
}

const PromoteDialog = ({ traceId, onClose }: { traceId: string; onClose: () => void }) => {
  const t = useTranslate()
  const [datasets, setDatasets] = useState<Dataset[] | null>(null)
  const [datasetId, setDatasetId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setDatasets(null)
    setDatasetId(null)
    setLoadError(false)
    api
      .get<{ items: Dataset[] }>('/api/datasets')
      .then((result) => {
        if (cancelled) {
          return
        }
        setDatasets(result.items)
        setDatasetId(result.items[0]?.id ?? null)
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  const submit = async () => {
    if (!datasetId || submitting) {
      return
    }
    setSubmitting(true)
    try {
      await api.post(`/api/traces/${encodeURIComponent(traceId)}/promote`, { datasetId })
      showToast({ key: 'stellaPromoteSucceeded' })
      setSubmitting(false)
      onClose()
    } catch {
      showToast({ key: 'stellaPromoteFailed', type: 'error' })
      setSubmitting(false)
    }
  }

  const close = () => {
    if (!submitting) {
      onClose()
    }
  }

  return (
    <Modal
      title={t('stellaPromoteTitle')}
      closable
      onClose={close}
      footer={
        <>
          <Button variant="outlined" size="m" disabled={submitting} onClick={close}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            size="m"
            disabled={!datasetId || submitting}
            onClick={() => void submit()}
          >
            {t(submitting ? 'stellaPromoteCreating' : 'stellaPromoteSubmit')}
          </Button>
        </>
      }
    >
      <div className={styles.promote}>
        <p className={styles.promoteNote}>{t('stellaPromoteDescription')}</p>
        <div className="st-label">{t('stellaPromoteDataset')}</div>
        {loadError ? (
          <div className={styles.promoteError}>
            <span>{t('stellaPromoteDatasetsFailed')}</span>
            <button
              type="button"
              className={styles.retry}
              onClick={() => setAttempt((value) => value + 1)}
            >
              {t('retry')}
            </button>
          </div>
        ) : datasets === null ? (
          <div className="st-hint" role="status">
            {t('stellaPromoteLoading')}
          </div>
        ) : datasets.length === 0 ? (
          <div className="st-hint">{t('stellaPromoteNoDatasets')}</div>
        ) : (
          <div
            role="radiogroup"
            aria-label={t('stellaPromoteDataset')}
            className={styles.options}
          >
            {datasets.map((dataset) => (
              <label
                key={dataset.id}
                className={clsx(styles.option, dataset.id === datasetId && styles.optionActive)}
              >
                <input
                  type="radio"
                  name="stella-promote-dataset"
                  checked={dataset.id === datasetId}
                  disabled={submitting}
                  onChange={() => setDatasetId(dataset.id)}
                />
                <span className={styles.optionName}>{dataset.name}</span>
                <span className={styles.optionMeta}>
                  {t('stellaVersion', { version: dataset.latestVersion ?? '—' })}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
