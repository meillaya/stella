import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  cohensKappa,
  formatPercent,
  formatPp,
  mean,
  mulberry32,
  pairedBootstrap,
  percentile,
  wilsonInterval,
} from '../../shared/metrics.ts'

test('wilson interval stays inside 0..1 and narrows with more samples', () => {
  const small = wilsonInterval(7, 10)
  const large = wilsonInterval(700, 1000)
  assert.ok(small.low >= 0 && small.high <= 1)
  assert.ok(large.low >= 0 && large.high <= 1)
  assert.ok(large.high - large.low < small.high - small.low)
  assert.deepEqual(wilsonInterval(0, 0), { low: 0, high: 1 })
})

test('mean and percentile ignore no values but return null when empty', () => {
  assert.equal(mean([]), null)
  assert.equal(mean([1, 2, 3]), 2)
  assert.equal(percentile([], 0.95), null)
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3)
  assert.ok(Math.abs((percentile([1, 2, 3, 4, 5], 0.95) ?? 0) - 4.8) < 1e-9)
})

test('paired bootstrap is deterministic and detects a uniform improvement', () => {
  const deltas = Array.from({ length: 40 }, () => 10)
  const result = pairedBootstrap(deltas)
  assert.equal(result.mean, 10)
  assert.equal(result.ciLow, 10)
  assert.equal(result.ciHigh, 10)
  assert.equal(result.probabilityNotBetter, 0)
  const again = pairedBootstrap(deltas)
  assert.deepEqual(result, again)
})

test('paired bootstrap reports uncertainty for mixed deltas', () => {
  const deltas = [10, -5, 0, 5, -10, 0, 15, -5]
  const result = pairedBootstrap(deltas, { iterations: 2000 })
  assert.ok(result.ciLow <= result.mean)
  assert.ok(result.ciHigh >= result.mean)
  assert.ok(result.probabilityNotBetter > 0 && result.probabilityNotBetter < 1)
})

test('mulberry32 is stable for a seed', () => {
  const a = mulberry32(7)
  const b = mulberry32(7)
  assert.equal(a(), b())
  assert.equal(a(), b())
})

test('cohens kappa handles perfect, chance and empty agreement', () => {
  assert.equal(cohensKappa([]), null)
  assert.equal(cohensKappa([['pass', 'pass'], ['fail', 'fail']]), 1)
  assert.equal(cohensKappa([['pass', 'fail'], ['fail', 'pass']]), -1)
})

test('delta and percent formatting are honest about missing values', () => {
  assert.equal(formatPp(0), '0.0 pp')
  assert.equal(formatPp(-3.2), '-3.2 pp')
  assert.equal(formatPp(null), '—')
  assert.equal(formatPercent(0.876, 1), '87.6%')
  assert.equal(formatPercent(undefined), '—')
})
