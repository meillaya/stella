import { useEffect, useId, useMemo, useState } from 'react'
import { useApi } from '../api.js'
import { href } from '../router.js'
import type { Dataset, DatasetVersion, Profile } from '../../../shared/types.js'
import type { DatasetDetailResponse, DatasetListResponse, ProfileListResponse } from './api-types.js'
import { datasetDetailUrl, shortHash } from './lib.js'
import { InlineNotice, LoadError, ProfileLabel } from './components.js'

/**
 * Small data hooks shared by the forms that need a dataset version or a
 * profile. Everything reads through `useApi`; the pages own their writes.
 */

export type DatasetVersionChoices = {
  datasets: Dataset[]
  datasetId: string
  selectDataset: (id: string) => void
  versions: DatasetVersion[]
  versionId: string
  selectVersion: (id: string) => void
  selectedVersion: DatasetVersion | null
  loading: boolean
  error: string | null
  reload: () => void
}

export const useDatasetVersionChoices = (): DatasetVersionChoices => {
  const list = useApi<DatasetListResponse>('/api/datasets')
  const [datasetId, setDatasetId] = useState('')
  const [versionId, setVersionId] = useState('')
  const detail = useApi<DatasetDetailResponse>(datasetId ? datasetDetailUrl(datasetId) : null)

  const datasets = useMemo(() => list.data?.items ?? [], [list.data])

  useEffect(() => {
    if (datasetId) {return}
    const first = datasets[0]
    if (first) {setDatasetId(first.id)}
  }, [datasets, datasetId])

  const detailMatches = Boolean(detail.data && detail.data.dataset.id === datasetId)
  const versions = useMemo(() => {
    if (!detailMatches || !detail.data) {return []}
    return [...detail.data.versions].sort((left, right) => right.version - left.version)
  }, [detailMatches, detail.data])

  useEffect(() => {
    if (versions.length === 0) {
      if (versionId) {setVersionId('')}
      return
    }
    if (!versions.some((version) => version.id === versionId)) {
      const first = versions[0]
      if (first) {setVersionId(first.id)}
    }
  }, [versions, versionId])

  return {
    datasets,
    datasetId,
    selectDataset: (id) => {
      setDatasetId(id)
      setVersionId('')
    },
    versions,
    versionId,
    selectVersion: setVersionId,
    selectedVersion: versions.find((version) => version.id === versionId) ?? null,
    loading: list.loading || (Boolean(datasetId) && detail.loading),
    error: list.error ?? detail.error,
    reload: () => {
      list.reload()
      detail.reload()
    },
  }
}

