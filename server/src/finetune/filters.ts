/**
 * Fine-tuning data filters: PII/secrets redaction, exact + MinHash near-dup
 * detection, 13-gram contamination hashing, and deterministic doc-based splits.
 *
 * Everything here is pure and deterministic (seeded hashes, sorted group keys)
 * so preflight reports and exports are reproducible.
 */

import { createHash } from 'node:crypto'

/* ------------------------------ tokens / shingles ------------------------------ */

const WORD_RE = /[\p{L}\p{N}]+/gu

export const wordsOf = (text: string): string[] =>
  text.normalize('NFC').toLowerCase().match(WORD_RE) ?? []

export const shinglesOf = (words: string[], size: number): string[] => {
  if (size <= 1) {
    return words
  }
  if (words.length < size) {
    return words.length === 0 ? [] : [words.join(' ')]
  }
  const out: string[] = []
  for (let index = 0; index + size <= words.length; index += 1) {
    out.push(words.slice(index, index + size).join(' '))
  }
  return out
}

const fnv1a = (value: string, seed: number): number => {
  let hash = (2166136261 ^ seed) >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash >>> 0
}

/* ------------------------------ MinHash near duplicates ------------------------------ */

export const MINHASH_HASHES = 128
export const NEAR_DUPE_THRESHOLD = 0.8

const hashSeeds: number[] = (() => {
  // Deterministic seed table; avoids depending on shared/metrics at module load.
  let state = 42
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0 || 1
  }
  return Array.from({ length: MINHASH_HASHES }, () => next())
})()

/** MinHash signature over 3-word shingles (word 1-grams for very short texts). */
export const minhashSignature = (text: string): number[] => {
  const words = wordsOf(text)
  const shingles = shinglesOf(words, words.length >= 3 ? 3 : 1)
  if (shingles.length === 0) {
    return new Array<number>(MINHASH_HASHES).fill(0)
  }
  const signature = new Array<number>(MINHASH_HASHES).fill(0xffffffff)
  for (const [hashIndex, seed] of hashSeeds.entries()) {
    let minimum = 0xffffffff
    for (const shingle of shingles) {
      const value = fnv1a(shingle, seed)
      if (value < minimum) {
        minimum = value
      }
    }
    signature[hashIndex] = minimum
  }
  return signature
}

export const jaccardEstimate = (left: number[], right: number[]): number => {
  const length = Math.min(left.length, right.length)
  if (length === 0) {
    return 0
  }
  let equal = 0
  for (let index = 0; index < length; index += 1) {
    if (left[index] === right[index]) {
      equal += 1
    }
  }
  return equal / length
}

export type NearDupePair = { left: number; right: number; similarity: number }

/** Find near-duplicate pairs above `threshold` using MinHash estimates. */
export const findNearDuplicates = (
  texts: string[],
  threshold = NEAR_DUPE_THRESHOLD
): { pairs: NearDupePair[]; duplicateIndexes: Set<number> } => {
  const signatures = texts.map((text) => minhashSignature(text))
  const pairs: NearDupePair[] = []
  const duplicateIndexes = new Set<number>()
  for (let left = 0; left < texts.length; left += 1) {
    if (duplicateIndexes.has(left)) {
      continue
    }
    for (let right = left + 1; right < texts.length; right += 1) {
      if (duplicateIndexes.has(right)) {
        continue
      }
      const similarity = jaccardEstimate(
        signatures[left] as number[],
        signatures[right] as number[]
      )
      if (similarity >= threshold) {
        pairs.push({ left, right, similarity })
        duplicateIndexes.add(right)
      }
    }
  }
  return { pairs, duplicateIndexes }
}

/* ------------------------------ 13-gram contamination ------------------------------ */

export const CONTAMINATION_NGRAM_SIZE = 13

export const ngramHashes = (text: string, size = CONTAMINATION_NGRAM_SIZE): Set<string> => {
  const hashes = new Set<string>()
  const words = wordsOf(text)
  if (words.length < size) {
    return hashes
  }
  for (const shingle of shinglesOf(words, size)) {
    hashes.add(fnv1a(shingle, 0).toString(16))
  }
  return hashes
}

export const buildContaminationIndex = (
  texts: string[],
  size = CONTAMINATION_NGRAM_SIZE
): Set<string> => {
  const index = new Set<string>()
  for (const text of texts) {
    for (const hash of ngramHashes(text, size)) {
      index.add(hash)
    }
  }
  return index
}

export const isContaminated = (
  text: string,
  index: Set<string>,
  size = CONTAMINATION_NGRAM_SIZE
): boolean => {
  for (const hash of ngramHashes(text, size)) {
    if (index.has(hash)) {
      return true
    }
  }
  return false
}

/* ------------------------------ PII / secrets ------------------------------ */

export type PiiKind = 'email' | 'phone' | 'card' | 'ip' | 'apiKey'

export type PiiCounts = Record<PiiKind, number>

export type RedactionResult = { text: string; counts: PiiCounts; total: number }

const emptyCounts = (): PiiCounts => ({ email: 0, phone: 0, card: 0, ip: 0, apiKey: 0 })

const PRIVATE_KEY_RE =
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g
const API_KEY_RES: RegExp[] = [
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:api[_-]?key|secret|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}["']?/gi,
]
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const PHONE_RES: RegExp[] = [
  /\+\d{1,3}(?:[\s.-]?\d){6,14}\b/g,
  /\b\(\d{3}\)[\s.-]?\d{3}[\s.-]\d{4}\b/g,
  /\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/g,
]
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g

