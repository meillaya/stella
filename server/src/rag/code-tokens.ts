/**
 * Shadow text for FTS5.
 *
 * The `unicode61` tokenizer keeps `getUserName` as a single (lowercased)
 * token, so a plain full-text index cannot match "get user name". For every
 * multi-part identifier we append its parts to the `code_tokens` column:
 *
 *   getUserName   -> "get user name"
 *   get_user_name -> "get user name"
 *   get-user-name -> "get user name"
 *   XMLHttpRequest -> "XML Http Request"  (indexed case-insensitively)
 *
 * The original identifier already lives in the `text` column, so the shadow
 * only needs the expanded parts. Single-part identifiers are skipped.
 */

const IDENTIFIER = /[\p{L}_][\p{L}\p{N}_]*/gu

/** Split one identifier into its component words (camelCase, snake_case, kebab-case). */
export const splitIdentifier = (identifier: string): string[] => {
  const parts: string[] = []
  for (const segment of identifier.split(/[_-]+/)) {
    if (!segment) {continue}
    const camelSplit = segment
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
      .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    parts.push(...camelSplit.split(/\s+/).filter(Boolean))
  }
  return parts
}

/** Expansion tokens for a single identifier, or `[]` when it is already one word. */
export const expandIdentifier = (identifier: string): string[] => {
  const parts = splitIdentifier(identifier)
  return parts.length > 1 ? parts : []
}

/** Build the `code_tokens` shadow string for a chunk. */
export const buildCodeTokens = (text: string): string => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of text.matchAll(IDENTIFIER)) {
    const identifier = match[0]
    if (identifier.length < 3) {continue}
    const parts = splitIdentifier(identifier)
    if (parts.length < 2) {continue}
    const key = parts.join(' ')
    if (seen.has(key)) {continue}
    seen.add(key)
    out.push(key)
  }
  return out.join(' ')
}
