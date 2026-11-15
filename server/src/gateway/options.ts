import type { FastifyRequest } from 'fastify'
import { config } from '../config.ts'
import { getDb, type Db } from '../db/index.ts'
import type { RetrievedChunk } from '../../../shared/types.ts'

/**
 * Gateway runtime knobs. Production uses the defaults (config + process DB);
 * tests inject a mock upstream base URL, a key, a temp SQLite DB and a fake
 * retriever so nothing touches the network.
 */

export type RetrieveInput = {
  collectionId: string
  query: string
  k?: number
  candidates?: number
  rerank?: 'off' | 'llm'
  contextBudgetTokens?: number
  parentExpansion?: boolean
  db?: Db
}

export type RetrieveOutput = {
  chunks: RetrievedChunk[]
  collectionId: string
  latencyMs: number
}

export type RetrieveFn = (input: RetrieveInput) => Promise<RetrieveOutput>

export type GatewayOptions = {
  /** Upstream API base URL (e.g. `https://api.deepseek.com`). */
  baseUrl?: string
  /** Server-held key. `undefined` uses `config.apiKey`; explicit `null` disables it (BYOK only). */
  apiKey?: string | null
  /** SQLite handle; defaults to the process DB. */
  db?: Db
  fetchImpl?: typeof fetch
  /** Deterministic clock for cost/latency assertions. */
  now?: () => number
  /** Cap for buffered (non-streaming) gateway bodies. */
  maxBodyBytes?: number
  /** Override the RAG retriever (tests). Defaults to `rag.retrieve`. */
  retrieve?: RetrieveFn
}

export type ResolvedGatewayOptions = {
  baseUrl: string
  serverKey: string | null
  getDb: () => Db
  fetchImpl: typeof fetch
  now: () => number
  maxBodyBytes: number
  retrieve: RetrieveFn | null
}

const defaultRetrieve: RetrieveFn = async (input) => {
  // Static import: the RAG contract is published and frozen. Kept in a lazy
  // dynamic import so a missing/broken RAG build degrades to "no context".
  const rag = await import('../rag/index.ts')
  return rag.retrieve(input)
}

export const resolveGatewayOptions = (options: GatewayOptions = {}): ResolvedGatewayOptions => {
  const db = options.db
  return {
    baseUrl: (options.baseUrl ?? config.deepseekBaseUrl).replace(/\/+$/, ''),
    serverKey: options.apiKey === undefined ? config.apiKey : options.apiKey,
    getDb: () => db ?? getDb(),
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? Date.now,
    maxBodyBytes: options.maxBodyBytes ?? config.bodyLimitBytes,
    retrieve: options.retrieve === undefined ? defaultRetrieve : options.retrieve,
  }
}

export type ResolvedAuth = {
  key: string
  source: 'server' | 'request'
}

const headerString = (value: string | string[] | undefined): string | null => {
  if (typeof value === 'string' && value.trim()) {return value.trim()}
  if (Array.isArray(value)) {
    const first = value.find((entry) => entry.trim())
    return first?.trim() ?? null
  }
  return null
}

/**
 * Server-held key first, then the client's own `x-api-key` / bearer token
 * (BYOK). Returns null when neither exists; keys are never logged or echoed.
 */
export const resolveAuth = (
  request: FastifyRequest,
  serverKey: string | null
): ResolvedAuth | null => {
  if (serverKey) {return { key: serverKey, source: 'server' }}
  const apiKey = headerString(request.headers['x-api-key'])
  if (apiKey) {return { key: apiKey, source: 'request' }}
  const authorization = headerString(request.headers.authorization)
  if (authorization && authorization.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice('bearer '.length).trim()
    if (token) {return { key: token, source: 'request' }}
  }
  return null
}

/** Headers the gateway forwards from the client upstream (never auth). */
export const forwardedClientHeaders = (
  request: FastifyRequest
): Record<string, string> => {
  const headers: Record<string, string> = {}
  const beta = headerString(request.headers['anthropic-beta'])
  if (beta) {headers['anthropic-beta'] = beta}
  const version = headerString(request.headers['anthropic-version'])
  if (version) {headers['anthropic-version'] = version}
  return headers
}

export const MISSING_KEY_MESSAGE =
  'Stella has no DeepSeek API key configured. Set DEEPSEEK_API_KEY in .env.local (server key) or send x-api-key / Authorization: Bearer from the client (BYOK).'

export const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, '')
