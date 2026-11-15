import { createHash } from 'node:crypto'
import { DEFAULT_MODEL, asModelId, computeCost, type CostBreakdown } from '../../../shared/pricing.ts'
import type { ModelId, PricingBasis, TokenUsage } from '../../../shared/types.ts'

/**
 * Canonical provider contracts.
 *
 * These modules are transport-only: they never touch Fastify, the database or
 * the UI. Evals, the CLI and the gateway all import from `./index.ts`.
 * Requests are Anthropic-compatible chat messages, so the same request shape
 * can later be served by any compatible endpoint.
 */

export const DEFAULT_MAX_TOKENS = 4096

export type ChatRole = 'system' | 'user' | 'assistant'

export type ChatMessage = {
  role: ChatRole
  content: string
}

export type ThinkingEffort = 'low' | 'high' | 'max'

/** A single non-streaming chat turn. `system` is sent separately (cache-friendly). */
export type ChatRequest = {
  model?: ModelId
  system?: string
  messages: ChatMessage[]
  /** Anthropic `max_tokens`. Defaults to {@link DEFAULT_MAX_TOKENS}. */
  maxTokens?: number
  /** DeepSeek thinking mode, off by default. */
  thinking?: boolean
  /** Thinking effort; only sent when `thinking` is true. */
  effort?: ThinkingEffort
  /** Only sent when thinking is disabled; thinking mode fixes temperature at 1.0. */
  temperature?: number
}

/**
 * Deterministic form of a request: explicit defaults, fixed key order.
 * Replay cassette keys are `sha256(JSON.stringify(canonicalChatRequest(request)))`,
 * so reordering `ChatRequest` keys or omitting defaults never changes the key.
 */
export type CanonicalChatRequest = {
  model: ModelId
  system: string
  messages: ChatMessage[]
  maxTokens: number
  thinking: boolean
  effort: ThinkingEffort | null
  temperature: number | null
}

export const canonicalChatRequest = (request: ChatRequest): CanonicalChatRequest => {
  const messages = (request.messages ?? []).map((message) => ({
    role: message.role,
    content: message.content,
  }))
  const maxTokens =
    typeof request.maxTokens === 'number' && Number.isFinite(request.maxTokens) && request.maxTokens > 0
      ? Math.floor(request.maxTokens)
      : DEFAULT_MAX_TOKENS
  return {
    model: asModelId(request.model),
    system: request.system ?? '',
    messages,
    maxTokens,
    thinking: request.thinking === true,
    effort: request.thinking === true ? (request.effort ?? null) : null,
    temperature:
      request.thinking === true
        ? null
        : typeof request.temperature === 'number' && Number.isFinite(request.temperature)
          ? request.temperature
          : null,
  }
}

/** sha256 of the canonical request; the replay cassette key. */
export const chatRequestKey = (request: ChatRequest): string =>
  createHash('sha256').update(JSON.stringify(canonicalChatRequest(request))).digest('hex')

/** Streaming events yielded while a chat completes. */
export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'signature'; signature: string }
  | { type: 'title'; title: string }
  /** Cumulative usage snapshot (final one is authoritative). */
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'stop'; stopReason: string | null }

export type ChatCitation = { url: string; title: string | null }

export type ChatProviderId = 'deepseek' | 'openai-compatible' | 'replay'

/**
 * Final outcome of one chat turn. Success always has `status: 'ok'`; failures
 * throw {@link ProviderError} (with `partial` attached when text was generated).
 * `usage.inputTokens` excludes cache hits; `cacheReadTokens` are cache hits.
 */
export type ChatResult = {
  text: string
  thinking: string
  signature: string | null
  title: string | null
  stopReason: string | null
  toolCalls: number
  citations: ChatCitation[]
  usage: TokenUsage
  costUsd: number
  pricingBasis: PricingBasis
  latencyMs: number
  ttfbMs: number | null
  model: string
  provider: ChatProviderId
  status: 'ok'
  error: null
}

export type ChatProvider = {
  readonly id: ChatProviderId
  /** Yields incremental events; the generator's return value is the final result. */
  streamChat(
    request: ChatRequest,
    signal?: AbortSignal
  ): AsyncGenerator<ChatStreamEvent, ChatResult, void>
  /** Convenience: consume {@link streamChat} and resolve with the final result. */
  chatOnce(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult>
}

/** Consume a provider stream and return its final result (last `next()` value). */
export const consumeChat = async (
  stream: AsyncGenerator<ChatStreamEvent, ChatResult, void>
): Promise<ChatResult> => {
  for (;;) {
    const next = await stream.next()
    if (next.done) return next.value
  }
}

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
})

