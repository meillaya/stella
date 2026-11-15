/** Fine-tuning public surface: validated exports, preflight, provider plans, jobs. */

export {
  CONTAMINATION_NGRAM_SIZE,
  DEFAULT_SPLIT_RATIOS,
  NEAR_DUPE_THRESHOLD,
  assignSplits,
  buildContaminationIndex,
  contentHash,
  findNearDuplicates,
  isContaminated,
  jaccardEstimate,
  minhashSignature,
  ngramHashes,
  normalizeForDedupe,
  redactPii,
} from './filters.ts'
export type { PiiCounts, RedactionResult, SplitName, SplitRatios } from './filters.ts'

export {
  DEFAULT_FINETUNE_FILTERS,
  FINETUNE_FORMATS,
  buildFinetuneDataset,
  exportFinetune,
  getFinetuneExport,
  listFinetuneExports,
  loadFinetuneSource,
  mapFinetuneExportRow,
  normalizeFinetuneFilters,
  preflightFinetune,
  readExportManifest,
  readExportSplit,
  resolveSourceVersion,
  validateFinetuneExample,
} from './pipeline.ts'
export type {
  BuildInput,
  BuildResult,
  ContaminationReport,
  ExportFinetuneResult,
  FinetuneCheck,
  FinetuneExample,
  FinetuneFilters,
  FinetuneManifest,
  FinetunePreflightReport,
  FinetuneSource,
  FinetuneSourceItem,
} from './pipeline.ts'

export {
  DEEPSEEK_FINETUNE_DOCS,
  DEEPSEEK_UNAVAILABLE_MESSAGE,
  FINETUNE_PROVIDERS,
  planFinetune,
  providerApiKeyEnv,
} from './plans.ts'
export type { FinetunePlan, FinetuneProviderId, PlanFinetuneInput } from './plans.ts'

export {
  createFinetuneJob,
  getFinetuneJob,
  jobEndpoints,
  listFinetuneJobs,
  mapProviderJobStatus,
  pollFinetuneJob,
  refreshFinetuneJob,
  submitFinetuneJob,
} from './jobs.ts'
export type { JobTransport, PollJobResult, SubmitJobResult } from './jobs.ts'
