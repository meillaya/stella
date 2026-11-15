import type { ModelId, PricingBasis, TokenUsage } from './types.ts'

export type PriceRow = {
  /** USD per 1M uncached prompt tokens. */
  inputMiss: number
  /** USD per 1M cache-hit prompt tokens. */
  inputHit: number
  /** USD per 1M completion tokens (thinking is billed as output). */
  output: number
}

export type ModelPrice = {
  offPeak: PriceRow
  peak: PriceRow
}

/** Verified against https://api-docs.deepseek.com/quick_start/pricing on 2026-11-15. */
export const PRICING: Record<ModelId, ModelPrice> = {
  'deepseek-flash': {
    offPeak: { inputMiss: 0.15, inputHit: 0.003, output: 0.6 },
    peak: { inputMiss: 0.3, inputHit: 0.006, output: 1.2 },
  },
  'deepseek-v4-pro': {
    offPeak: { inputMiss: 0.66, inputHit: 0.022, output: 1.98 },
    peak: { inputMiss: 1.32, inputHit: 0.044, output: 3.96 },
  },
}

export const MODEL_VERSION: Record<ModelId, string> = {
  'deepseek-flash': 'DeepSeek-V4.1-Flash-1017',
  'deepseek-v4-pro': 'DeepSeek-V4-Pro-0813',
}

export const DEFAULT_MODEL: ModelId = 'deepseek-flash'

export const asModelId = (value: unknown): ModelId =>
  value === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash'

/**
 * DeepSeek peak hours are 01:00-04:00 and 06:00-10:00 UTC Monday-Friday,
 * excluding Chinese public holidays. We do not ship a holiday calendar, so the
 * UI labels this as an approximation. Off-peak is half price.
 */
export const isPeak = (timestamp = Date.now()): boolean => {
  const date = new Date(timestamp)
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = date.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

export const pricingBasis = (timestamp = Date.now()): PricingBasis =>
  isPeak(timestamp) ? 'peak' : 'off-peak'

export type CostBreakdown = {
  usd: number
  basis: PricingBasis
  inputMissUsd: number
  inputHitUsd: number
  outputUsd: number
}

export const computeCost = (
  usage: TokenUsage,
  model: ModelId = DEFAULT_MODEL,
  timestamp = Date.now()
): CostBreakdown => {
  const basis = pricingBasis(timestamp)
  const price = PRICING[model][basis === 'peak' ? 'peak' : 'offPeak']
  const inputMissUsd = (usage.inputTokens / 1_000_000) * price.inputMiss
  const inputHitUsd = (usage.cacheReadTokens / 1_000_000) * price.inputHit
  const cacheCreationUsd = (usage.cacheCreationTokens / 1_000_000) * price.inputMiss
  const outputUsd = (usage.outputTokens / 1_000_000) * price.output
  return {
    usd: inputMissUsd + inputHitUsd + cacheCreationUsd + outputUsd,
    basis,
    inputMissUsd,
    inputHitUsd,
    outputUsd,
  }
}

/**
 * Offline estimate used for budgets and preflight only. The API's reported
 * usage is the source of truth. DeepSeek documents ~0.3 tokens per English
 * character and ~0.6 per Chinese character.
 */
export const estimateTokens = (text: string): number => {
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x2e80 && code <= 0x9fff) cjk += 1
    else other += 1
  }
  return Math.ceil(other * 0.3 + cjk * 0.6)
}

export const formatUsd = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value === 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(5)}`
  if (value < 1) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

export const nextOffPeak = (from = Date.now()): { start: number; end: number } => {
  const date = new Date(from)
  date.setUTCSeconds(0, 0)
  for (let step = 0; step < 7 * 24 * 4; step += 1) {
    const candidate = new Date(date.getTime() + step * 15 * 60_000)
    if (!isPeak(candidate.getTime())) {
      const start = candidate.getTime()
      return { start, end: start + 60 * 60_000 }
    }
  }
  return { start: from, end: from + 60 * 60_000 }
}
