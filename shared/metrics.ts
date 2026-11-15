/** Small, dependency-free statistics helpers shared by the eval runner and the UI. */

export type Interval = { low: number; high: number }

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** Wilson score interval for a binomial proportion. */
export const wilsonInterval = (successes: number, total: number, z = 1.96): Interval => {
  if (total <= 0) return { low: 0, high: 1 }
  const p = clamp01(successes / total)
  const denominator = 1 + (z * z) / total
  const center = (p + (z * z) / (2 * total)) / denominator
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator
  return { low: clamp01(center - margin), high: clamp01(center + margin) }
}

export const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length

export const percentile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * p
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower] ?? null
  const weight = index - lower
  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight
}

/** Deterministic PRNG so bootstrap results are reproducible in tests and CI. */
export const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type PairedBootstrapResult = {
  mean: number
  ciLow: number
  ciHigh: number
  /** Share of resamples in which the delta was <= 0. */
  probabilityNotBetter: number
  samples: number
}

/**
 * Paired bootstrap over per-case deltas (candidate - baseline), expressed in
 * percentage points. Use the same case order for both sides.
 */
export const pairedBootstrap = (
  deltas: number[],
  options: { iterations?: number; seed?: number; confidence?: number } = {}
): PairedBootstrapResult => {
  const iterations = options.iterations ?? 10_000
  const seed = options.seed ?? 42
  const confidence = options.confidence ?? 0.95
  if (deltas.length === 0) {
    return { mean: 0, ciLow: 0, ciHigh: 0, probabilityNotBetter: 1, samples: 0 }
  }
  const random = mulberry32(seed)
  const means: number[] = []
  let notBetter = 0
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0
    for (let j = 0; j < deltas.length; j += 1) {
      sum += deltas[Math.floor(random() * deltas.length)] ?? 0
    }
    const sampleMean = sum / deltas.length
    means.push(sampleMean)
    if (sampleMean <= 0) notBetter += 1
  }
  means.sort((a, b) => a - b)
  const alpha = (1 - confidence) / 2
  const lowIndex = Math.max(0, Math.floor(alpha * means.length))
  const highIndex = Math.min(means.length - 1, Math.ceil((1 - alpha) * means.length) - 1)
  return {
    mean: mean(deltas) ?? 0,
    ciLow: means[lowIndex] ?? 0,
    ciHigh: means[highIndex] ?? 0,
    probabilityNotBetter: notBetter / iterations,
    samples: deltas.length,
  }
}

export const formatPp = (value: number | null | undefined, digits = 1): string => {
  if (value == null || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(digits)} pp`
}

export const formatPercent = (value: number | null | undefined, digits = 1): string => {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

/** Cohen's kappa for two raters over categorical labels. */
export const cohensKappa = (pairs: [string, string][]): number | null => {
  if (pairs.length === 0) return null
  const labels = new Set<string>()
  for (const [a, b] of pairs) {
    labels.add(a)
    labels.add(b)
  }
  let observed = 0
  for (const [a, b] of pairs) if (a === b) observed += 1
  const po = observed / pairs.length
  let pe = 0
  for (const label of labels) {
    const a = pairs.filter(([value]) => value === label).length / pairs.length
    const b = pairs.filter(([, value]) => value === label).length / pairs.length
    pe += a * b
  }
  if (pe >= 1) return null
  return (po - pe) / (1 - pe)
}