export const normalizeUsage = (value: unknown): TokenUsage => {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const num = (key: string): number => {
    const candidate = record[key]
    return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : 0
  }
  return {
    inputTokens: num('input_tokens'),
    cacheReadTokens: num('cache_read_input_tokens'),
    cacheCreationTokens: num('cache_creation_input_tokens'),
    outputTokens: num('output_tokens'),
  }
}

export type ProviderErrorCode =
  | 'missing_api_key'
  | 'http_error'
  | 'stream_error'
  | 'protocol_error'
  | 'interrupted'
  | 'aborted'
  | 'replay_miss'

export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly status: number | undefined
  /** Partial result when the stream failed after producing content. */
  readonly partial: ChatResult | undefined

  constructor(
    code: ProviderErrorCode,
    message: string,
    options: { status?: number; cause?: unknown; partial?: ChatResult } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ProviderError'
    this.code = code
    this.status = options.status
    this.partial = options.partial
  }
}

export const isProviderError = (value: unknown): value is ProviderError =>
  value instanceof ProviderError

export class ReplayMissError extends ProviderError {
  readonly cassettePath: string

  constructor(cassettePath: string, detail = '') {
    super(
      'replay_miss',
      `Replay cassette missing at ${cassettePath}.` +
        (detail ? ` ${detail}` : '') +
        ' Replay never falls back to the network; record it first with `stella record` while a live key is configured.'
    )
    this.name = 'ReplayMissError'
    this.cassettePath = cassettePath
  }
}

/** Cost + pricing basis for a completed turn. */
export const costOf = (
  usage: TokenUsage,
  model: string | undefined,
  timestamp = Date.now()
): CostBreakdown => computeCost(usage, asModelId(model), timestamp)

type ChatResultFields = {
  text: string
  thinking: string
  signature: string | null
  title: string | null
  stopReason: string | null
  toolCalls: number
  citations: ChatCitation[]
  usage: TokenUsage
  latencyMs: number
  ttfbMs: number | null
  model: string
  provider: ChatProviderId
  createdAt: number
}

export const buildChatResult = (fields: ChatResultFields): ChatResult => {
  const breakdown = costOf(fields.usage, fields.model, fields.createdAt)
  return {
    text: fields.text,
    thinking: fields.thinking,
    signature: fields.signature,
    title: fields.title,
    stopReason: fields.stopReason,
    toolCalls: fields.toolCalls,
    citations: fields.citations,
    usage: fields.usage,
    costUsd: breakdown.usd,
    pricingBasis: breakdown.basis,
    latencyMs: fields.latencyMs,
    ttfbMs: fields.ttfbMs,
    model: fields.model,
    provider: fields.provider,
    status: 'ok',
    error: null,
  }
}

/* ------------------------------ cassettes ------------------------------ */

/** One recorded chat turn, replayable without a network call. */
export type ReplayCassette = {
  version: 1
  createdAt: number
  request: CanonicalChatRequest
  events: ChatStreamEvent[]
  result: ChatResult
}

/** JSON-schema call used by the judge/rerank; replayable the same way. */
export type JsonSchemaCall = {
  model?: ModelId
  system: string
  input: string
  /** JSON Schema (draft-07 subset) the response must satisfy. */
  schema: Record<string, unknown>
  maxTokens?: number
  /** Defaults to 0 (deterministic grading). */
  temperature?: number
  /** Defaults to false: grading should not spend thinking tokens. */
  thinking?: boolean
}

export type CanonicalJsonSchemaCall = {
  model: ModelId
  system: string
  input: string
  schema: Record<string, unknown>
  maxTokens: number
  temperature: number
  thinking: boolean
}

export const canonicalJsonSchemaCall = (call: JsonSchemaCall): CanonicalJsonSchemaCall => ({
  model: asModelId(call.model),
  system: call.system,
  input: call.input,
  schema: call.schema,
  maxTokens:
    typeof call.maxTokens === 'number' && Number.isFinite(call.maxTokens) && call.maxTokens > 0
      ? Math.floor(call.maxTokens)
      : 1024,
  temperature:
    typeof call.temperature === 'number' && Number.isFinite(call.temperature) ? call.temperature : 0,
  thinking: call.thinking === true,
})

export const jsonSchemaCallKey = (call: JsonSchemaCall): string =>
  createHash('sha256').update(JSON.stringify(canonicalJsonSchemaCall(call))).digest('hex')

export type JsonSchemaCassette = {
  version: 1
  createdAt: number
  request: CanonicalJsonSchemaCall
  result: unknown
}
