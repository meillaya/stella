/**
 * Query handling for FTS5 retrieval.
 *
 * User queries are untrusted: `C++`, `"quoted phrases"`, `AND`/`OR`/`NEAR`
 * operators, `*`, `-`, `:` and parentheses all appear in real questions. We
 * never pass the raw query to FTS5; instead every token is extracted, quoted
 * (with inner quotes doubled) and OR-ed together. camelCase/snake_case query
 * tokens also get a phrase clause over their expanded parts so the
 * `code_tokens` shadow column can match them.
 */
import { collapseWhitespace, tokenizeWords } from './text.ts'
import { splitIdentifier } from './code-tokens.ts'

const FTS_OPERATORS = new Set(['and', 'or', 'not', 'near'])

export type QueryPart =
  | { kind: 'term'; token: string }
  | { kind: 'phrase'; tokens: string[] }

const WORD_CHAR = /[\p{L}\p{N}_-]/u

/** Split a query into word terms and quoted phrases, preserving cases. */
export const parseQuery = (query: string): QueryPart[] => {
  const text = typeof query === 'string' ? query : ''
  const parts: QueryPart[] = []
  let index = 0

  while (index < text.length) {
    const char = text[index] as string
    if (char === '"' || char === '“' || char === '”') {
      let close = index + 1
      let phrase = ''
      while (close < text.length) {
        const next = text[close] as string
        if (next === '"' || next === '“' || next === '”') {break}
        phrase += next
        close += 1
      }
      const tokens = phrase.match(/[\p{L}\p{N}]+/gu) ?? []
      if (tokens.length > 0) {parts.push({ kind: 'phrase', tokens: tokens.slice(0, 12) })}
      index = close < text.length ? close + 1 : close
      continue
    }
    if (WORD_CHAR.test(char)) {
      let end = index + 1
      while (end < text.length && WORD_CHAR.test(text[end] as string)) {end += 1}
      const raw = text.slice(index, end)
      for (const token of raw.match(/[\p{L}\p{N}]+/gu) ?? []) {
        if (FTS_OPERATORS.has(token.toLowerCase()) && token === token.toUpperCase()) {continue}
        parts.push({ kind: 'term', token })
      }
      index = end
      continue
    }
    index += 1
  }

  return parts
}

const quoteFts = (value: string): string => `"${value.replaceAll('"', '""')}"`

/**
 * Build a safe FTS5 MATCH expression from a user query. Returns `null` when
 * the query has no indexable tokens (e.g. `"+++"`); callers then use LIKE.
 */
export const escapeFtsQuery = (query: string): string | null => {
  const clauses = new Set<string>()
  for (const part of parseQuery(query)) {
    if (part.kind === 'phrase') {
      const tokens = part.tokens.filter((token) => !FTS_OPERATORS.has(token.toLowerCase()))
      if (tokens.length > 0) {clauses.add(quoteFts(tokens.join(' ')))}
      continue
    }
    const token = part.token
    if (!token) {continue}
    clauses.add(quoteFts(token))
    const expanded = splitIdentifier(token)
      .map((piece) => piece.toLowerCase())
      .filter((piece) => !FTS_OPERATORS.has(piece))
    if (expanded.length > 1) {clauses.add(quoteFts(expanded.join(' ')))}
  }
  if (clauses.size === 0) {return null}
  return [...clauses].join(' OR ')
}

/** Lowercased word tokens of a query (snippets, LIKE fallback scoring, judge prompts). */
export const queryTerms = (query: string): string[] => tokenizeWords(query)

/** Escape `%`/`_`/`\` for use with `LIKE ? ESCAPE '\'`. */
export const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`)

const TERM_MIN_LENGTH = 2

/**
 * Deterministic excerpt around the earliest query-term match. Used for the
 * `SourceRef.snippet` field shown in the UI and passed to the judge.
 */
const snippetClean = (text: string): string =>
  text
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*$/gm, ' ')
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^ {0,3}>[ \t]?/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[*_]{1,2}([^*_\n]+)[*_]{1,2}/g, '$1')

export const makeSnippet = (text: string, query: string, maxLength = 280): string => {
  const clean = collapseWhitespace(snippetClean(text))
  if (clean.length <= maxLength) {return clean}

  const terms = [...new Set(tokenizeWords(query))]
    .filter((term) => term.length >= TERM_MIN_LENGTH)
    .slice(0, 12)
  const lower = clean.toLowerCase()
  let matchIndex = -1
  for (const term of terms) {
    const found = lower.indexOf(term)
    if (found >= 0 && (matchIndex < 0 || found < matchIndex)) {matchIndex = found}
  }

  if (matchIndex < 0) {return `${clean.slice(0, maxLength - 1).trimEnd()}…`}

  let start = Math.max(0, matchIndex - Math.floor(maxLength * 0.3))
  let end = Math.min(clean.length, start + maxLength)
  start = Math.max(0, end - maxLength)
  if (start > 0) {
    const space = clean.indexOf(' ', start)
    if (space >= 0 && space < start + 24) {start = space + 1}
  }
  if (end < clean.length) {
    const space = clean.lastIndexOf(' ', end)
    if (space > start + Math.floor(maxLength * 0.6)) {end = space}
  }
  const snippet = clean.slice(start, end).trim()
  return `${start > 0 ? '…' : ''}${snippet}${end < clean.length ? '…' : ''}`
}

/** Count case-insensitive occurrences of `needle` in `haystack` (overlapping not counted). */
export const countOccurrences = (haystack: string, needle: string): number => {
  if (!haystack || !needle) {return 0}
  const source = haystack.toLowerCase()
  const target = needle.toLowerCase()
  let count = 0
  let from = 0
  for (;;) {
    const found = source.indexOf(target, from)
    if (found < 0) {return count}
    count += 1
    from = found + target.length
  }
}
