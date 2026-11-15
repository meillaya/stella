import { useEffect, useRef, useState } from 'react'
import { Modal } from '../../components/base/Modal.js'
import type {
  FinetuneExport,
  FinetuneFormat,
  FinetuneJob,
  ModelId,
  Profile,
  ProfileSpec,
  Run,
} from '../../../shared/types.js'
import { api, useApi } from '../api.js'
import { formatDate, formatRelative, shortId } from '../format.js'
import { href } from '../router.js'
import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  InlineCode,
  LoadingBlock,
  Page,
  PageHeader,
  type Column,
} from '../ui/index.js'
import { IconImprove, IconPlus } from '../ui/icons.js'
import {
  ConfirmModal,
  InlineNotice,
  InputField,
  LoadError,
  SelectField,
  TableFoot,
  WorkButton,
  WorkLink,
} from '../workbench/components.js'
import { DatasetVersionFields, ProfileField, useDatasetVersionChoices, useProfileChoices } from '../workbench/data.js'
import type {
  FinetuneJobListResponse,
  FinetunePreflightResponse,
  ProfileListResponse,
} from '../workbench/api-types.js'
import {
  buildSweepVariants,
  describeApiError,
  finetuneFormatLabel,
  finetuneProviderOptions,
  formatInteger,
  formatUsd,
  preflightNotes,
  profileRetrievalLabel,
  resolvePreflightStats,
  sweepVariantSpec,
  type SweepRerank,
} from '../workbench/lib.js'

/* ------------------------------ profiles ------------------------------ */

const profileColumns = (actions: {
  onNewVersion: (profile: Profile) => void
  onPublish: (profile: Profile) => void
}): Column<Profile>[] => [
  {
    key: 'name',
    header: 'Profile',
    render: (profile) => (
      <div className="st-w-question-cell">
        <div className="st-w-cell-strong">{profile.name}</div>
        <div className="st-w-sub">{profile.parentId ? `Forked from ${shortId(profile.parentId)}` : 'Root profile'}</div>
      </div>
    ),
  },
  {
    key: 'version',
    header: 'Version',
    width: 90,
    render: (profile) => <span className="st-mono">v{profile.version}</span>,
  },
  {
    key: 'state',
    header: 'State',
    width: 116,
    render: (profile) =>
      profile.publishedAt != null ? (
        <Badge tone="pass">Published</Badge>
      ) : (
        <Badge tone="neutral" outline>
          Draft
        </Badge>
      ),
  },
  {
    key: 'model',
    header: 'Model',
    width: 150,
    render: (profile) => (
      <span className="st-w-muted st-small">
        {profile.spec.model.id} · thinking {profile.spec.model.thinking ? 'on' : 'off'}
      </span>
    ),
  },
  {
    key: 'retrieval',
    header: 'Retrieval',
    width: 150,
    render: (profile) => <span className="st-small">{profileRetrievalLabel(profile.spec)}</span>,
  },
  {
    key: 'created',
    header: 'Created',
    width: 110,
    align: 'right',
    render: (profile) => (
      <span className="st-w-sub" style={{ marginTop: 0 }} title={formatDate(profile.createdAt)}>
        {formatRelative(profile.createdAt)}
      </span>
    ),
  },
  {
    key: 'actions',
    header: '',
    width: 200,
    align: 'right',
    render: (profile) => (
      <div className="st-w-inline-actions" style={{ justifyContent: 'flex-end' }}>
        <WorkButton size="s" variant="ghost" onClick={() => actions.onNewVersion(profile)}>
          New version
        </WorkButton>
        {profile.publishedAt == null ? (
          <WorkButton size="s" onClick={() => actions.onPublish(profile)}>
            Publish
          </WorkButton>
        ) : null}
      </div>
    ),
  },
]

