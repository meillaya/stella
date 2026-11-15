import type {
  Comparison,
  Dataset,
  DatasetCase,
  DatasetVersion,
  FinetuneExport,
  FinetuneExportStats,
  FinetuneJob,
  Gate,
  Overview,
  Profile,
  Run,
  RunItem,
  SliceComparison,
  Trace,
  TraceSummary,
} from '../../../shared/types.js'

/**
 * Response envelopes for the workbench API. Most routes are documented in
 * docs/API.md; the flexible payload types at the bottom cover endpoints whose
 * exact report shape is still being built on the server.
 */

export type OverviewResponse = Overview

export type TraceListResponse = { items: TraceSummary[]; nextCursor: string | null }

export type TraceDetailResponse = Trace

export type DatasetListResponse = { items: Dataset[] }

export type DatasetDetailResponse = {
  dataset: Dataset
  versions: DatasetVersion[]
  cases: DatasetCase[]
}

export type ImportResponse = {
  imported: number
  skipped: number
  issues?: { line?: number; caseId?: string | null; field?: string; message?: string }[]
}

export type ProfileListResponse = { items: Profile[] }

export type RunListResponse = { items: Run[] }

export type RunItemsResponse = { items: RunItem[] }

export type GateListResponse = { items: Gate[] }

export type CompareResponse = {
  baseline: Run
  candidate: Run
  overall: Comparison
  slices: SliceComparison[]
}

export type FinetuneExportListResponse = { items: FinetuneExport[] }

export type FinetuneJobListResponse = { items: FinetuneJob[] }

export type FinetunePreflightResponse = Partial<FinetuneExportStats> & {
  ok?: boolean
  format?: string
  stats?: Partial<FinetuneExportStats>
  report?: Partial<FinetuneExportStats>
  checks?: { id?: string; ok?: boolean; level?: string; name?: string; status?: string; message?: string; detail?: string }[]
  failures?: string[]
  issues?: (string | { message?: string; detail?: string; severity?: string; field?: string })[]
  warnings?: string[]
  [key: string]: unknown
}