const luhnValid = (digits: string): boolean => {
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index])
    if (double) {
      value *= 2
      if (value > 9) {
        value -= 9
      }
    }
    sum += value
    double = !double
  }
  return sum % 10 === 0
}

const replaceAll = (
  text: string,
  pattern: RegExp,
  placeholder: string,
  counts: PiiCounts,
  kind: PiiKind,
  accept?: (match: string) => boolean
): string =>
  text.replace(pattern, (match) => {
    if (accept && !accept(match)) {
      return match
    }
    counts[kind] += 1
    return placeholder
  })

/** Redact emails, phones, payment cards, IPs, API keys and private keys. */
export const redactPii = (text: string): RedactionResult => {
  const counts = emptyCounts()
  let output = text
  output = replaceAll(output, PRIVATE_KEY_RE, '[REDACTED_PRIVATE_KEY]', counts, 'apiKey')
  output = replaceAll(output, BEARER_RE, '[REDACTED_TOKEN]', counts, 'apiKey')
  for (const pattern of API_KEY_RES) {
    output = replaceAll(output, pattern, '[REDACTED_KEY]', counts, 'apiKey')
  }
  output = replaceAll(output, EMAIL_RE, '[EMAIL]', counts, 'email')
  output = replaceAll(output, CARD_RE, '[CARD]', counts, 'card', (match) => {
    const digits = match.replace(/[^\d]/g, '')
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits)
  })
  output = replaceAll(output, IPV4_RE, '[IP]', counts, 'ip', (match) => {
    const parts = match.split('.').map(Number)
    return parts.length === 4 && parts.every((part) => part >= 0 && part <= 255)
  })
  for (const pattern of PHONE_RES) {
    output = replaceAll(output, pattern, '[PHONE]', counts, 'phone')
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
  return { text: output, counts, total }
}

export const addPiiCounts = (target: PiiCounts, addition: PiiCounts): PiiCounts => ({
  email: target.email + addition.email,
  phone: target.phone + addition.phone,
  card: target.card + addition.card,
  ip: target.ip + addition.ip,
  apiKey: target.apiKey + addition.apiKey,
})

/* ------------------------------ splits ------------------------------ */

export type SplitName = 'train' | 'val' | 'holdout'
export type SplitRatios = { train: number; val: number; holdout: number }

export const DEFAULT_SPLIT_RATIOS: SplitRatios = { train: 0.8, val: 0.1, holdout: 0.1 }

const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex')

/**
 * Assign whole source-doc groups to train/val/holdout so a document never
 * straddles splits. Deterministic: groups are ordered by sha256(group key) and
 * each group goes to the split with the most remaining capacity.
 */
export const assignSplits = (
  docKeys: string[],
  ratios: SplitRatios = DEFAULT_SPLIT_RATIOS
): SplitName[] => {
  const groups = new Map<string, number[]>()
  for (const [index, docKey] of docKeys.entries()) {
    const group = groups.get(docKey) ?? []
    group.push(index)
    groups.set(docKey, group)
  }
  const total = docKeys.length
  const normalized: SplitRatios = {
    train: Math.max(0, ratios.train),
    val: Math.max(0, ratios.val),
    holdout: Math.max(0, ratios.holdout),
  }
  const sum = normalized.train + normalized.val + normalized.holdout
  if (sum <= 0) {
    normalized.train = 1
  }
  const scale = normalized.train + normalized.val + normalized.holdout
  const targets: Record<SplitName, number> = {
    train: Math.round((total * normalized.train) / scale),
    val: Math.round((total * normalized.val) / scale),
    holdout: Math.round((total * normalized.holdout) / scale),
  }
  if (total >= 10) {
    for (const split of ['train', 'val', 'holdout'] as SplitName[]) {
      if (normalized[split] > 0 && targets[split] === 0) {
        targets[split] = 1
      }
    }
  }
  const assigned: SplitName[] = new Array(total).fill('train')
  const counts: Record<SplitName, number> = { train: 0, val: 0, holdout: 0 }
  const keys = [...groups.keys()].sort((left, right) => hashKey(left).localeCompare(hashKey(right)))
  for (const key of keys) {
    const indexes = groups.get(key) as number[]
    const candidates: SplitName[] = ['train', 'val', 'holdout']
    let best: SplitName = 'train'
    let bestCapacity = Number.NEGATIVE_INFINITY
    for (const split of candidates) {
      const capacity = targets[split] - counts[split]
      if (capacity > bestCapacity) {
        bestCapacity = capacity
        best = split
      }
    }
    for (const index of indexes) {
      assigned[index] = best
    }
    counts[best] += indexes.length
  }
  // Rebalance when a nonzero split stayed empty because the total is tiny.
  if (total >= 10) {
    for (const split of ['val', 'holdout'] as SplitName[]) {
      if (counts[split] === 0) {
        const donor = assigned.findIndex(
          (value, index) =>
            value === 'train' &&
            counts.train > 1 &&
            groups.get(docKeys[index] as string)?.length === 1
        )
        if (donor !== -1) {
          assigned[donor] = split
          counts.train -= 1
          counts[split] += 1
        }
      }
    }
  }
  return assigned
}

/* ------------------------------ small helpers ------------------------------ */

export const normalizeForDedupe = (text: string): string => wordsOf(text).join(' ')

export const contentHash = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`
