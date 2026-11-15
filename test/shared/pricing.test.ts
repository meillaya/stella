import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeCost, estimateTokens, formatUsd, isPeak, nextOffPeak, PRICING } from '../../shared/pricing.ts'

const monday = (hour: number) => Date.UTC(2026, 10, 16, hour, 0, 0) // Mon 2026-11-16
const saturday = (hour: number) => Date.UTC(2026, 10, 14, hour, 0, 0)

test('peak windows follow the published UTC schedule', () => {
  assert.equal(isPeak(monday(2)), true)
  assert.equal(isPeak(monday(5)), false)
  assert.equal(isPeak(monday(7)), true)
  assert.equal(isPeak(monday(10)), false)
  assert.equal(isPeak(saturday(2)), false)
})

test('flash off-peak cost matches the published prices', () => {
  const cost = computeCost(
    { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheCreationTokens: 0, outputTokens: 1_000_000 },
    'deepseek-flash',
    monday(12)
  )
  assert.equal(cost.basis, 'off-peak')
  assert.ok(Math.abs(cost.usd - (0.15 + 0.003 + 0.6)) < 1e-9)
})

test('peak prices are exactly double off-peak', () => {
  const usage = { inputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 500_000 }
  const off = computeCost(usage, 'deepseek-flash', monday(12))
  const peak = computeCost(usage, 'deepseek-flash', monday(2))
  assert.equal(peak.basis, 'peak')
  assert.ok(Math.abs(peak.usd - off.usd * 2) < 1e-9)
})

test('v4-pro pricing is per model, not shared', () => {
  assert.equal(PRICING['deepseek-v4-pro'].offPeak.output, 1.98)
  assert.equal(PRICING['deepseek-flash'].offPeak.output, 0.6)
})

test('offline token estimate handles latin and CJK text', () => {
  assert.equal(estimateTokens('abcd'), 2)
  assert.equal(estimateTokens('你好'), 2)
  assert.ok(estimateTokens('hello 世界') > 0)
})

test('next off-peak window starts outside peak hours', () => {
  const window = nextOffPeak(monday(2))
  assert.equal(isPeak(window.start), false)
  assert.ok(window.start > monday(2))
})

test('usd formatting keeps small costs readable', () => {
  assert.equal(formatUsd(0), '$0')
  assert.equal(formatUsd(0.00058), '$0.00058')
  assert.equal(formatUsd(1.5), '$1.50')
  assert.equal(formatUsd(null), '—')
})
