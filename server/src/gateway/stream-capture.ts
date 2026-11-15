import { estimateTokens } from '../../../shared/pricing.ts'
import type { TokenUsage, TraceResponse } from '../../../shared/types.ts'
import { emptyUsage, normalizeUsage } from '../providers/contracts.ts'

/**
 * Tee-parser for an Anthropic-compatible message stream. It never writes
 * anything: the proxy forwards upstream bytes untouched except for the usage
 * frames it rewrites, and this accumulator builds the trace from the parsed
 * payloads. Unknown event types are ignored (the client ignores them too).
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export class MessagesCapture {
  text = ''
  thinking = ''
  title: string | null = null
  stopReason: string | null = null
  toolCalls = 0
  citations: TraceResponse['citations'] = []
  usage: TokenUsage = emptyUsage()
  sawMessageStart = false
  sawMessageStop = false
  sawUsageDelta = false
  error: string | null = null

  /** Observed a frame whose data may or may not be JSON. */
  observeFrame(event: string, data: string): void {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (event === 'error') {this.error ??= data.trim() || 'Upstream sent an error frame'}
      return
    }
    this.observePayload(payload, event)
  }

  observePayload(payload: unknown, event = ''): void {
    if (!isRecord(payload)) {return}
    if (isRecord(payload.error)) {
      const message = payload.error.message
      this.error ??= typeof message === 'string' ? message : 'Upstream stream error'
      return
    }
    const type = typeof payload.type === 'string' ? payload.type : event
    switch (type) {
      case 'message_start': {
        this.sawMessageStart = true
        const message = isRecord(payload.message) ? payload.message : {}
        this.usage = normalizeUsage(message.usage)
        break
      }
      case 'content_block_start': {
        const block = isRecord(payload.content_block) ? payload.content_block : null
        if (!block) {break}
        if (block.type === 'text') {
          if (typeof block.text === 'string') {this.text += block.text}
          if (Array.isArray(block.citations)) {
            for (const citation of block.citations) {this.addCitation(citation)}
          }
        } else if (block.type === 'thinking') {
          if (typeof block.thinking === 'string') {this.thinking += block.thinking}
        } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
          this.toolCalls += 1
        }
        break
      }
      case 'content_block_delta': {
        const delta = isRecord(payload.delta) ? payload.delta : null
        if (!delta) {break}
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          this.text += delta.text
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          this.thinking += delta.thinking
        } else if (delta.type === 'citations_delta') {
          this.addCitation(delta.citation)
        }
        break
      }
      case 'message_delta': {
        const delta = isRecord(payload.delta) ? payload.delta : {}
        if (typeof delta.stop_reason === 'string') {this.stopReason = delta.stop_reason}
        if (typeof delta.title === 'string' && delta.title.trim()) {this.title = delta.title.trim()}
        if (isRecord(payload.usage)) {
          this.usage = normalizeUsage(payload.usage)
          this.sawUsageDelta = true
        }
        break
      }
      case 'message_stop': {
        this.sawMessageStop = true
        break
      }
      default:
        break
    }
  }

  private addCitation(value: unknown): void {
    if (!isRecord(value) || value.type !== 'web_search_result_location') {return}
    const url = typeof value.url === 'string' ? value.url : null
    if (!url) {return}
    if (this.citations.some((citation) => citation.url === url)) {return}
    this.citations.push({ url, title: typeof value.title === 'string' ? value.title : null })
  }

  /**
   * Cumulative usage for the trace. DeepSeek puts cumulative usage in the final
   * message_delta; if the stream was truncated before it, the output count is
   * estimated from the text and flagged with `estimated: true`.
   */
  finalUsage(): TokenUsage {
    if (this.sawUsageDelta) {return { ...this.usage }}
    const usage = { ...this.usage }
    if (this.text || this.thinking) {
      usage.outputTokens = estimateTokens(this.text + this.thinking)
      usage.estimated = true
    }
    return usage
  }

  response(): TraceResponse {
    return {
      text: this.text,
      thinking: this.thinking || null,
      stopReason: this.stopReason,
      title: this.title,
      toolCalls: this.toolCalls,
      citations: this.citations,
    }
  }
}
