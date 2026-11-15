import { useEffect, useState } from 'react'
import type { KeyStatus } from '../../../shared/types.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { useApi } from '../../stella/api.js'
import { Badge } from '../../stella/ui/index.js'
import {
  applyActiveProfile,
  applyTraceRetention,
  loadStellaSettings,
  useStellaSettings,
  type StellaHealth,
} from '../../stella/chat/stellaSettings.js'
import { showToast } from '../base/toastState.js'
import { shortId } from '../../stella/format.js'
import styles from './StellaSettingsSection.module.css'

const SOURCE_KEYS: Record<KeyStatus['source'], TranslationKey> = {
  env: 'stellaKeySourceEnv',
  file: 'stellaKeySourceFile',
  request: 'stellaKeySourceRequest',
  none: 'stellaKeySourceNone',
}

/**
 * Stella settings: gateway key status (never the key), active retrieval profile
 * and trace retention. The section reads the gateway; it does not need chat.
 */
export const StellaSettingsSection = () => {
  const t = useTranslate()
  const health = useApi<StellaHealth>('/api/health')
  const settings = useStellaSettings((state) => state.settings)
  const profiles = useStellaSettings((state) => state.profiles)
  const loading = useStellaSettings((state) => state.loading)
  const loaded = useStellaSettings((state) => state.loaded)

  useEffect(() => {
    void loadStellaSettings(true)
  }, [])

  const activeId = settings?.activeProfileId ?? null
  const activeMissing =
    activeId !== null && !(profiles ?? []).some((profile) => profile.id === activeId)

  const changeProfile = async (profileId: string | null) => {
    try {
      await applyActiveProfile(profileId)
    } catch {
      showToast({ key: 'stellaProfileUpdateFailed', type: 'error' })
    }
  }

  return (
    <div className={styles.section}>
      <p className={styles.intro}>{t('stellaSettingsIntro')}</p>

      <section className={styles.block} aria-labelledby="stella-key-heading">
        <div className={styles.blockHead}>
          <h3 id="stella-key-heading" className={styles.blockTitle}>
            {t('stellaDeepseekKey')}
          </h3>
          {health.data ? (
            <Badge tone={health.data.key.configured ? 'pass' : 'fail'} dot>
              {t(health.data.key.configured ? 'stellaConfigured' : 'stellaNotConfigured')}
            </Badge>
          ) : null}
        </div>
        {health.error ? (
          <div className={styles.inlineError} role="status">
            {t('stellaHealthUnavailable')}
          </div>
        ) : health.data ? (
          <dl className={styles.meta}>
            <div>
              <dt>{t('stellaKeySource')}</dt>
              <dd>{t(SOURCE_KEYS[health.data.key.source])}</dd>
            </div>
            {health.data.key.lastFour ? (
              <div>
                <dt>{t('stellaKeyLastFour')}</dt>
                <dd className="st-mono">{health.data.key.lastFour}</dd>
              </div>
            ) : null}
            {health.data.key.baseUrl ? (
              <div>
                <dt>{t('stellaKeyBaseUrl')}</dt>
                <dd className="st-mono">{health.data.key.baseUrl}</dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <div className="st-hint" role="status">
            {t('stellaSettingsLoading')}
          </div>
        )}
        <p className={styles.note}>{t('stellaGatewayNotes')}</p>
      </section>

      <section className={styles.block} aria-labelledby="stella-profile-heading">
        <h3 id="stella-profile-heading" className={styles.blockTitle}>
          {t('stellaActiveProfile')}
        </h3>
        {settings ? (
          <div className="st-field">
            <select
              id="stella-active-profile"
              className="st-input"
              aria-label={t('stellaActiveProfile')}
              value={settings.activeProfileId ?? ''}
              disabled={loading}
              onChange={(event) => void changeProfile(event.target.value || null)}
            >
              <option value="">{t('stellaNoRetrieval')}</option>
              {activeMissing && activeId ? (
                <option value={activeId}>{shortId(activeId)}</option>
              ) : null}
              {(profiles ?? []).map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} · {t('stellaVersion', { version: profile.version })}
                </option>
              ))}
            </select>
            {profiles === null ? (
              <div className={styles.inlineError}>{t('stellaProfilesUnavailable')}</div>
            ) : null}
            <div className="st-hint">{t('stellaActiveProfileHint')}</div>
          </div>
        ) : (
          <div className={styles.unavailable}>
            <span>
              {loading || !loaded ? t('stellaSettingsLoading') : t('stellaSettingsUnavailable')}
            </span>
            {loading || !loaded ? null : (
              <button
                type="button"
                className={styles.button}
                onClick={() => void loadStellaSettings(true)}
              >
                {t('retry')}
              </button>
            )}
          </div>
        )}
      </section>

      <section className={styles.block} aria-labelledby="stella-retention-heading">
        <h3 id="stella-retention-heading" className={styles.blockTitle}>
          {t('stellaTraceRetention')}
        </h3>
        {settings ? (
          <RetentionControl
            key={settings.traceRetentionDays}
            initial={settings.traceRetentionDays}
          />
        ) : (
          <div className="st-hint">{t('stellaTraceRetentionHint')}</div>
        )}
      </section>
    </div>
  )
}

const RetentionControl = ({ initial }: { initial: number }) => {
  const t = useTranslate()
  const [value, setValue] = useState(String(initial))
  const [busy, setBusy] = useState(false)
  const parsed = Number(value)
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 365

  const save = async () => {
    if (!valid || busy) {
      return
    }
    setBusy(true)
    try {
      await applyTraceRetention(parsed)
      showToast({ key: 'stellaRetentionSaved' })
    } catch {
      showToast({ key: 'stellaRetentionFailed', type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="st-field">
      <div className={styles.retentionRow}>
        <input
          id="stella-trace-retention"
          className={`st-input ${styles.retentionInput}`}
          type="number"
          inputMode="numeric"
          aria-label={t('stellaTraceRetention')}
          min={1}
          max={365}
          step={1}
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              void save()
            }
          }}
        />
        <button
          type="button"
          className={styles.buttonPrimary}
          disabled={!valid || busy}
          onClick={() => void save()}
        >
          {t('stellaSave')}
        </button>
      </div>
      <div className="st-hint">{t('stellaTraceRetentionHint')}</div>
    </div>
  )
}