export const ImprovePage = () => {
  const profiles = useApi<ProfileListResponse>('/api/profiles')
  const jobs = useApi<FinetuneJobListResponse>('/api/finetune/jobs')
  const [editorSource, setEditorSource] = useState<Profile | null | undefined>(undefined)
  const [publishing, setPublishing] = useState<Profile | null>(null)
  const [publishBusy, setPublishBusy] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const publish = async () => {
    if (!publishing) {return}
    setPublishBusy(true)
    setPublishError(null)
    try {
      const profile = await api.post<Profile>(`/api/profiles/${encodeURIComponent(publishing.id)}/publish`)
      setPublishing(null)
      setNotice(`Published ${profile.name} v${profile.version}. New chats use it as the active profile.`)
      profiles.reload()
    } catch (cause) {
      setPublishError(describeApiError(cause))
    } finally {
      setPublishBusy(false)
    }
  }

  return (
    <Page className="st-w-page">
      <PageHeader
        title="Improve"
        description="Version the model, retrieval and judge settings, sweep retrieval variants, and prepare validated fine-tuning data."
        actions={
          <WorkButton variant="primary" onClick={() => setEditorSource(null)}>
            <IconPlus size={14} />
            New profile
          </WorkButton>
        }
      />

      {notice ? (
        <div style={{ marginBottom: 14 }}>
          <InlineNotice tone="success">{notice}</InlineNotice>
        </div>
      ) : null}

      <div className="st-stack">
        <Card
          title="Profiles"
          subtitle="Immutable profile versions. Publishing activates the version for new chats."
          flush
          actions={
            <WorkLink href={href('/settings')} variant="ghost" className="st-w-btn-s">
              Active profile settings
            </WorkLink>
          }
        >
          {profiles.error && !profiles.data ? (
            <div style={{ padding: 18 }}>
              <LoadError message={profiles.error} onRetry={profiles.reload} />
            </div>
          ) : profiles.loading && !profiles.data ? (
            <LoadingBlock />
          ) : (profiles.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              icon={<IconImprove size={18} />}
              title="No profiles yet"
              description="A profile pins the model, thinking effort, retrieval settings, prompt template and judge threshold used by a run."
              action={<WorkButton onClick={() => setEditorSource(null)}>New profile</WorkButton>}
            />
          ) : (
            <DataTable
              columns={profileColumns({
                onNewVersion: (profile) => setEditorSource(profile),
                onPublish: (profile) => {
                  setPublishError(null)
                  setPublishing(profile)
                },
              })}
              rows={profiles.data?.items ?? []}
              getKey={(profile) => profile.id}
              ariaLabel="Profiles"
              footer={
                <TableFoot>
                  {profiles.data?.items.length} profile version
                  {(profiles.data?.items.length ?? 0) === 1 ? '' : 's'} · publish makes a version active; drafts are
                  never used implicitly
                </TableFoot>
              }
            />
          )}
        </Card>

        <SweepCard baseProfiles={profiles} />

        <FineTuneCard jobs={jobs} />
      </div>

      {editorSource !== undefined ? (
        <ProfileEditorModal
          source={editorSource}
          onClose={() => setEditorSource(undefined)}
          onSaved={(profile) => {
            setEditorSource(undefined)
            setNotice(`Created ${profile.name} v${profile.version}. Publish it when it is ready.`)
            profiles.reload()
          }}
        />
      ) : null}

      {publishing ? (
        <ConfirmModal
          title={`Publish ${publishing.name} v${publishing.version}?`}
          confirmLabel="Publish and activate"
          busy={publishBusy}
          error={publishError}
          onClose={() => setPublishing(null)}
          onConfirm={() => void publish()}
        >
          <p className="st-w-muted">
            Publishing marks the version as released and makes it the active profile for new chats and runs. Existing
            runs keep the profile they used.
          </p>
        </ConfirmModal>
      ) : null}
    </Page>
  )
}

