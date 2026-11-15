/**
 * Text normalization and small text helpers shared by the chunker, ingestion
 * and retrieval layers.
 */
import { estimateTokens } from '../../../shared/pricing.ts'

export { estimateTokens }

/** Remove a UTF-8 byte-order mark left by decoders. */
export const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g
const NBSP = /\u00A0/g

/**
 * Canonical normalization applied before chunking. Offsets in `ChunkDraft`
 * always refer to the string returned by this function.
 *
 * - CRLF/CR become LF
 * - BOM, zero-width characters and NBSP are removed/normalized
 * - trailing whitespace per line is dropped
 * - 3+ blank lines collapse to 2 and outer whitespace is trimmed
 */
export const normalizeText = (raw: string): string => {
  const normalized = stripBom(raw)
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .replace(NBSP, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
  return normalized
}

/** Collapse a string to single-spaced text (snippets, inline labels). */
export const collapseWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Shrink a `[start, end)` range so it starts/ends on non-whitespace. */
export const trimRange = (text: string, start: number, end: number): { start: number; end: number } => {
  let from = Math.max(0, Math.min(start, text.length))
  let to = Math.max(from, Math.min(end, text.length))
  while (from < to && /\s/.test(text[from] as string)) {from += 1}
  while (to > from && /\s/.test(text[to - 1] as string)) {to -= 1}
  return { start: from, end: to }
}

/** Word-ish tokens, lowercased. Used for snippets, LIKE fallback and rerank prompts. */
export const tokenizeWords = (text: string): string[] => {
  const matches = text.match(/[\p{L}\p{N}]+/gu)
  return matches ? matches.map((word) => word.toLowerCase()) : []
}

/** Rough characters for a token budget (mixed English/CJK). Defaults to ~3.2 chars/token. */
export const charsForTokens = (tokens: number): number =>
  Math.max(24, Math.floor(Math.max(0, tokens) * 3.2))

/** `true` when the string has no visible content. */
export const isBlank = (text: string): boolean => collapseWhitespace(text).length === 0
