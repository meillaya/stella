/**
 * Structure-aware chunker for normalized Markdown-ish text.
 *
 * Design:
 * - Heading-aware sections carry a breadcrumb (`doc title > H1 > H2 > ...`).
 * - Fenced code blocks and pipe tables are atomic when they fit the cap; they
 *   are only split at line/word boundaries when they exceed `maxTokens`.
 * - Sections are packed toward `targetTokens` and split by block boundaries
 *   first; oversized single blocks are split at line/sentence boundaries.
 * - Tiny sections are merged with a neighbour when the result fits the target
 *   (heading-only sections such as `# Title` followed by `## Section` merge
 *   forward into the more specific heading).
 * - `overlapTokens` defaults to 0; when set, consecutive chunks of the same
 *   section share a small prefix.
 * - Every `ChunkDraft.text` is exactly `source.text.slice(charStart, charEnd)`,
 *   ids are stable: `chk_<document id without doc_ prefix>_<start>_<end>`.
 */
import { estimateTokens } from '../../../shared/pricing.ts'
import { buildCodeTokens } from './code-tokens.ts'
import { charsForTokens, trimRange } from './text.ts'

export type ChunkOptions = {
  /** Soft packing target in estimated tokens. Default 350. */
  targetTokens?: number
  /** Hard cap where possible; atomic blocks larger than this are split. Default 500. */
  maxTokens?: number
  /** Sections smaller than this merge into a neighbour. Default 40. */
  minTokens?: number
  /** Shared prefix tokens between consecutive chunks of one section. Default 0. */
  overlapTokens?: number
}

export const DEFAULT_CHUNK_OPTIONS = {
  targetTokens: 350,
  maxTokens: 500,
  minTokens: 40,
  overlapTokens: 0,
} as const

export type PageStart = {
  /** Character offset in the normalized text where the page starts. */
  start: number
  /** 1-based page number. */
  page: number
}

export type ChunkSource = {
  /** Stable document id; part of the chunk id. */
  id: string
  title: string
  /** Normalized text (`normalizeText`); offsets refer to this string. */
  text: string
  /** Page boundaries for OCR/PDF sources. */
  pageStarts?: PageStart[]
}

export type ChunkMeta = {
  headingLevel: number
  blockKinds: string[]
  /** True for chunks that continue a section split across chunks. */
  continued: boolean
  /** True when the chunk shares an overlap prefix with the previous chunk. */
  overlapping: boolean
  /** Breadcrumbs of sections folded into this chunk (tiny-section merge). */
  mergedSections: string[]
}

export type ChunkDraft = {
  id: string
  ordinal: number
  text: string
  breadcrumb: string
  headingPath: string[]
  charStart: number
  charEnd: number
  tokenEst: number
  codeTokens: string
  pageFrom: number | null
  pageTo: number | null
  meta: ChunkMeta
}

/** Stable chunk id derived from document id + character offsets. */
export const chunkIdFor = (documentId: string, charStart: number, charEnd: number): string => {
  const bare = documentId.startsWith('doc_') ? documentId.slice(4) : documentId
  return `chk_${bare}_${charStart}_${charEnd}`
}

/** `doc title > H1 > H2`, collapsing consecutive duplicate parts. */
export const makeBreadcrumb = (title: string, headingPath: string[]): string => {
  const parts: string[] = []
  const push = (value: string): void => {
    const trimmed = value.trim()
    if (!trimmed) {return}
    const last = parts[parts.length - 1]
    if (last && last.toLowerCase() === trimmed.toLowerCase()) {return}
    parts.push(trimmed)
  }
  push(title)
  for (const heading of headingPath) {push(heading)}
  return parts.join(' > ')
}

/* ------------------------------- parsing ------------------------------- */

type BlockKind = 'heading' | 'paragraph' | 'code' | 'table' | 'list' | 'quote'

type Block = {
  kind: BlockKind
  start: number
  end: number
  text: string
  level: number
  heading: string
}

type Section = {
  headingLevel: number
  headingPath: string[]
  blocks: Block[]
}

type Unit = {
  start: number
  end: number
  headingPath: string[]
  level: number
  kinds: string[]
  continued: boolean
  overlapping: boolean
  mergedSections: string[]
}

type Line = { start: number; end: number; text: string }

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/
const QUOTE = /^ {0,3}>/