const ProfileEditorModal = ({
  source,
  onClose,
  onSaved,
}: {
  source: Profile | null
  onClose: () => void
  onSaved: (profile: Profile) => void
}) => {
  const [name, setName] = useState(source?.name ?? '')
  const [modelId, setModelId] = useState<ModelId>(source?.spec.model.id ?? 'deepseek-flash')
  const [thinking, setThinking] = useState(source?.spec.model.thinking ?? true)
  const [effort, setEffort] = useState<'low' | 'high' | 'max'>(source?.spec.model.effort ?? 'high')
  const [maxTokens, setMaxTokens] = useState(String(source?.spec.model.maxTokens ?? 8192))
  const [retrievalEnabled, setRetrievalEnabled] = useState(source?.spec.retrieval.enabled ?? true)
  const [collection, setCollection] = useState(source?.spec.retrieval.collection ?? '')
  const [k, setK] = useState(String(source?.spec.retrieval.k ?? 6))
  const [candidates, setCandidates] = useState(String(source?.spec.retrieval.candidates ?? 24))
  const [rerank, setRerank] = useState<'off' | 'llm'>(source?.spec.retrieval.rerank ?? 'off')
  const [contextBudget, setContextBudget] = useState(String(source?.spec.retrieval.contextBudgetTokens ?? 6000))
  const [parentExpansion, setParentExpansion] = useState(source?.spec.retrieval.parentExpansion ?? false)
  const [template, setTemplate] = useState<'plain' | 'rag-v1' | 'rag-v2'>(source?.spec.prompt.template ?? 'rag-v1')
  const [passScore, setPassScore] = useState(String(source?.spec.judge.passScore ?? 2))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('A profile name is required.')
      return
    }
    const maxTokensValue = Number(maxTokens)
    if (!Number.isInteger(maxTokensValue) || maxTokensValue <= 0) {
      setError('Max tokens must be a positive whole number.')
      return
    }
    const kValue = Number(k)
    const candidatesValue = Number(candidates)
    if (!Number.isInteger(kValue) || kValue < 1) {
      setError('Retrieval k must be a positive whole number.')
      return
    }
    if (!Number.isInteger(candidatesValue) || candidatesValue < kValue) {
      setError('Candidate count must be a whole number at least as large as k.')
      return
    }
    const contextValue = Number(contextBudget)
    if (!Number.isInteger(contextValue) || contextValue < 0) {
      setError('Context budget must be a non-negative whole number of tokens.')
      return
    }
    const scoreValue = Number(passScore)
    if (!Number.isInteger(scoreValue) || scoreValue < 0 || scoreValue > 3) {
      setError('Judge pass score must be a whole number from 0 to 3.')
      return
    }

    const spec: ProfileSpec = {
      model: {
        id: modelId,
        thinking,
        ...(thinking ? { effort } : {}),
        maxTokens: maxTokensValue,
      },
      retrieval: {
        enabled: retrievalEnabled,
        collection: collection.trim() || null,
        k: kValue,
        candidates: candidatesValue,
        rerank,
        contextBudgetTokens: contextValue,
        parentExpansion,
      },
      prompt: { template, citationStyle: 'bracket' },
      judge: { rubric: 'judge-v1', passScore: scoreValue },
    }

    setBusy(true)
    setError(null)
    try {
      const profile = await api.post<Profile>('/api/profiles', {
        name: trimmedName,
        spec,
        ...(source ? { parentId: source.id } : {}),
      })
      onSaved(profile)
    } catch (cause) {
      setError(describeApiError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={source ? `New version of ${source.name}` : 'New profile'}
      closable
      className="st-w-modal"
      mainClassName="st-w-modal-scroll"
      onClose={onClose}
      footer={
        <>
          <WorkButton onClick={onClose} disabled={busy}>
            Cancel
          </WorkButton>
          <WorkButton variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Creating…' : 'Create profile'}
          </WorkButton>
        </>
      }
    >
      <div className="st-w-form">
        {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
        <InputField
          label="Name"
          value={name}
          maxLength={120}
          placeholder="Support grounded"
          onChange={(event) => setName(event.target.value)}
          hint={
            source
              ? 'Using the same name creates the next version after the source profile.'
              : 'Profiles are versioned by name; the first version is v1.'
          }
        />
        <div className="st-w-field-grid">
          <SelectField
            label="Model"
            value={modelId}
            onChange={(value) => setModelId(value as ModelId)}
            options={[
              { value: 'deepseek-flash', label: 'deepseek-flash' },
              { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
            ]}
          />
          <SelectField
            label="Thinking effort"
            value={effort}
            disabled={!thinking}
            onChange={(value) => setEffort(value as 'low' | 'high' | 'max')}
            options={[
              { value: 'low', label: 'Low' },
              { value: 'high', label: 'High' },
              { value: 'max', label: 'Max' },
            ]}
            hint={thinking ? undefined : 'Effort only applies when thinking is enabled.'}
          />
        </div>
        <div className="st-w-field-grid">
          <InputField
            label="Max output tokens"
            type="number"
            min={1}
            step={1}
            value={maxTokens}
            onChange={(event) => setMaxTokens(event.target.value)}
          />
          <div className="st-field">
            <span className="st-label">Thinking</span>
            <label className="st-w-checkbox">
              <input type="checkbox" checked={thinking} onChange={(event) => setThinking(event.target.checked)} />
              <span>Enable thinking mode</span>
            </label>
          </div>
        </div>

        <div className="st-field">
          <span className="st-label">Retrieval</span>
          <label className="st-w-checkbox">
            <input
              type="checkbox"
              checked={retrievalEnabled}
              onChange={(event) => setRetrievalEnabled(event.target.checked)}
            />
            <span>Retrieve evidence before answering</span>
          </label>
        </div>
        {retrievalEnabled ? (
          <>
            <InputField
              label="Collection"
              value={collection}
              placeholder="support"
              onChange={(event) => setCollection(event.target.value)}
              hint="Collection id or name. Leave blank to use the runner's default collection."
            />
            <div className="st-w-field-grid">
              <InputField
                label="k (chunks returned)"
                type="number"
                min={1}
                step={1}
                value={k}
                onChange={(event) => setK(event.target.value)}
              />
              <InputField
                label="Candidate pool"
                type="number"
                min={1}
                step={1}
                value={candidates}
                onChange={(event) => setCandidates(event.target.value)}
                hint="Must be at least k."
              />
              <SelectField
                label="Rerank"
                value={rerank}
                onChange={(value) => setRerank(value as 'off' | 'llm')}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'llm', label: 'LLM rerank' },
                ]}
              />
              <InputField
                label="Context budget (tokens)"
                type="number"
                min={0}
                step={100}
                value={contextBudget}
                onChange={(event) => setContextBudget(event.target.value)}
              />
            </div>
            <label className="st-w-checkbox">
              <input
                type="checkbox"
                checked={parentExpansion}
                onChange={(event) => setParentExpansion(event.target.checked)}
              />
              <span>Expand to parent chunks when citing</span>
            </label>
          </>
        ) : null}

        <div className="st-w-field-grid">
          <SelectField
            label="Prompt template"
            value={template}
            onChange={(value) => setTemplate(value as 'plain' | 'rag-v1' | 'rag-v2')}
            options={[
              { value: 'plain', label: 'Plain chat' },
              { value: 'rag-v1', label: 'RAG v1' },
              { value: 'rag-v2', label: 'RAG v2' },
            ]}
          />
          <InputField
            label="Judge pass score (0–3)"
            type="number"
            min={0}
            max={3}
            step={1}
            value={passScore}
            onChange={(event) => setPassScore(event.target.value)}
            hint="Judge rubric scores range from 0 to 3; answers at or above this threshold pass."
          />
        </div>
      </div>
    </Modal>
  )
}