export const DatasetVersionFields = ({ choices, disabled = false }: { choices: DatasetVersionChoices; disabled?: boolean }) => {
  const datasetFieldId = useId()
  const versionFieldId = useId()
  const noVersions = Boolean(choices.datasetId) && !choices.loading && !choices.error && choices.versions.length === 0
  return (
    <div className="st-w-stack-sm">
      <div className="st-w-field-grid">
        <div className="st-field">
          <label className="st-label" htmlFor={datasetFieldId}>
            Dataset
          </label>
          <select
            id={datasetFieldId}
            className="st-w-select"
            value={choices.datasetId}
            disabled={disabled || choices.loading || choices.datasets.length === 0}
            onChange={(event) => choices.selectDataset(event.target.value)}
          >
            {choices.datasets.length === 0 ? (
              <option value="">{choices.loading ? 'Loading datasets…' : 'No datasets'}</option>
            ) : null}
            {choices.datasets.map((dataset) => (
              <option key={dataset.id} value={dataset.id}>
                {dataset.name} · {dataset.caseCount} cases
              </option>
            ))}
          </select>
          {choices.datasets.length === 0 && !choices.loading && !choices.error ? (
            <div className="st-hint">
              No datasets yet. <a className="st-link" href={href('/datasets')}>Create and snapshot a dataset</a> first.
            </div>
          ) : null}
        </div>
        <div className="st-field">
          <label className="st-label" htmlFor={versionFieldId}>
            Dataset version
          </label>
          <select
            id={versionFieldId}
            className="st-w-select"
            value={choices.versionId}
            disabled={disabled || !choices.datasetId || choices.versions.length === 0}
            onChange={(event) => choices.selectVersion(event.target.value)}
          >
            {choices.versions.length === 0 ? (
              <option value="">{choices.loading ? 'Loading versions…' : 'No snapshots'}</option>
            ) : null}
            {choices.versions.map((version) => (
              <option key={version.id} value={version.id}>
                v{version.version} · {version.caseCount} cases
              </option>
            ))}
          </select>
          {choices.selectedVersion ? (
            <div className="st-hint">
              Snapshot {shortHash(choices.selectedVersion.contentHash)} ·{' '}
              {choices.selectedVersion.anchorStatus.resolved}/{choices.selectedVersion.anchorStatus.total} anchors
              resolve
            </div>
          ) : null}
        </div>
      </div>
      {choices.error ? <LoadError message={choices.error} onRetry={choices.reload} /> : null}
      {noVersions ? (
        <InlineNotice tone="warn">
          This dataset has no snapshot yet. Snapshot it before creating a run.{' '}
          <a className="st-link" href={href(`/datasets/${choices.datasetId}`)}>
            Open dataset
          </a>
        </InlineNotice>
      ) : null}
    </div>
  )
}

export type ProfileChoices = {
  items: Profile[]
  profileId: string
  selectProfile: (id: string) => void
  selected: Profile | null
  loading: boolean
  error: string | null
  reload: () => void
}

const sortProfiles = (profiles: Profile[]): Profile[] =>
  [...profiles].sort((left, right) => {
    const published = Number(right.publishedAt != null) - Number(left.publishedAt != null)
    if (published !== 0) {return published}
    return right.createdAt - left.createdAt
  })

export const useProfileChoices = (): ProfileChoices => {
  const profiles = useApi<ProfileListResponse>('/api/profiles')
  const [profileId, setProfileId] = useState('')
  const items = useMemo(() => sortProfiles(profiles.data?.items ?? []), [profiles.data])

  useEffect(() => {
    if (profileId || items.length === 0) {return}
    const preferred = items.find((profile) => profile.publishedAt != null) ?? items[0]
    if (preferred) {setProfileId(preferred.id)}
  }, [items, profileId])

  return {
    items,
    profileId,
    selectProfile: setProfileId,
    selected: items.find((profile) => profile.id === profileId) ?? null,
    loading: profiles.loading,
    error: profiles.error,
    reload: profiles.reload,
  }
}

export const ProfileField = ({ choices, disabled = false }: { choices: ProfileChoices; disabled?: boolean }) => {
  const fieldId = useId()
  return (
    <div className="st-w-stack-sm">
      <div className="st-field">
        <label className="st-label" htmlFor={fieldId}>
          Profile
        </label>
        <select
          id={fieldId}
          className="st-w-select"
          value={choices.profileId}
          disabled={disabled || choices.loading || choices.items.length === 0}
          onChange={(event) => choices.selectProfile(event.target.value)}
        >
          {choices.items.length === 0 ? (
            <option value="">{choices.loading ? 'Loading profiles…' : 'No profiles'}</option>
          ) : null}
          {choices.items.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} v{profile.version}
              {profile.publishedAt != null ? ' · published' : ' · draft'}
            </option>
          ))}
        </select>
        {choices.selected ? <ProfileLabel profile={choices.selected} /> : null}
        {choices.items.length === 0 && !choices.loading && !choices.error ? (
          <div className="st-hint">
            No profiles yet. <a className="st-link" href={href('/improve')}>Create a profile</a> first.
          </div>
        ) : null}
      </div>
      {choices.error ? <LoadError message={choices.error} onRetry={choices.reload} /> : null}
    </div>
  )
}