const splitLines = (text: string): Line[] => {
  const lines: Line[] = []
  let offset = 0
  for (const raw of text.split('\n')) {
    lines.push({ start: offset, end: offset + raw.length, text: raw })
    offset += raw.length + 1
  }
  return lines
}

const isTableDelimiter = (line: string): boolean => {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) {return false}
  return /^[|\s:-]+$/.test(trimmed) && trimmed.includes('-')
}

const isTableStart = (lines: Line[], index: number): boolean => {
  const line = lines[index]
  const next = lines[index + 1]
  return Boolean(line && next && line.text.includes('|') && isTableDelimiter(next.text))
}

const isBlankLine = (line: Line | undefined): boolean => !line || line.text.trim().length === 0

const parseBlocks = (text: string): Block[] => {
  const lines = splitLines(text)
  const blocks: Block[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (!line || isBlankLine(line)) {
      index += 1
      continue
    }

    const fence = FENCE.exec(line.text)
    if (fence) {
      const marker = fence[1] as string
      const fenceChar = marker[0]
      let close = index + 1
      while (close < lines.length) {
        const candidate = lines[close]
        const closing = candidate ? /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(candidate.text) : null
        if (closing && (closing[1] as string)[0] === fenceChar && (closing[1] as string).length >= marker.length) {
          break
        }
        close += 1
      }
      const last = Math.min(close, lines.length - 1)
      const start = line.start
      const end = lines[last]?.end ?? line.end
      blocks.push({ kind: 'code', start, end, text: text.slice(start, end), level: 0, heading: '' })
      index = last + 1
      continue
    }

    const heading = HEADING.exec(line.text)
    if (heading && (heading[2] ?? '').trim().length > 0) {
      const level = (heading[1] as string).length
      const headingText = (heading[2] as string).replace(/[ \t]+#+[ \t]*$/, '').trim()
      blocks.push({
        kind: 'heading',
        start: line.start,
        end: line.end,
        text: text.slice(line.start, line.end),
        level,
        heading: headingText,
      })
      index += 1
      continue
    }

    if (isTableStart(lines, index)) {
      let endIndex = index + 1
      while (endIndex < lines.length) {
        const candidate = lines[endIndex]
        if (!candidate || isBlankLine(candidate) || !candidate.text.includes('|')) {break}
        if (FENCE.test(candidate.text) || HEADING.test(candidate.text)) {break}
        endIndex += 1
      }
      const start = line.start
      const end = lines[endIndex - 1]?.end ?? line.end
      blocks.push({ kind: 'table', start, end, text: text.slice(start, end), level: 0, heading: '' })
      index = endIndex
      continue
    }

    if (LIST_ITEM.test(line.text)) {
      let endIndex = index + 1
      while (endIndex < lines.length) {
        const candidate = lines[endIndex]
        if (!candidate || isBlankLine(candidate)) {break}
        if (LIST_ITEM.test(candidate.text) || /^[ \t]{2,}\S/.test(candidate.text)) {
          endIndex += 1
          continue
        }
        break
      }
      const start = line.start
      const end = lines[endIndex - 1]?.end ?? line.end
      blocks.push({ kind: 'list', start, end, text: text.slice(start, end), level: 0, heading: '' })
      index = endIndex
      continue
    }

    if (QUOTE.test(line.text)) {
      let endIndex = index + 1
      while (endIndex < lines.length && QUOTE.test(lines[endIndex]?.text ?? '')) {endIndex += 1}
      const start = line.start
      const end = lines[endIndex - 1]?.end ?? line.end
      blocks.push({ kind: 'quote', start, end, text: text.slice(start, end), level: 0, heading: '' })
      index = endIndex
      continue
    }

    let endIndex = index + 1
    while (endIndex < lines.length) {
      const candidate = lines[endIndex]
      if (!candidate || isBlankLine(candidate)) {break}
      if (
        FENCE.test(candidate.text) ||
        HEADING.test(candidate.text) ||
        LIST_ITEM.test(candidate.text) ||
        QUOTE.test(candidate.text) ||
        isTableStart(lines, endIndex)
      ) {
        break
      }
      endIndex += 1
    }
    const start = line.start
    const end = lines[endIndex - 1]?.end ?? line.end
    blocks.push({ kind: 'paragraph', start, end, text: text.slice(start, end), level: 0, heading: '' })
    index = endIndex
  }

  return blocks
}

const buildSections = (blocks: Block[]): Section[] => {
  const sections: Section[] = []
  const stack: string[] = []
  let current: Section | null = null

  for (const block of blocks) {
    if (block.kind === 'heading') {
      if (block.level - 1 >= stack.length) {
        while (stack.length < block.level - 1) {stack.push('')}
      } else {
        stack.length = block.level - 1
      }
      stack.push(block.heading)
      current = {
        headingLevel: block.level,
        headingPath: stack.filter((part) => part.length > 0),
        blocks: [block],
      }
      sections.push(current)
      continue
    }
    if (!current) {
      current = { headingLevel: 0, headingPath: [], blocks: [] }
      sections.push(current)
    }
    current.blocks.push(block)
  }

  return sections.filter((section) => section.blocks.length > 0)
}

/* ------------------------------- splitting ------------------------------- */

const unitTokens = (text: string, unit: Unit): number =>
  estimateTokens(text.slice(unit.start, unit.end))

const unitFromBlocks = (
  text: string,
  blocks: Block[],
  headingPath: string[],
  level: number,
  continued: boolean
): Unit => {
  const first = blocks[0] as Block
  const last = blocks[blocks.length - 1] as Block
  const trimmed = trimRange(text, first.start, last.end)
  return {
    start: trimmed.start,
    end: trimmed.end,
    headingPath: [...headingPath],
    level,
    kinds: [...new Set(blocks.map((block) => block.kind))],
    continued,
    overlapping: false,
    mergedSections: [],
  }
}

/** Split one oversized block at line/sentence boundaries. */
const splitOversizedBlock = (text: string, block: Block, targetTokens: number, maxTokens: number): Block[] => {
  const parts: Block[] = []
  const chunkChars = charsForTokens(targetTokens)
  let start = block.start
  let guard = 0

  while (start < block.end && guard < 10_000) {
    guard += 1
    if (estimateTokens(text.slice(start, block.end)) <= maxTokens) {
      const trimmed = trimRange(text, start, block.end)
      if (trimmed.end > trimmed.start) {parts.push({ ...block, start: trimmed.start, end: trimmed.end })}
      break
    }

    let cut = Math.min(block.end, start + chunkChars)
    const newline = text.lastIndexOf('\n', cut)
    if (newline > start + Math.floor(chunkChars * 0.4)) {
      cut = newline
    } else {
      const window = text.slice(start, cut)
      const boundary = Math.max(
        window.lastIndexOf('。 '),
        window.lastIndexOf('. '),
        window.lastIndexOf('! '),
        window.lastIndexOf('? '),
        window.lastIndexOf('；'),
        window.lastIndexOf('; '),
        window.lastIndexOf(', '),
        window.lastIndexOf(' ')
      )
      if (boundary > window.length * 0.4) {cut = start + boundary + 1}
    }
    if (cut <= start) {cut = Math.min(block.end, start + chunkChars)}
    if (cut <= start) {break}

    const trimmed = trimRange(text, start, cut)
    if (trimmed.end > trimmed.start) {parts.push({ ...block, start: trimmed.start, end: trimmed.end })}
    start = cut
  }

  return parts
}

const sectionToUnits = (text: string, section: Section, options: Required<ChunkOptions>): Unit[] => {
  const whole = unitFromBlocks(text, section.blocks, section.headingPath, section.headingLevel, false)
  if (unitTokens(text, whole) <= options.maxTokens) {return [whole]}

  const units: Unit[] = []
  let group: Block[] = []
  let groupTokens = 0

  const flush = (): void => {
    if (group.length === 0) {return}
    units.push(
      unitFromBlocks(text, group, section.headingPath, section.headingLevel, units.length > 0)
    )
    group = []
    groupTokens = 0
  }

  for (const block of section.blocks) {
    const pieces =
      estimateTokens(block.text) > options.maxTokens
        ? splitOversizedBlock(text, block, options.targetTokens, options.maxTokens)
        : [block]
    for (const piece of pieces) {
      const tokens = estimateTokens(piece.text)
      const limit = groupTokens < options.minTokens ? options.maxTokens : options.targetTokens
      if (group.length > 0 && groupTokens + tokens > limit) {flush()}
      group.push(piece)
      groupTokens += tokens
      if (groupTokens >= options.targetTokens) {flush()}
    }
  }
  flush()

  return units.length > 0 ? units : [whole]
}

const commonHeadingPrefix = (a: string[], b: string[]): string[] => {
  const limit = Math.min(a.length, b.length)
  const prefix: string[] = []
  for (let index = 0; index < limit; index += 1) {
    const left = a[index]
    const right = b[index]
    if (!left || !right || left.toLowerCase() !== right.toLowerCase()) {break}
    prefix.push(left)
  }
  return prefix
}

const isHeadingPrefix = (prefix: string[], path: string[]): boolean =>
  prefix.length <= path.length &&
  prefix.every((part, index) => part.toLowerCase() === (path[index] ?? '').toLowerCase())

/** Best breadcrumb for a merged chunk: the longer path when one is prefixed, else the common ancestor. */
const mergedHeadingPath = (left: string[], right: string[]): string[] => {
  if (left.length === 0) {return [...right]}
  if (right.length === 0) {return [...left]}
  if (isHeadingPrefix(left, right)) {return [...right]}
  if (isHeadingPrefix(right, left)) {return [...left]}
  return commonHeadingPrefix(left, right)
}

/**
 * Tiny sections merge when they are related (parent/child or siblings under a
 * shared parent) and the combined chunk fits the packing target. This keeps
 * heading-only sections from becoming standalone chunks without fabricating a
 * breadcrumb from unrelated sections.
 */
const canMergeHeadings = (left: string[], right: string[]): boolean => {
  if (left.length === 0 || right.length === 0) {return true}
  const common = commonHeadingPrefix(left, right).length
  if (common === 0) {return false}
  return common >= Math.min(left.length, right.length) - 1
}

const mergeTinyUnits = (text: string, units: Unit[], options: Required<ChunkOptions>): Unit[] => {
  let current: Unit[] = units.map((unit) => ({
    ...unit,
    headingPath: [...unit.headingPath],
    kinds: [...unit.kinds],
    mergedSections: [...unit.mergedSections],
  }))
  let changed = true
  let guard = 0

  const mergeNeighbour = (target: Unit, source: Unit): void => {
    // `target` is always the left-hand unit and `source` the right-hand one.
    const combined = trimRange(text, target.start, source.end)
    target.start = combined.start
    target.end = combined.end
    const nextPath =
      target.mergedSections.length > 0
        ? commonHeadingPrefix(target.headingPath, source.headingPath)
        : mergedHeadingPath(target.headingPath, source.headingPath)
    target.mergedSections.push(source.headingPath.join(' > '))
    target.mergedSections.push(...source.mergedSections)
    target.headingPath = nextPath.length > 0 ? nextPath : target.headingPath
    target.level = target.headingPath.length
    target.kinds = [...new Set([...target.kinds, ...source.kinds])]
  }

  const isHeadingOnly = (unit: Unit): boolean =>
    unit.kinds.length === 1 && unit.kinds[0] === 'heading'

  while (changed && guard < 32) {
    changed = false
    guard += 1

    // Heading-only sections attach forward to their own content first, so a
    // `## Section` heading never gets glued to the tail of the previous section.
    const headingForward: Unit[] = []
    for (let index = 0; index < current.length; index += 1) {
      const unit = current[index]
      if (!unit) {continue}
      const next = current[index + 1]
      if (
        next &&
        isHeadingOnly(unit) &&
        unitTokens(text, unit) < options.minTokens &&
        canMergeHeadings(unit.headingPath, next.headingPath)
      ) {
        const combined = trimRange(text, unit.start, next.end)
        if (estimateTokens(text.slice(combined.start, combined.end)) <= options.maxTokens) {
          mergeNeighbour(unit, next)
          headingForward.push(unit)
          changed = true
          index += 1
          continue
        }
      }
      headingForward.push(unit)
    }
    current = headingForward

    // Merge tiny units into the previous unit when related and it fits.
    const backward: Unit[] = []
    for (const unit of current) {
      const previous = backward[backward.length - 1]
      if (previous && unitTokens(text, unit) < options.minTokens && canMergeHeadings(previous.headingPath, unit.headingPath)) {
        const combined = trimRange(text, previous.start, unit.end)
        if (estimateTokens(text.slice(combined.start, combined.end)) <= options.maxTokens) {
          mergeNeighbour(previous, unit)
          changed = true
          continue
        }
      }
      backward.push(unit)
    }
    current = backward

    // Forward merge for leading tiny units that could not merge backward.
    const forward: Unit[] = []
    for (let index = 0; index < current.length; index += 1) {
      const unit = current[index]
      if (!unit) {continue}
      const next = current[index + 1]
      if (next && unitTokens(text, unit) < options.minTokens && canMergeHeadings(unit.headingPath, next.headingPath)) {
        const combined = trimRange(text, unit.start, next.end)
        if (estimateTokens(text.slice(combined.start, combined.end)) <= options.maxTokens) {
          mergeNeighbour(unit, next)
          forward.push(unit)
          changed = true
          index += 1
          continue
        }
      }
      forward.push(unit)
    }
    current = forward
  }

  return current
}

const applyOverlap = (text: string, units: Unit[], options: Required<ChunkOptions>): void => {
  if (options.overlapTokens <= 0) {return}
  for (let index = 1; index < units.length; index += 1) {
    const unit = units[index]
    const previous = units[index - 1]
    if (!unit || !previous) {continue}
    if (unit.headingPath.join('\u0000') !== previous.headingPath.join('\u0000')) {continue}
    if (unit.start <= previous.start) {continue}
    const overlapChars = Math.min(unit.start - previous.start, charsForTokens(options.overlapTokens))
    if (overlapChars <= 0) {continue}
    const trimmed = trimRange(text, unit.start - overlapChars, unit.end)
    unit.start = trimmed.start
    unit.overlapping = true
  }
}

/* -------------------------------- pages -------------------------------- */

const pageAt = (pageStarts: PageStart[] | undefined, offset: number): number | null => {
  if (!pageStarts || pageStarts.length === 0) {return null}
  let page: number | null = null
  for (const entry of pageStarts) {
    if (entry.start <= offset) {page = entry.page}
    else {break}
  }
  return page
}

/* ------------------------------- public ------------------------------- */

/**
 * Split one normalized document into structural chunks with stable ids,
 * breadcrumbs, character offsets, page ranges and code-token shadow text.
 */
export const chunkDocument = (source: ChunkSource, options: ChunkOptions = {}): ChunkDraft[] => {
  const resolved: Required<ChunkOptions> = {
    targetTokens: options.targetTokens ?? DEFAULT_CHUNK_OPTIONS.targetTokens,
    maxTokens: options.maxTokens ?? DEFAULT_CHUNK_OPTIONS.maxTokens,
    minTokens: options.minTokens ?? DEFAULT_CHUNK_OPTIONS.minTokens,
    overlapTokens: options.overlapTokens ?? DEFAULT_CHUNK_OPTIONS.overlapTokens,
  }
  const text = source.text
  if (!text || text.trim().length === 0) {return []}

  const sections = buildSections(parseBlocks(text))
  if (sections.length === 0) {return []}

  const units: Unit[] = []
  for (const section of sections) {units.push(...sectionToUnits(text, section, resolved))}
  const merged = mergeTinyUnits(text, units, resolved)
  applyOverlap(text, merged, resolved)

  const drafts: ChunkDraft[] = []
  for (const unit of merged) {
    const trimmed = trimRange(text, unit.start, unit.end)
    if (trimmed.end <= trimmed.start) {continue}
    const chunkText = text.slice(trimmed.start, trimmed.end)
    drafts.push({
      id: chunkIdFor(source.id, trimmed.start, trimmed.end),
      ordinal: drafts.length,
      text: chunkText,
      breadcrumb: makeBreadcrumb(source.title, unit.headingPath),
      headingPath: unit.headingPath,
      charStart: trimmed.start,
      charEnd: trimmed.end,
      tokenEst: estimateTokens(chunkText),
      codeTokens: buildCodeTokens(chunkText),
      pageFrom: pageAt(source.pageStarts, trimmed.start),
      pageTo: pageAt(source.pageStarts, Math.max(trimmed.start, trimmed.end - 1)),
      meta: {
        headingLevel: unit.level,
        blockKinds: unit.kinds,
        continued: unit.continued,
        overlapping: unit.overlapping,
        mergedSections: unit.mergedSections,
      },
    })
  }

  return drafts
}
