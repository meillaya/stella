import { config } from '../config.ts'
import {
  ProviderError,
  buildChatResult,
  canonicalChatRequest,
  consumeChat,
  emptyUsage,
  normalizeUsage,
  type ChatCitation,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type ChatStreamEvent,
  type ThinkingEffort,
} from './contracts.ts'
import { readSseEvents } from './sse.ts'

/**
 * Live provider: DeepSeek's Anthropic-compatible `POST /anthropic/v1/messages`
 * over SSE. The gateway proxy serves the browser; this client serves evals and
 * the CLI. Both share the same wire format, so a recorded stream can be replayed.
 */

export type LiveProviderOptions = {
  /** Defaults to `config.deepseekBaseUrl`. */
  baseUrl?: string
  /** Defaults to `config.apiKey`; explicit `null` disables the fallback. */
  apiKey?: string | null
  fetchImpl?: typeof fetch
}

export const resolveBaseUrl = (baseUrl?: string): string =>
  (baseUrl ?? config.deepseekBaseUrl).replace(/\/+$/, '')

export const resolveApiKey = (apiKey?: string | null): string => {
  const resolved = apiKey === undefined ? config.apiKey : apiKey
  if (!resolved) {
    throw new ProviderError(
      'missing_api_key',
      'No DeepSeek API key configured. Set DEEPSEEK_API_KEY in .env.local (or run `STELLA_MODE=replay` against recorded cassettes). Stella never ships a key.'
    )
  }
  return resolved
}

type StreamState = {
  text: string
  thinking: string
  signature: string | null
  title: string | null
  stopReason: string | null
  toolCalls: number
  citations: ChatCitation[]
  usage: ReturnType<typeof emptyUsage>
  firstEventAt: number | null
  sawStart: boolean
  done: boolean
}

