import { useEffect, useState } from 'react'
import type { KeyStatus, ModelId, StellaSettings } from '../../../shared/types.js'
import { api, useApi } from '../api.js'
import { href } from '../router.js'
import {
  Badge,
  Card,
  KeyValue,
  LoadingBlock,
  Page,
  PageHeader,
} from '../ui/index.js'
import { IconChat } from '../ui/icons.js'
import {
  InlineNotice,
  InputField,
  LoadError,
  SelectField,
  WorkButton,
  WorkLink,
} from '../workbench/components.js'
import type { ProfileListResponse } from '../workbench/api-types.js'
import { describeApiError } from '../workbench/lib.js'

type HealthResponse = {
  ok: boolean
  name: string
  version: string
  mode: string
  hasKey: boolean
  key: KeyStatus
  dataDir: string
  db: string
}

export const SettingsPage = () => {
  const health = useApi<HealthResponse>('/api/health')
  const settings = useApi<StellaSettings>('/api/settings')
  const profiles = useApi<ProfileListResponse>('/api/profiles')

  const [activeProfileId, setActiveProfileId] = useState('')
  const [retentionDays, setRetentionDays] = useState('30')
  const [defaultModel, setDefaultModel] = useState<ModelId>('deepseek-flash')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!settings.data) {return}
    setActiveProfileId(settings.data.activeProfileId ?? '')
    setRetentionDays(String(settings.data.traceRetentionDays))
    setDefaultModel(settings.data.defaultModel)
  }, [settings.data])

  const save = async () => {
    const days = Number(retentionDays)
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      setError('Retention must be a whole number of days between 1 and 365.')
      return
    }
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const next = await api.patch<StellaSettings>('/api/settings', {
        activeProfileId: activeProfileId || null,
        traceRetentionDays: days,
        defaultModel,
      })
      setActiveProfileId(next.activeProfileId ?? '')
      setRetentionDays(String(next.traceRetentionDays))
      setDefaultModel(next.defaultModel)
      setNotice('Preferences saved.')
      settings.reload()
    } catch (cause) {
      setError(describeApiError(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Page className="st-w-page">
      <PageHeader
        title="Settings"
        description="Gateway status and workbench defaults. Keys stay in the environment or the local Stella data directory; this page never reveals them."
        actions={
          <WorkLink href={href('/chat')}>
            <IconChat size={15} />
            Back to chat
          </WorkLink>
        }
      />

      {health.error && !health.data ? (
        <LoadError message={health.error} onRetry={health.reload} />
      ) : health.loading && !health.data ? (
        <Card>
          <LoadingBlock />
        </Card>
      ) : health.data ? (
        <div className="st-w-settings-grid">
          <Card
            title="Gateway"
            subtitle={`${health.data.name} v${health.data.version} · ${health.data.mode} mode`}
            actions={
              <Badge tone={health.data.ok ? 'pass' : 'fail'} dot>
                {health.data.ok ? 'Healthy' : 'Unhealthy'}
              </Badge>
            }
          >
            <KeyValue
              items={[
                {
                  label: 'API key',
                  value: health.data.hasKey ? (
                    <span className="st-row st-wrap">
                      <Badge tone="pass">Configured</Badge>
                      <span className="st-small st-muted">
                        {health.data.key.source}
                        {health.data.key.lastFour ? ` · ending ${health.data.key.lastFour}` : ''}
                      </span>
                    </span>
                  ) : (
                    <span className="st-row st-wrap">
                      <Badge tone="warn">No key</Badge>
                      <span className="st-small st-muted">Live model calls will fail with an actionable error.</span>
                    </span>
                  ),
                },
                { label: 'Base URL', value: <span className="st-w-code-path">{health.data.key.baseUrl}</span> },
                { label: 'Mode', value: health.data.mode },
                { label: 'Data directory', value: <span className="st-w-code-path">{health.data.dataDir}</span> },
                { label: 'Database', value: <span className="st-w-code-path">{health.data.db}</span> },
              ]}
            />
            {!health.data.hasKey ? (
              <div style={{ marginTop: 14 }}>
                <InlineNotice tone="warn" title="Replay mode is available">
                  Traces, datasets and recorded evaluation results remain inspectable. New model calls fail with an
                  actionable message until a key is configured in the chat settings.
                </InlineNotice>
              </div>
            ) : null}
            <div className="st-w-inline-actions" style={{ marginTop: 14 }}>
              <WorkLink href={href('/chat')}>Open chat</WorkLink>
              <WorkButton size="s" variant="ghost" onClick={health.reload} disabled={health.loading}>
                {health.loading ? 'Checking…' : 'Recheck'}
              </WorkButton>
            </div>
          </Card>

          <Card title="Workbench defaults" subtitle="Applied to new chats and evaluation runs; existing traces keep their recorded settings.">
            {settings.error && !settings.data ? (
              <LoadError message={settings.error} onRetry={settings.reload} />
            ) : settings.loading && !settings.data ? (
              <LoadingBlock />
            ) : (
              <div className="st-w-form">
                {notice ? <InlineNotice tone="success">{notice}</InlineNotice> : null}
                {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
                <SelectField
                  label="Active profile"
                  value={activeProfileId}
                  onChange={setActiveProfileId}
                  disabled={profiles.loading || Boolean(profiles.error)}
                  hint={
                    profiles.error
                      ? 'The profiles endpoint is unavailable, so the active profile cannot be changed here.'
                      : 'Publishing a profile in Improve also makes it active.'
                  }
                  options={[
                    { value: '', label: 'No active profile' },
                    ...(profiles.data?.items ?? []).map((profile) => ({
                      value: profile.id,
                      label: `${profile.name} v${profile.version}${profile.publishedAt != null ? ' · published' : ' · draft'}`,
                    })),
                  ]}
                />
                <div className="st-w-field-grid">
                  <InputField
                    label="Trace retention (days)"
                    type="number"
                    min={1}
                    max={365}
                    step={1}
                    value={retentionDays}
                    onChange={(event) => setRetentionDays(event.target.value)}
                    hint="The retention window recorded in Stella settings. Traces outside it are subject to maintenance pruning."
                  />
                  <SelectField
                    label="Default model"
                    value={defaultModel}
                    onChange={(value) => setDefaultModel(value as ModelId)}
                    options={[
                      { value: 'deepseek-flash', label: 'deepseek-flash' },
                      { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
                    ]}
                  />
                </div>
                <div className="st-w-inline-actions">
                  <WorkButton variant="primary" onClick={() => void save()} disabled={saving}>
                    {saving ? 'Saving…' : 'Save preferences'}
                  </WorkButton>
                  {profiles.error ? <span className="st-hint">Profiles unavailable; profile choice is locked.</span> : null}
                </div>
              </div>
            )}
          </Card>
        </div>
      ) : null}
    </Page>
  )
}
