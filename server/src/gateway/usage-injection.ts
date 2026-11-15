import type { PricingBasis, SourceRef } from '../../../shared/types.ts'
import { parseSseFrame, replaceFrameData } from './sse.ts'

/**
 * Chat-demo stores the whole SSE `usage` object on the assistant message, so the
 * gateway can attach provenance there for free (no extra request/round trip).
 * Only `message_start` and `message_delta` usage objects are augmented; all
 * other frames keep their exact upstream bytes.
 */

export const MAX_INJECTED_SOURCES = 6
export const INJECTED_SNIPPET_CHARS = 180

export type CompactSource = {
  id: string
  chunkId: string
  documentId: string
  title: string
  heading: string | null
  page: number | null
  score: number
  snippet: string
}

export const compactSources = (sources: SourceRef[]): CompactSource[] =>
  sources.slice(0, MAX_INJECTED_SOURCES).map((source) => ({
    id: source.id,
    chunkId: source.chunkId,
    documentId: source.documentId,
    title: source.title,
    heading: source.heading,
    page: source.page,
    score: source.score,
    snippet: source.snippet.slice(0, INJECTED_SNIPPET_CHARS),
  }))

export type UsageInjection = {
  traceId: string
  sources: CompactSource[]
  pricingBasis: PricingBasis
}

export type DeltaUsageExtras = {
  costUsd: number
  latencyMs: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Add `lantern_*` keys to the usage object of a `message_start` /
 * `message_delta` frame. If the upstream frame has no usage object we return it
 * untouched — we never invent usage.
 */
export const augmentUsageFrame = (
  frame: Buffer,
  frameType: 'message_start' | 'message_delta',
  injection: UsageInjection,
  deltaUsage?: DeltaUsageExtras
): Buffer => {
  const parsed = parseSseFrame(frame)
  if (!parsed) {return frame}
  let payload: unknown
  try {
    payload = JSON.parse(parsed.data)
  } catch {
    return frame
  }
  if (!isRecord(payload)) {return frame}
  const usage =
    frameType === 'message_start'
      ? isRecord(payload.message) && isRecord(payload.message.usage)
        ? payload.message.usage
        : null
      : isRecord(payload.usage)
        ? payload.usage
        : null
  if (!usage) {return frame}

  usage.lantern_trace_id = injection.traceId
  usage.lantern_sources = injection.sources
  usage.lantern_pricing_basis = injection.pricingBasis
  if (frameType === 'message_delta' && deltaUsage) {
    usage.lantern_cost_usd = deltaUsage.costUsd
    usage.lantern_latency_ms = Math.max(0, Math.round(deltaUsage.latencyMs))
  }
  return replaceFrameData(frame, JSON.stringify(payload))
}
