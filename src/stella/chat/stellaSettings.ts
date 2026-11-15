import { useEffect } from 'react'
import { create } from 'zustand'
import type { KeyStatus, Profile, StellaSettings } from '../../../shared/types.js'
import { api } from '../api.js'

/**
 * GET /api/health payload. The key object carries status only: the server never
 * sends the key itself, and neither do we ask for it.
 */
export type StellaHealth = {
  ok: boolean
  name: string
  version: string
  mode: string
  hasKey: boolean
  key: KeyStatus
  dataDir: string
  db: string
}

type StellaContextState = {
  /** GET /api/settings; null when the gateway does not answer yet. */
  settings: StellaSettings | null
  /** GET /api/profiles; null when unavailable (retrieval stays optional). */
  profiles: Profile[] | null
  /** Last load failure, if any. Chat still works while this is set. */
  error: string | null
  loading: boolean
  loaded: boolean
}

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

export const useStellaSettings = create<StellaContextState>(() => ({
  settings: null,
  profiles: null,
  error: null,
  loading: false,
  loaded: false,
}))

let inflight: Promise<void> | null = null

/**
 * Loads the gateway settings and the profile list. Both requests are optional:
 * a failed endpoint leaves that slice null and records the error instead of
 * blocking the chat composer. Concurrent callers share one request.
 */
export const loadStellaSettings = (force = false): Promise<void> => {
  const current = useStellaSettings.getState()
  if (inflight) {
    return inflight
  }
  if (!force && current.loaded) {
    return Promise.resolve()
  }
  useStellaSettings.setState({ loading: true })
  inflight = (async () => {
    const [settings, profiles] = await Promise.allSettled([
      api.get<StellaSettings>('/api/settings'),
      api.get<{ items: Profile[] }>('/api/profiles'),
    ])
    const errors: string[] = []
    const next: Partial<StellaContextState> = { loading: false, loaded: true }
    if (settings.status === 'fulfilled') {
      next.settings = settings.value
    } else {
      errors.push(message(settings.reason))
    }
    if (profiles.status === 'fulfilled') {
      next.profiles = profiles.value.items
    } else {
      errors.push(message(profiles.reason))
    }
    next.error = errors.length > 0 ? errors.join(' · ') : null
    useStellaSettings.setState(next)
  })().finally(() => {
    inflight = null
  })
  return inflight
}

/** Optimistically switch the retrieval profile, reverting when the PATCH fails. */
export const applyActiveProfile = async (profileId: string | null): Promise<void> => {
  const previous = useStellaSettings.getState().settings
  if (previous) {
    useStellaSettings.setState({ settings: { ...previous, activeProfileId: profileId } })
  }
  try {
    const saved = await api.patch<StellaSettings>('/api/settings', { activeProfileId: profileId })
    useStellaSettings.setState({ settings: saved, error: null })
  } catch (cause) {
    if (previous) {
      useStellaSettings.setState({ settings: previous })
    }
    throw cause
  }
}

/** Persist the trace retention window and mirror the server response. */
export const applyTraceRetention = async (days: number): Promise<void> => {
  const saved = await api.patch<StellaSettings>('/api/settings', { traceRetentionDays: days })
  useStellaSettings.setState({ settings: saved, error: null })
}

/** Load once when a Stella-aware surface (chip, settings tab) mounts. */
export const useStellaContext = (): void => {
  useEffect(() => {
    void loadStellaSettings()
  }, [])
}
