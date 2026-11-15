/**
 * Narrow adapters between the eval runner and the transport/retrieval modules.
 *
 * The real implementations live in `server/src/providers/index.ts` (chat and
 * JSON-schema judge calls) and `server/src/rag/index.ts` (retrieval/ingestion).
 * The runner always talks to these small functional types, which makes the
 * runner testable with in-memory stubs and keeps replay/live swapping in one
 * place. No network calls happen unless a live adapter is actually invoked.
 */

import {
  callJsonSchema as providerCallJsonSchema,
  chatOnce,
  recordChat,
  recordJsonSchema,
  type ChatMessage as ProviderChatMessage,
  type ChatRequest as ProviderChatRequest,
} from '../providers/index.ts'
import {
  createCollection,
  getCollectionByName,
  ingestPaths,
  listCollections,
  retrieve as ragRetrieve,
  searchCollection,
  type RetrieveOptions,
} from '../rag/index.ts'
import type {
  Collection,
  ModelId,
  ProviderId,
  RetrievedChunk,
  RunMode,
  TokenUsage,
} from '../../../shared/types.ts'
import type { IngestResult } from '../rag/index.ts'
import type { ThinkingEffort } from '../providers/index.ts'
import { BusinessError } from './errors.ts'

export type { Collection, IngestResult, RetrievedChunk }

/* ------------------------------ functional contracts ------------------------------ */

export type EvalChatRequest = {
  model: ModelId
  /** System prompt, sent separately so the provider can cache the prefix. */
  system: string
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[]
  maxTokens: number
  thinking: boolean
  effort?: ThinkingEffort | undefined
  temperature?: number | undefined
}

export type EvalChatResult = {
  text: string
  thinking: string | null
  usage: TokenUsage
  costUsd: number
  latencyMs: number
  provider: ProviderId
}

export type EvalChatFn = (request: EvalChatRequest) => Promise<EvalChatResult>

export type EvalRetrieveRequest = {
  /** Collection id or unique name. */
  collection: string
  query: string
  k: number
  candidates: number
  rerank: 'off' | 'llm'
  contextBudgetTokens: number
  parentExpansion: boolean
}

export type EvalRetrieveResult = {
  chunks: RetrievedChunk[]
  collectionId: string
  latencyMs: number
}

export type EvalRetrieveFn = (request: EvalRetrieveRequest) => Promise<EvalRetrieveResult>

export type EvalJsonSchemaRequest = {
  model: ModelId
  system: string
  input: string
  schema: Record<string, unknown>
  maxTokens?: number
  temperature?: number
  thinking?: boolean
}

export type EvalJsonSchemaFn = (request: EvalJsonSchemaRequest) => Promise<unknown>

export type AdapterSource = 'injected' | 'provider-module' | 'rag-module'

export type EvalAdapters = {
  chat: EvalChatFn
  retrieve: EvalRetrieveFn
  json: EvalJsonSchemaFn
  mode: RunMode
  provider: ProviderId
  sources: { chat: AdapterSource; retrieve: AdapterSource; json: AdapterSource }
}

export type AdapterOverrides = {
  chat?: EvalChatFn
  retrieve?: EvalRetrieveFn
  json?: EvalJsonSchemaFn
  /** Defaults to `STELLA_MODE` (live unless replay). */
  mode?: RunMode
}

export const resolveRunMode = (mode?: RunMode): RunMode => {
  if (mode) {
    return mode
  }
  return process.env.STELLA_MODE === 'replay' ? 'replay' : 'live'
}

const toProviderMessages = (messages: EvalChatRequest['messages']): ProviderChatMessage[] =>
  messages.map((message) => ({ role: message.role, content: message.content }))

const toProviderRequest = (request: EvalChatRequest): ProviderChatRequest => ({
  model: request.model,
  system: request.system,
  messages: toProviderMessages(request.messages),
  maxTokens: request.maxTokens,
  thinking: request.thinking,
  ...(request.effort !== undefined ? { effort: request.effort } : {}),
  ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
})

/* ------------------------------ default adapters ------------------------------ */

export const liveChatAdapter =
  (mode: RunMode): EvalChatFn =>
  async (request) => {
    const result = await chatOnce(toProviderRequest(request), { mode })
    return {
      text: result.text,
      thinking: result.thinking.length > 0 ? result.thinking : null,
      usage: result.usage,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      provider: result.provider,
    }
  }

/**
 * Retrieval adapter that skips the optional LLM reranker. `stella record` uses
 * it so recorded chat prompts match what replay computes: in replay mode the
 * reranker has no cassettes and deterministically degrades to lexical order, so
 * recording the live-reranked order would produce unreplayable conversation
 * prompts. Replay is a mechanics check, not a quality claim.
 */
