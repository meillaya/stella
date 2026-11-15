import clsx from 'clsx'
import { useState } from 'react'
import type { Profile } from '../../../shared/types.js'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../../components/base/Button.js'
import { Modal } from '../../components/base/Modal.js'
import { Tooltip } from '../../components/base/Tooltip.js'
import { showToast } from '../../components/base/toastState.js'
import { IconDatasets } from '../ui/icons.js'
import { shortId } from '../format.js'
import {
  applyActiveProfile,
  loadStellaSettings,
  useStellaContext,
  useStellaSettings,
} from './stellaSettings.js'
import styles from './ProfileChip.module.css'

/**
 * Composer chip for the active retrieval profile. It is intentionally small:
 * the chat composer keeps its upstream layout, and retrieval stays optional
 * when the gateway endpoints are not there.
 */
export const ProfileChip = () => {
  const t = useTranslate()
  useStellaContext()
  const settings = useStellaSettings((state) => state.settings)
  const profiles = useStellaSettings((state) => state.profiles)
  const loading = useStellaSettings((state) => state.loading)
  const loaded = useStellaSettings((state) => state.loaded)
  const [open, setOpen] = useState(false)

  const activeId = settings?.activeProfileId ?? null
  const activeProfile = activeId ? profiles?.find((profile) => profile.id === activeId) : undefined
  const label = activeProfile?.name ?? (activeId ? shortId(activeId) : t('stellaNoRetrieval'))

  return (
    <>
      <Tooltip content={t('stellaRetrievalProfile')}>
        <button
          type="button"
          className={styles.chip}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${t('stellaRetrievalProfile')}: ${label}`}
          onClick={() => setOpen(true)}
        >
          <IconDatasets size={13} />
          <span className={styles.label}>{label}</span>
        </button>
      </Tooltip>
      {open ? (
        <ProfileDialog
          activeId={activeId}
          profiles={profiles}
          loading={loading}
          loaded={loaded}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

const ProfileDialog = ({
  activeId,
  profiles,
  loading,
  loaded,
  onClose,
}: {
  activeId: string | null
  profiles: Profile[] | null
  loading: boolean
  loaded: boolean
  onClose: () => void
}) => {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const select = async (profileId: string | null) => {
    if (busy || profileId === activeId) {
      return
    }
    setBusy(true)
    setFailed(false)
    try {
      await applyActiveProfile(profileId)
      onClose()
    } catch {
      setFailed(true)
      showToast({ key: 'stellaProfileUpdateFailed', type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('stellaRetrievalProfile')}
      closable
      onClose={() => {
        if (!busy) {
          onClose()
        }
      }}
      footer={
        <Button variant="outlined" size="m" disabled={busy} onClick={onClose}>
          {t('cancel')}
        </Button>
      }
    >
      <div className={styles.dialog}>
        <p className={styles.note}>{t('stellaProfileNote')}</p>
        {profiles === null && loaded ? (
          <div className={styles.unavailable}>
            <span>{t('stellaProfilesUnavailable')}</span>
            <button
              type="button"
              className={styles.retry}
              onClick={() => void loadStellaSettings(true)}
            >
              {t('retry')}
            </button>
          </div>
        ) : null}
        {(loading || !loaded) && profiles === null ? (
          <div className={styles.hint} role="status">
            {t('stellaProfilesLoading')}
          </div>
        ) : null}
        <div role="radiogroup" aria-label={t('stellaRetrievalProfile')} className={styles.options}>
          <label className={clsx(styles.option, activeId === null && styles.optionActive)}>
            <input
              type="radio"
              name="stella-active-profile"
              checked={activeId === null}
              disabled={busy}
              onChange={() => void select(null)}
            />
            <span className={styles.optionName}>{t('stellaNoRetrieval')}</span>
          </label>
          {(profiles ?? []).map((profile) => (
            <label
              key={profile.id}
              className={clsx(styles.option, activeId === profile.id && styles.optionActive)}
            >
              <input
                type="radio"
                name="stella-active-profile"
                checked={activeId === profile.id}
                disabled={busy}
                onChange={() => void select(profile.id)}
              />
              <span className={styles.optionName}>{profile.name}</span>
              <span className={styles.optionMeta}>
                {t('stellaVersion', { version: profile.version })}
              </span>
            </label>
          ))}
        </div>
        {failed ? (
          <div className={styles.failed} role="alert">
            {t('stellaProfileUpdateFailed')}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
