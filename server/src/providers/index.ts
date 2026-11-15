/**
 * Provider contracts for the Stella server (evals, judge, CLI).
 *
 * Transport-only modules — importable from a plain `node` process or a test
 * without booting Fastify. Three pieces:
 *
 * 1. `streamChat` / `chatOnce`: canonical streaming chat (Anthropic-compatible
 *    Messages API over SSE) whose request shape matches what the gateway
 *    proxies, so recorded streams replay byte-for-byte.
 * 2. `callJsonSchema`: Responses API JSON-schema caller for the judge/rerank,
 *    with a Chat Completions `json_object` fallback.
 * 3. Replay: cassettes keyed by `sha256(canonical request)`; a missing cassette
 *    throws `ReplayMissError` (`code === 'replay_miss'`) and never falls back to
 *    the network. `recordChat` / `recordJsonSchema` write cassettes.
 *
 * Default provider selection follows `STELLA_MODE` (`live` or `replay`).
 */
import { config } from '../config.ts'
import {
  ProviderError,
  type ChatProvider,
  type ChatProviderId,
  type ChatRequest,
  type ChatResult,
  type ChatStreamEvent,
} from './contracts.ts'
import { createLiveProvider, liveProvider, type LiveProviderOptions } from './live.ts'
import {
  createReplayProvider,
  replayProvider,
  type ReplayProviderOptions,
} from './replay.ts'

export * from './contracts.ts'
export * from './live.ts'
export * from './replay.ts'
export * from './responses.ts'

/** `'live'` is the persisted run mode (`RunMode`); it maps to the live provider. */
export type GetChatProviderId = ChatProviderId | 'live' | 'auto'

export type GetChatProviderOptions = LiveProviderOptions & ReplayProviderOptions

/** Options accepted by the convenience chat helpers. */
export type ChatOptions = {
  signal?: AbortSignal
  /** Defaults to `STELLA_MODE` semantics of {@link getChatProvider}. */
  mode?: 'live' | 'replay'
  /** Replay only: explicit cassette key override (tests/stubs). */
  cassetteKey?: string
}

const asChatOptions = (input?: ChatOptions | AbortSignal): ChatOptions => {
  if (!input) {return {}}
  if (input instanceof AbortSignal) {return { signal: input }}
  return input
}

/**
 * Resolve a chat provider.
 * - `'auto'` (default): `replay` when `STELLA_MODE=replay`, otherwise `deepseek`.
 * - `'live'` / `'deepseek'`: live Anthropic-compatible provider.
 * - `'replay'`: cassette provider (missing cassette throws `replay_miss`).
 * - `'openai-compatible'`: live transport against `options.baseUrl`.
 */
export const getChatProvider = (
  id: GetChatProviderId = 'auto',
  options: GetChatProviderOptions = {}
): ChatProvider => {
  const resolved =
    id === 'auto' ? (config.mode === 'replay' ? 'replay' : 'deepseek') : id === 'live' ? 'deepseek' : id
  switch (resolved) {
    case 'replay':
      return createReplayProvider({
        cassetteDir: options.cassetteDir,
        cassettes: options.cassettes,
        cassetteKey: options.cassetteKey,
      })
    case 'deepseek':
      return createLiveProvider({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        fetchImpl: options.fetchImpl,
      })
    case 'openai-compatible': {
      if (!options.baseUrl) {
        throw new ProviderError(
          'protocol_error',
          'The openai-compatible provider requires an explicit baseUrl.'
        )
      }
      return createLiveProvider({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        fetchImpl: options.fetchImpl,
      })
    }
    default:
      throw new ProviderError('protocol_error', `Unknown provider id: ${String(resolved)}`)
  }
}

/**
 * Stream a chat turn with the default provider (`STELLA_MODE`).
 * Yields {@link ChatStreamEvent}; the generator's return value is the
 * {@link ChatResult}. Throws {@link ProviderError} on failure.
 */
export const streamChat = (
  request: ChatRequest,
  signal?: AbortSignal
): AsyncGenerator<ChatStreamEvent, ChatResult, void> => getChatProvider().streamChat(request, signal)

/**
 * Non-streaming convenience: resolve with the final {@link ChatResult}.
 * Accepts `{signal, mode, cassetteKey}` or a bare `AbortSignal`.
 */
export const chatOnce = async (
  request: ChatRequest,
  options?: ChatOptions | AbortSignal
): Promise<ChatResult> => {
  const resolved = asChatOptions(options)
  return getChatProvider(resolved.mode ?? 'auto', {
    cassetteKey: resolved.cassetteKey,
  }).chatOnce(request, resolved.signal)
}

/** Alias for {@link getChatProvider} (`getProvider('replay')`). */
export const getProvider = getChatProvider

export { liveProvider, replayProvider }