/* ------------------------------ retrieval sweep ------------------------------ */

type SweepOutcome = {
  key: string
  label: string
  status: 'queued' | 'failed' | 'skipped'
  runId?: string
  error?: string
}

const SweepCard = ({ baseProfiles }: { baseProfiles: ReturnType<typeof useApi<ProfileListResponse>> }) => {
  const datasets = useDatasetVersionChoices()
  const profiles = useProfileChoices()
  const [selectedKs, setSelectedKs] = useState<number[]>([3, 6, 8])
  const [selectedReranks, setSelectedReranks] = useState<SweepRerank[]>(['off', 'llm'])
  const [budget, setBudget] = useState('0.50')
  const [offPeak, setOffPeak] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [running, setRunning] = useState(false)
  const [outcomes, setOutcomes] = useState<SweepOutcome[]>([])
  const [error, setError] = useState<string | null>(null)

  const orderedReranks = (['off', 'llm'] as SweepRerank[]).filter((value) => selectedReranks.includes(value))
  const variants = buildSweepVariants([...selectedKs].sort((left, right) => left - right), orderedReranks)
  const budgetValue = Number(budget)
  const totalBudget = Number.isFinite(budgetValue) && budgetValue > 0 ? budgetValue * variants.length : 0
  const base = profiles.selected
  const canRun =
    Boolean(datasets.versionId) &&
    Boolean(base) &&
    Boolean(base?.spec.retrieval.enabled) &&
    variants.length > 0 &&
    Number.isFinite(budgetValue) &&
    budgetValue > 0 &&
    !running

  const toggleK = (value: number) =>
    setSelectedKs((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
    )
  const toggleRerank = (value: SweepRerank) =>
    setSelectedReranks((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
    )

  const start = async () => {
    setConfirming(false)
    setRunning(true)
    setError(null)
    setOutcomes([])
    const collected: SweepOutcome[] = []
    const currentBase = profiles.selected
    if (!currentBase) {
      setRunning(false)
      setError('Choose a base profile before starting the sweep.')
      return
    }
    for (const [index, variant] of variants.entries()) {
      const key = `${variant.k}-${variant.rerank}`
      const label = `${variant.label}`
      try {
        const profile = await api.post<Profile>('/api/profiles', {
          name: `${currentBase.name} · sweep k${variant.k} ${variant.rerank}`.slice(0, 120),
          spec: sweepVariantSpec(currentBase.spec, variant.k, variant.rerank),
          parentId: currentBase.id,
        })
        const run = await api.post<Run>('/api/runs', {
          datasetVersionId: datasets.versionId,
          profileId: profile.id,
          budgetUsd: budgetValue,
          offPeak,
        })
        collected.push({ key, label, status: 'queued', runId: run.id })
      } catch (cause) {
        const message = describeApiError(cause)
        collected.push({ key, label, status: 'failed', error: message })
        for (const skipped of variants.slice(index + 1)) {
          collected.push({ key: `${skipped.k}-${skipped.rerank}`, label: skipped.label, status: 'skipped' })
        }
        setOutcomes([...collected])
        setError(message)
        break
      }
      setOutcomes([...collected])
    }
    setRunning(false)
    baseProfiles.reload()
    profiles.reload()
  }

  return (
    <Card
      title="Retrieval sweep"
      subtitle="Queue one run per k × rerank variant against a dataset snapshot."
      actions={
        <WorkLink href={href('/runs')} variant="ghost" className="st-w-btn-s">
          View runs
        </WorkLink>
      }
    >
      <div className="st-w-sweep-grid">
        <div className="st-w-form">
          <p className="st-w-muted st-small">
            Stella has no single sweep endpoint: each variant is created as an unpublished profile and queued through
            the normal run API. Review the budget before starting.
          </p>
          <DatasetVersionFields choices={datasets} disabled={running} />
          <ProfileField choices={profiles} disabled={running} />
          {base && !base.spec.retrieval.enabled ? (
            <InlineNotice tone="warn">
              This base profile has retrieval disabled. A k/rerank sweep would not change retrieval. Choose a
              retrieval-enabled profile or create one first.
            </InlineNotice>
          ) : null}
          <div className="st-w-field-grid">
            <div className="st-field">
              <span className="st-label">k variants</span>
              <div className="st-w-checks">
                {[3, 6, 8].map((value) => (
                  <label key={value} className="st-w-checkbox">
                    <input
                      type="checkbox"
                      checked={selectedKs.includes(value)}
                      disabled={running}
                      onChange={() => toggleK(value)}
                    />
                    <span>k = {value}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="st-field">
              <span className="st-label">Rerank variants</span>
              <div className="st-w-checks">
                <label className="st-w-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedReranks.includes('off')}
                    disabled={running}
                    onChange={() => toggleRerank('off')}
                  />
                  <span>Off</span>
                </label>
                <label className="st-w-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedReranks.includes('llm')}
                    disabled={running}
                    onChange={() => toggleRerank('llm')}
                  />
                  <span>LLM rerank</span>
                </label>
              </div>
            </div>
          </div>
          <div className="st-w-field-grid">
            <InputField
              label="Budget per run (USD)"
              type="number"
              min={0.01}
              step={0.01}
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
              hint="Each queued run enforces this cap independently."
            />
            <div className="st-field">
              <span className="st-label">Off-peak</span>
              <label className="st-w-checkbox">
                <input type="checkbox" checked={offPeak} onChange={(event) => setOffPeak(event.target.checked)} />
                <span>Request off-peak pricing</span>
              </label>
            </div>
          </div>

          <div className="st-w-notice" data-tone="info">
            <div className="st-w-notice-body">
              <div className="st-w-notice-title">
                {variants.length} run{variants.length === 1 ? '' : 's'} · maximum spend{' '}
                {totalBudget > 0 ? formatUsd(totalBudget) : '—'}
              </div>
              <div className="st-w-notice-text">
                {variants.length > 0
                  ? variants.map((variant) => variant.label).join(' · ')
                  : 'Select at least one k and one rerank variant.'}
              </div>
            </div>
          </div>

          {!confirming ? (
            <div className="st-w-inline-actions">
              <WorkButton
                variant="primary"
                disabled={!canRun}
                title={
                  running
                    ? 'The sweep is already queueing runs.'
                    : !datasets.versionId
                      ? 'Choose a dataset version first.'
                      : !base
                        ? 'Choose a base profile first.'
                        : !base.spec.retrieval.enabled
                          ? 'The base profile has retrieval disabled.'
                          : variants.length === 0
                            ? 'Select at least one variant.'
                            : !Number.isFinite(budgetValue) || budgetValue <= 0
                              ? 'Enter a positive budget per run.'
                              : undefined
                }
                onClick={() => setConfirming(true)}
              >
                Queue sweep
              </WorkButton>
              {running ? <span className="st-hint">Queueing runs…</span> : null}
            </div>
          ) : (
            <div className="st-w-notice" data-tone="warn">
              <div className="st-w-notice-body">
                <div className="st-w-notice-title">
                  Queue {variants.length} run{variants.length === 1 ? '' : 's'} with a maximum total spend of{' '}
                  {formatUsd(totalBudget)}?
                </div>
                <div className="st-w-notice-text">
                  This creates {variants.length} unpublished profile version{variants.length === 1 ? '' : 's'} and
                  starts the runs immediately. Runs are asynchronous and cannot be un-spent.
                </div>
                <div className="st-w-inline-actions" style={{ marginTop: 8 }}>
                  <WorkButton variant="primary" size="s" onClick={() => void start()}>
                    Confirm sweep
                  </WorkButton>
                  <WorkButton size="s" variant="ghost" onClick={() => setConfirming(false)}>
                    Cancel
                  </WorkButton>
                </div>
              </div>
            </div>
          )}

          {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
        </div>

        <div className="st-w-stack-sm">
          <div className="st-label">Sweep log</div>
          {outcomes.length === 0 ? (
            <p className="st-hint">
              No runs queued in this session. Results appear here with direct links to each run.
            </p>
          ) : (
            <div className="st-w-variant-list">
              {outcomes.map((outcome) => (
                <div key={outcome.key} className="st-w-variant-row">
                  <span>{outcome.label}</span>
                  {outcome.status === 'queued' && outcome.runId ? (
                    <a className="st-link st-small" href={href(`/runs/${outcome.runId}`)}>
                      Run {shortId(outcome.runId)}
                    </a>
                  ) : outcome.status === 'failed' ? (
                    <Badge tone="fail">Failed</Badge>
                  ) : (
                    <Badge tone="neutral" outline>
                      Not queued
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          )}
          {outcomes.some((outcome) => outcome.status === 'failed') ? (
            <p className="st-hint">
              The sweep stopped at the first failure; later variants were left untouched.
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  )
}

/* ------------------------------ fine-tuning ------------------------------ */

const jobStatusTone = (job: FinetuneJob): 'pass' | 'fail' | 'warn' | 'info' | 'neutral' => {
  if (job.status === 'succeeded') {return 'pass'}
  if (job.status === 'failed') {return 'fail'}
  if (job.status === 'cancelled') {return 'warn'}
  if (job.status === 'running' || job.status === 'submitted') {return 'info'}
  return 'neutral'
}

const jobColumns: Column<FinetuneJob>[] = [
  {
    key: 'provider',
    header: 'Provider',
    render: (job) => (
      <div>
        <div className="st-w-cell-strong">{job.provider}</div>
        <div className="st-w-sub">{job.baseModel}</div>
      </div>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    width: 130,
    render: (job) => <Badge tone={jobStatusTone(job)}>{job.status}</Badge>,
  },
  {
    key: 'export',
    header: 'Export',
    width: 110,
    render: (job) => <span className="st-mono st-small">{shortId(job.exportId)}</span>,
  },
  {
    key: 'external',
    header: 'External id / error',
    render: (job) => (
      <span className="st-w-table-mono">{job.externalId ?? job.error ?? '—'}</span>
    ),
  },
  {
    key: 'created',
    header: 'Created',
    width: 110,
    align: 'right',
    render: (job) => (
      <span className="st-w-sub" style={{ marginTop: 0 }} title={formatDate(job.createdAt)}>
        {formatRelative(job.createdAt)}
      </span>
    ),
  },
]

const FineTuneCard = ({ jobs }: { jobs: ReturnType<typeof useApi<FinetuneJobListResponse>> }) => {
  const datasets = useDatasetVersionChoices()
  const [format, setFormat] = useState<FinetuneFormat>('sft')
  const [report, setReport] = useState<FinetunePreflightResponse | null>(null)
  const [preflightBusy, setPreflightBusy] = useState(false)
  const [preflightError, setPreflightError] = useState<string | null>(null)
  const [exportRecord, setExportRecord] = useState<FinetuneExport | null>(null)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [provider, setProvider] = useState<string>('together')
  const [baseModel, setBaseModel] = useState('')
  const [jobBusy, setJobBusy] = useState(false)
  const [jobError, setJobError] = useState<string | null>(null)
  const [jobNotice, setJobNotice] = useState<string | null>(null)
  const datasetKey = `${datasets.versionId}:${format}`
  const lastKey = useRef(datasetKey)

  useEffect(() => {
    if (lastKey.current === datasetKey) {return}
    lastKey.current = datasetKey
    setReport(null)
    setExportRecord(null)
    setPreflightError(null)
    setExportError(null)
    setJobNotice(null)
  }, [datasetKey])

  const stats = resolvePreflightStats(report)
  const notes = preflightNotes(report)
  const canPreflight = Boolean(datasets.versionId) && !preflightBusy
  const preflightFailed = report?.ok === false
  const canExport = Boolean(report) && !preflightFailed && !exportBusy && !preflightBusy
  const localProvider = provider === 'unsloth' || provider === 'axolotl'
  const canCreateJob = Boolean(exportRecord) && !localProvider && !jobBusy
  const planCommand = exportRecord
    ? `pnpm exec stella finetune plan --export ${exportRecord.id} --provider ${provider}`
    : null

  const runPreflight = async () => {
    if (!datasets.versionId) {return}
    setPreflightBusy(true)
    setPreflightError(null)
    setReport(null)
    setExportRecord(null)
    try {
      const response = await api.post<FinetunePreflightResponse>('/api/finetune/preflight', {
        datasetVersionId: datasets.versionId,
        format,
      })
      setReport(response)
    } catch (cause) {
      setPreflightError(describeApiError(cause))
    } finally {
      setPreflightBusy(false)
    }
  }

  const createExport = async () => {
    if (!datasets.versionId) {return}
    setExportBusy(true)
    setExportError(null)
    try {
      const exported = await api.post<FinetuneExport>('/api/finetune/exports', {
        datasetVersionId: datasets.versionId,
        format,
      })
      setExportRecord(exported)
    } catch (cause) {
      setExportError(describeApiError(cause))
    } finally {
      setExportBusy(false)
    }
  }

  const createJob = async () => {
    if (!exportRecord || localProvider) {return}
    setJobBusy(true)
    setJobError(null)
    setJobNotice(null)
    try {
      const job = await api.post<FinetuneJob>('/api/finetune/jobs', {
        exportId: exportRecord.id,
        provider,
        ...(baseModel.trim() ? { baseModel: baseModel.trim() } : {}),
      })
      setJobNotice(`External job ${job.id} recorded for ${job.provider} (${job.baseModel}).`)
      jobs.reload()
    } catch (cause) {
      setJobError(describeApiError(cause))
    } finally {
      setJobBusy(false)
    }
  }

  return (
    <Card
      title="Fine-tuning data"
      subtitle="Validate, export and hand off training data. Stella never claims a tuned model ran."
    >
      <div className="st-w-form">
        <InlineNotice tone="info" title="Fine-tuning is external by design">
          DeepSeek does not offer a fine-tuning endpoint. Stella validates, redacts and splits your data, exports a
          provider-ready file, and records the external training plan. Training itself happens in your provider’s
          tooling or an OpenAI-compatible endpoint.
        </InlineNotice>

        <div className="st-w-ft-grid">
          <div className="st-w-form">
            <DatasetVersionFields choices={datasets} disabled={preflightBusy || exportBusy} />
            <SelectField
              label="Export format"
              value={format}
              onChange={(value) => setFormat(value as FinetuneFormat)}
              options={(Object.keys(finetuneFormatLabel) as FinetuneFormat[]).map((value) => ({
                value,
                label: finetuneFormatLabel[value],
              }))}
            />
            <div className="st-w-inline-actions">
              <WorkButton
                disabled={!canPreflight}
                title={!datasets.versionId ? 'Choose a dataset version first.' : undefined}
                onClick={() => void runPreflight()}
              >
                {preflightBusy ? 'Checking…' : 'Run preflight'}
              </WorkButton>
              <WorkButton
                variant="primary"
                disabled={!canExport}
                title={
                  !report
                    ? 'Run preflight before exporting.'
                    : preflightFailed
                      ? 'Preflight found blocking issues; fix the data before exporting.'
                      : undefined
                }
                onClick={() => void createExport()}
              >
                {exportBusy ? 'Exporting…' : 'Create export'}
              </WorkButton>
            </div>
            <p className="st-hint">
              Preflight runs dedupe, PII redaction, split assignment and contamination checks. Export stays disabled
              until a preflight succeeds for the selected version and format.
            </p>

            {preflightError ? (
              <InlineNotice tone="error">
                {preflightError}
                <div style={{ marginTop: 8 }}>
                  <WorkButton
                    size="s"
                    onClick={() => {
                      setPreflightError(null)
                      void runPreflight()
                    }}
                  >
                    Retry preflight
                  </WorkButton>
                </div>
              </InlineNotice>
            ) : null}

            {report ? (
              <div className="st-w-stack-sm">
                <div className="st-row-between">
                  <span className="st-label">Preflight report</span>
                  {report.ok === false ? (
                    <Badge tone="fail">Blocking issues</Badge>
                  ) : report.ok === true ? (
                    <Badge tone="pass">Preflight passed</Badge>
                  ) : null}
                </div>
                <div className="st-w-ft-stats">
                  <Metric label="Examples" value={formatInteger(stats.examples)} />
                  <Metric label="Dropped" value={formatInteger(stats.dropped)} />
                  <Metric label="Duplicates" value={formatInteger(stats.duplicates)} />
                  <Metric label="PII redactions" value={formatInteger(stats.piiRedactions)} />
                  <Metric label="Contamination" value={formatInteger(stats.contamination)} />
                  <Metric label="Estimated tokens" value={formatInteger(stats.estimatedTokens)} />
                  <Metric
                    label="Splits"
                    value={`${stats.train ?? '—'} / ${stats.val ?? '—'} / ${stats.holdout ?? '—'}`}
                  />
                  <Metric label="Format" value={finetuneFormatLabel[format]} />
                </div>
                {notes.length > 0 ? (
                  <ul className="st-w-issue-list">
                    {notes.slice(0, 8).map((note, index) => (
                      <li key={index}>{note}</li>
                    ))}
                  </ul>
                ) : (
                  <InlineNotice tone="success">Preflight returned no issues or warnings.</InlineNotice>
                )}
                {preflightFailed ? (
                  <InlineNotice tone="error" title="Export is blocked until preflight passes">
                    Review the failed checks above, adjust the dataset or filters, and run preflight again.
                  </InlineNotice>
                ) : null}
              </div>
            ) : null}

            {exportError ? <InlineNotice tone="error">{exportError}</InlineNotice> : null}
            {exportRecord ? (
              <div className="st-w-stack-sm">
                <div className="st-label">Export ready</div>
                <div className="st-w-metric">
                  <span className="st-w-metric-label">
                    {finetuneFormatLabel[exportRecord.format]} · {exportRecord.datasetName} v
                    {exportRecord.datasetVersion}
                  </span>
                  <span className="st-w-job-path">{exportRecord.path}</span>
                  <span className="st-w-metric-foot">
                    Manifest {exportRecord.manifestPath}
                  </span>
                </div>
                <p className="st-hint">
                  The file stays on the server. Point your training tooling at the path above; Stella does not upload
                  it to DeepSeek.
                </p>
              </div>
            ) : null}
          </div>

          <div className="st-w-form">
            <div className="st-label">External training job or plan</div>
            <p className="st-hint">
              {exportRecord
                ? `Hand off export ${shortId(exportRecord.id)} to an external provider or generate a local plan.`
                : 'Create an export first; the handoff references its manifest.'}
            </p>
            <SelectField
              label="Provider"
              value={provider}
              onChange={setProvider}
              options={finetuneProviderOptions.map((value) => ({
                value,
                label:
                  value === 'openai-compatible'
                    ? 'OpenAI-compatible endpoint'
                    : value === 'unsloth' || value === 'axolotl'
                      ? `${value.charAt(0).toUpperCase() + value.slice(1)} (local plan)`
                      : value.charAt(0).toUpperCase() + value.slice(1),
              }))}
              disabled={!exportRecord}
            />
            {localProvider ? (
              <InlineNotice tone="info" title="This provider runs on your machine">
                {exportRecord ? (
                  <>
                    Unsloth and Axolotl do not accept remote jobs from Stella. Generate the plan with:
                    <div style={{ marginTop: 6 }}>
                      <InlineCode>{planCommand}</InlineCode>
                    </div>
                  </>
                ) : (
                  'Create an export first; the CLI plan command needs its export id.'
                )}
              </InlineNotice>
            ) : (
              <>
                <InputField
                  label="Base model (optional)"
                  value={baseModel}
                  placeholder="Provider default if left blank"
                  onChange={(event) => setBaseModel(event.target.value)}
                  hint="Leave blank to use the provider's plan default. This is not a DeepSeek API model id."
                  disabled={!exportRecord}
                />
                <WorkButton
                  disabled={!canCreateJob}
                  title={!exportRecord ? 'Create an export first.' : undefined}
                  onClick={() => void createJob()}
                >
                  {jobBusy ? 'Submitting…' : 'Submit external job'}
                </WorkButton>
                <p className="st-hint">
                  Together and OpenAI-compatible jobs use the provider API key configured on the Stella server. No
                  training request is sent to DeepSeek, and a job record is not evidence that a tuned model exists.
                </p>
              </>
            )}
            {jobError ? <InlineNotice tone="error">{jobError}</InlineNotice> : null}
            {jobNotice ? <InlineNotice tone="success">{jobNotice}</InlineNotice> : null}
          </div>
        </div>

        <div>
          <div className="st-label" style={{ marginBottom: 6 }}>
            External jobs
          </div>
          {jobs.error && !jobs.data ? (
            <LoadError message={jobs.error} onRetry={jobs.reload} />
          ) : jobs.loading && !jobs.data ? (
            <LoadingBlock />
          ) : (jobs.data?.items.length ?? 0) === 0 ? (
            <p className="st-hint">No external plans recorded yet.</p>
          ) : (
            <DataTable
              columns={jobColumns}
              rows={jobs.data?.items ?? []}
              getKey={(job) => job.id}
              ariaLabel="Fine-tuning jobs"
              footer={
                <TableFoot>
                  {jobs.data?.items.length} external job record{(jobs.data?.items.length ?? 0) === 1 ? '' : 's'} ·
                  status reflects the provider handoff, not DeepSeek training
                </TableFoot>
              }
            />
          )}
        </div>
      </div>
    </Card>
  )
}

const Metric = ({ label, value }: { label: string; value: string }) => (
  <div className="st-w-metric">
    <span className="st-w-metric-label">{label}</span>
    <span className="st-w-metric-value">{value}</span>
  </div>
)