export const createReplayStableRetrieveAdapter = (): EvalRetrieveFn => {
  const lexical: EvalRetrieveFn = async (request) =>
    ragRetrieveAdapter({ ...request, rerank: 'off' })
  return lexical
}

export const ragRetrieveAdapter: EvalRetrieveFn = async (request) => {
  const options: RetrieveOptions = {
    collectionId: request.collection,
    query: request.query,
    k: request.k,
    candidates: request.candidates,
    rerank: request.rerank,
    contextBudgetTokens: request.contextBudgetTokens,
    parentExpansion: request.parentExpansion,
  }
  const result = await ragRetrieve(options)
  return { chunks: result.chunks, collectionId: result.collectionId, latencyMs: result.latencyMs }
}

export const providerJsonAdapter =
  (mode: RunMode): EvalJsonSchemaFn =>
  async (request) =>
    providerCallJsonSchema(
      {
        model: request.model,
        system: request.system,
        input: request.input,
        schema: request.schema,
        ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        thinking: request.thinking === true,
      },
      { mode }
    )

/** Real adapters, with optional overrides used by tests and CLI recording. */
export const createAdapters = (overrides: AdapterOverrides = {}): EvalAdapters => {
  const mode = resolveRunMode(overrides.mode)
  return {
    chat: overrides.chat ?? liveChatAdapter(mode),
    retrieve: overrides.retrieve ?? ragRetrieveAdapter,
    json: overrides.json ?? providerJsonAdapter(mode),
    mode,
    provider: mode === 'replay' ? 'replay' : 'deepseek',
    sources: {
      chat: overrides.chat ? 'injected' : 'provider-module',
      retrieve: overrides.retrieve ? 'injected' : 'rag-module',
      json: overrides.json ? 'injected' : 'provider-module',
    },
  }
}

/* ------------------------------ recording (live only) ------------------------------ */

export type RecordingOptions = { cassetteDir?: string }

/**
 * Adapters that call the live provider and write replay cassettes. Used by
 * `stella record`; requires a live API key and never runs in replay mode.
 */
export const createRecordingAdapters = (options: RecordingOptions = {}): AdapterOverrides => ({
  chat: async (request) => {
    const { result } = await recordChat(
      toProviderRequest(request),
      options.cassetteDir ? { dir: options.cassetteDir } : {}
    )
    return {
      text: result.text,
      thinking: result.thinking.length > 0 ? result.thinking : null,
      usage: result.usage,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      provider: result.provider,
    }
  },
  json: async (request) => {
    const { result } = await recordJsonSchema(
      {
        model: request.model,
        system: request.system,
        input: request.input,
        schema: request.schema,
        ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        thinking: request.thinking === true,
      },
      options.cassetteDir ? { cassettesDir: options.cassetteDir } : {}
    )
    return result
  },
})

/* ------------------------------ RAG helpers for CLI/demo ------------------------------ */

export const ensureCollection = async (input: {
  name: string
  description?: string
}): Promise<Collection> => {
  const existing = getCollectionByName(input.name)
  if (existing) {
    return existing
  }
  try {
    return createCollection({
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
    })
  } catch (error) {
    const again = getCollectionByName(input.name)
    if (again) {
      return again
    }
    throw error
  }
}

export const ingestCorpusPaths = async (input: {
  collectionId: string
  paths: string[]
}): Promise<{
  documents: IngestResult[]
  errors: { path: string; message: string; code?: string }[]
}> => {
  return ingestPaths({ collectionId: input.collectionId, paths: input.paths })
}

export const searchCorpus = async (input: {
  collectionId: string
  query: string
  k?: number
  rerank?: 'off' | 'llm'
}): Promise<RetrievedChunk[]> =>
  searchCollection({
    collectionId: input.collectionId,
    query: input.query,
    ...(input.k !== undefined ? { k: input.k } : {}),
    ...(input.rerank !== undefined ? { rerank: input.rerank } : {}),
  })

export const corpusCollections = (): Collection[] => listCollections()

/** Validate a collection name early with an actionable error. */
export const requireCollectionName = (name: string | null | undefined): string => {
  const collection = typeof name === 'string' && name.trim().length > 0 ? name.trim() : null
  if (!collection) {
    throw new BusinessError(
      'retrieval is enabled but the profile has no collection configured',
      'missing_collection',
      400
    )
  }
  if (!getCollectionByName(collection)) {
    throw new BusinessError(
      `collection not found: ${collection} (run \`stella ingest corpus/<name>\` first)`,
      'collection_not_found',
      404
    )
  }
  return collection
}