const newState = (): StreamState => ({
  text: '',
  thinking: '',
  signature: null,
  title: null,
  stopReason: null,
  toolCalls: 0,
  citations: [],
  usage: emptyUsage(),
  firstEventAt: null,
  sawStart: false,
  done: false,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const errorMessageOf = (value: unknown): string => {
  if (isRecord(value) && isRecord(value.error) && typeof value.error.message === 'string') {
    return value.error.message
  }
  return typeof value === 'string' && value.trim() ? value : 'Upstream request failed'
}

const addCitation = (state: StreamState, value: unknown): void => {
  if (!isRecord(value)) {return}
  if (value.type !== 'web_search_result_location') {return}
  const url = typeof value.url === 'string' ? value.url : null
  if (!url) {return}
  const title = typeof value.title === 'string' ? value.title : null
  if (state.citations.some((citation) => citation.url === url)) {return}
  state.citations.push({ url, title })
}

const partialResult = (
  state: StreamState,
  model: string,
  startedAt: number,
  createdAt: number
): ChatResult =>
  buildChatResult({
    text: state.text,
    thinking: state.thinking,
    signature: state.signature,
    title: state.title,
    stopReason: state.stopReason,
    toolCalls: state.toolCalls,
    citations: state.citations,
    usage: state.usage,
    latencyMs: Date.now() - startedAt,
    ttfbMs: state.firstEventAt === null ? null : state.firstEventAt - startedAt,
    model,
    provider: 'deepseek',
    createdAt,
  })

/**
 * Consume one streamed assistant turn.
 *
 * On success the generator returns a {@link ChatResult}. On failure it throws
 * {@link ProviderError}; failures after content was produced attach
 * `error.partial` with the text collected so far.
 */
export const streamChatWithOptions = async function* (
  request: ChatRequest,
  signal: AbortSignal | undefined,
  options: LiveProviderOptions
): AsyncGenerator<ChatStreamEvent, ChatResult, void> {
  const canonical = canonicalChatRequest(request)
  const apiKey = resolveApiKey(options.apiKey)
  const baseUrl = resolveBaseUrl(options.baseUrl)
  const fetchImpl = options.fetchImpl ?? fetch
  const startedAt = Date.now()
  const createdAt = startedAt
  const state = newState()

  const body: Record<string, unknown> = {
    model: canonical.model,
    max_tokens: canonical.maxTokens,
    messages: canonical.messages,
    thinking: canonical.thinking ? { type: 'enabled' } : { type: 'disabled' },
    stream: true,
  }
  if (canonical.system) {body.system = canonical.system}
  if (canonical.thinking && canonical.effort) {
    body.output_config = { effort: canonical.effort as ThinkingEffort }
  }
  if (!canonical.thinking && canonical.temperature !== null) {
    body.temperature = canonical.temperature
  }

  let response: Response
  try {
    response = await fetchImpl(`${baseUrl}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (signal?.aborted) {
      throw new ProviderError('aborted', 'Chat request was aborted before the stream started.', {
        cause: error,
      })
    }
    throw new ProviderError(
      'http_error',
      `Could not reach ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    let message = raw || `Upstream returned HTTP ${response.status}`
    try {
      const parsed: unknown = JSON.parse(raw)
      message = errorMessageOf(parsed) || message
    } catch {
      // Non-JSON error body: surface the raw text (never headers or keys).
    }
    throw new ProviderError('http_error', message, { status: response.status })
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    const raw = await response.text().catch(() => '')
    throw new ProviderError(
      'protocol_error',
      `Expected an SSE response from upstream, received "${contentType || 'no content-type'}": ${raw.slice(0, 500)}`
    )
  }

  let failure: ProviderError | null = null
  try {
    for await (const event of readSseEvents(response.body, signal)) {
      state.firstEventAt ??= Date.now()
      let payload: unknown
      try {
        payload = JSON.parse(event.data)
      } catch {
        if (event.event === 'error') {
          throw new ProviderError('stream_error', event.data || 'Upstream sent an error frame', {
            partial: partialResult(state, canonical.model, startedAt, createdAt),
          })
        }
        continue
      }
      if (isRecord(payload) && isRecord(payload.error)) {
        throw new ProviderError('stream_error', errorMessageOf(payload), {
          partial: partialResult(state, canonical.model, startedAt, createdAt),
        })
      }
      if (!isRecord(payload)) {continue}

      switch (payload.type) {
        case 'message_start': {
          state.sawStart = true
          const message = isRecord(payload.message) ? payload.message : {}
          state.usage = normalizeUsage(message.usage)
          yield { type: 'usage', usage: { ...state.usage } }
          break
        }
        case 'content_block_start': {
          const block = isRecord(payload.content_block) ? payload.content_block : null
          if (!block) {break}
          switch (block.type) {
            case 'text': {
              const text = typeof block.text === 'string' ? block.text : ''
              if (Array.isArray(block.citations)) {
                for (const citation of block.citations) {addCitation(state, citation)}
              }
              if (text) {
                state.text += text
                yield { type: 'text', text }
              }
              break
            }
            case 'thinking': {
              const thinking = typeof block.thinking === 'string' ? block.thinking : ''
              if (typeof block.signature === 'string') {state.signature = block.signature}
              if (thinking) {
                state.thinking += thinking
                yield { type: 'thinking', thinking }
              }
              break
            }
            case 'tool_use':
            case 'server_tool_use': {
              state.toolCalls += 1
              break
            }
            default:
              break
          }
          break
        }
        case 'content_block_delta': {
          const delta = isRecord(payload.delta) ? payload.delta : null
          if (!delta) {break}
          switch (delta.type) {
            case 'text_delta': {
              const text = typeof delta.text === 'string' ? delta.text : ''
              if (text) {
                state.text += text
                yield { type: 'text', text }
              }
              break
            }
            case 'thinking_delta': {
              const thinking = typeof delta.thinking === 'string' ? delta.thinking : ''
              if (thinking) {
                state.thinking += thinking
                yield { type: 'thinking', thinking }
              }
              break
            }
            case 'signature_delta': {
              const signature = typeof delta.signature === 'string' ? delta.signature : ''
              if (signature) {
                state.signature = (state.signature ?? '') + signature
                yield { type: 'signature', signature }
              }
              break
            }
            case 'citations_delta': {
              addCitation(state, delta.citation)
              break
            }
            default:
              break
          }
          break
        }
        case 'message_delta': {
          const delta = isRecord(payload.delta) ? payload.delta : {}
          if (typeof delta.stop_reason === 'string') {state.stopReason = delta.stop_reason}
          if (typeof delta.title === 'string' && delta.title.trim()) {
            state.title = delta.title.trim()
            yield { type: 'title', title: state.title }
          }
          state.usage = normalizeUsage(payload.usage)
          yield { type: 'usage', usage: { ...state.usage } }
          break
        }
        case 'message_stop': {
          state.done = true
          break
        }
        default:
          break
      }
      if (state.done) {break}
    }
  } catch (error) {
    if (error instanceof ProviderError) {
      failure = error
    } else if (signal?.aborted) {
      throw new ProviderError('aborted', 'Chat request was aborted.', {
        cause: error,
        partial: partialResult(state, canonical.model, startedAt, createdAt),
      })
    } else {
      throw new ProviderError(
        'protocol_error',
        `Stream failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error, partial: partialResult(state, canonical.model, startedAt, createdAt) }
      )
    }
  } finally {
    // Nothing to release: readSseEvents owns the reader.
  }

  if (failure) {throw failure}
  if (signal?.aborted) {
    throw new ProviderError('aborted', 'Chat request was aborted.', {
      partial: partialResult(state, canonical.model, startedAt, createdAt),
    })
  }
  if (!state.done) {
    throw new ProviderError(
      'interrupted',
      state.sawStart
        ? 'Stream ended before message_stop; the response is incomplete.'
        : 'Stream ended without any message events.',
      { partial: partialResult(state, canonical.model, startedAt, createdAt) }
    )
  }

  yield { type: 'stop', stopReason: state.stopReason }
  return buildChatResult({
    text: state.text,
    thinking: state.thinking,
    signature: state.signature,
    title: state.title,
    stopReason: state.stopReason,
    toolCalls: state.toolCalls,
    citations: state.citations,
    usage: state.usage,
    latencyMs: Date.now() - startedAt,
    ttfbMs: state.firstEventAt === null ? null : state.firstEventAt - startedAt,
    model: canonical.model,
    provider: 'deepseek',
    createdAt,
  })
}

export const createLiveProvider = (options: LiveProviderOptions = {}): ChatProvider => ({
  id: 'deepseek',
  streamChat: (request, signal) => streamChatWithOptions(request, signal, options),
  chatOnce: (request, signal) =>
    consumeChat(streamChatWithOptions(request, signal, options)),
})

export const liveProvider = createLiveProvider()
