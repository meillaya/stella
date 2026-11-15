/**
 * Local source handling: format detection, UTF-8 decoding, Markdown/TXT/HTML
 * extraction. No PDF/Office parser ships locally — those formats go through the
 * DeepSeek OCR API (see `remote.ts`).
 */
import path from 'node:path'
import { normalizeText } from '../rag/text.ts'
import type { PageStart } from '../rag/chunk.ts'
import { extractHtml } from './html.ts'

export type SourceKind =
  | 'markdown'
  | 'text'
  | 'html'
  | 'pdf'
  | 'doc'
  | 'docx'
  | 'ppt'
  | 'pptx'
  | 'image'
  | 'unsupported'

export type ExtractedDocument = {
  /** Title detected from frontmatter/`<title>`/first H1; caller supplies a fallback. */
  title: string | null
  /** Normalized text. */
  text: string
  pageCount: number
  pageStarts?: PageStart[]
  format: string
}

const EXTENSION_KINDS: Record<string, SourceKind> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdx': 'markdown',
  '.mdown': 'markdown',
  '.txt': 'text',
  '.text': 'text',
  '.log': 'text',
  '.html': 'html',
  '.htm': 'html',
  '.xhtml': 'html',
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'docx',
  '.ppt': 'ppt',
  '.pptx': 'pptx',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.bmp': 'image',
  '.tif': 'image',
  '.tiff': 'image',
}

const MIME_KINDS: Record<string, SourceKind> = {
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',
  'text/plain': 'text',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'image/bmp': 'image',
  'image/tiff': 'image',
}

export const SUPPORTED_EXTENSIONS = Object.keys(EXTENSION_KINDS)

const startsWithBytes = (data: Uint8Array, signature: number[]): boolean => {
  if (data.byteLength < signature.length) {return false}
  return signature.every((byte, index) => data[index] === byte)
}

const detectFromMagic = (data: Uint8Array): SourceKind | null => {
  if (startsWithBytes(data, [0x25, 0x50, 0x44, 0x46])) {return 'pdf'} // %PDF-
  if (startsWithBytes(data, [0x50, 0x4b, 0x03, 0x04])) {return null} // zip: rely on extension/mime
  if (startsWithBytes(data, [0x89, 0x50, 0x4e, 0x47])) {return 'image'}
  if (startsWithBytes(data, [0xff, 0xd8, 0xff])) {return 'image'}
  if (startsWithBytes(data, [0x47, 0x49, 0x46, 0x38])) {return 'image'}
  if (startsWithBytes(data, [0x52, 0x49, 0x46, 0x46])) {return 'image'} // RIFF (webp)
  return null
}

/** Detect what a file is: extension first, then MIME type, then magic bytes. */
export const detectSourceKind = (
  fileName: string,
  mimeType?: string,
  data?: Uint8Array
): SourceKind => {
  const extension = path.extname(fileName).toLowerCase()
  const byExtension = EXTENSION_KINDS[extension]
  if (byExtension) {return byExtension}
  const cleanMime = (mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  const byMime = MIME_KINDS[cleanMime]
  if (byMime) {return byMime}
  if (data) {
    const byMagic = detectFromMagic(data)
    if (byMagic) {return byMagic}
  }
  return 'unsupported'
}

export const isOcrKind = (kind: SourceKind): boolean =>
  kind === 'pdf' || kind === 'doc' || kind === 'docx' || kind === 'ppt' || kind === 'pptx' || kind === 'image'

export const decodeUtf8 = (data: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(data)

/** Strip a YAML frontmatter block and pick up a simple `title:` key. */
export const splitFrontmatter = (raw: string): { title: string | null; body: string } => {
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw
  if (!/^---[ \t]*\r?\n/.test(text)) {return { title: null, body: text }}
  const lines = text.split(/\r?\n/)
  let closing = -1
  for (let index = 1; index < Math.min(lines.length, 80); index += 1) {
    if (/^---[ \t]*$/.test(lines[index] as string)) {
      closing = index
      break
    }
  }
  if (closing < 0) {return { title: null, body: text }}
  const front = lines.slice(1, closing).join('\n')
  const titleMatch = /^title[ \t]*:[ \t]*(.+)$/im.exec(front)
  const title = titleMatch?.[1]?.trim().replace(/^['"]|['"]$/g, '') || null
  return { title, body: lines.slice(closing + 1).join('\n') }
}

/** Plain file name as a human title (no extension, underscores to spaces). */
export const titleFromFileName = (fileName: string): string => {
  const base = path.basename(fileName)
  const withoutExtension = base.replace(/\.[^.]+$/, '')
  const spaced = withoutExtension.replace(/[_-]+/g, ' ').trim()
  return spaced || base || 'Untitled document'
}

const firstMarkdownHeading = (markdown: string): string | null => {
  const match = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(markdown)
  return match?.[1]?.trim() || null
}

/** Extract Markdown or TXT content (frontmatter aware). */
export const extractMarkdownOrText = (kind: 'markdown' | 'text', raw: string): ExtractedDocument => {
  const { title, body } = splitFrontmatter(raw)
  const normalized = normalizeText(body)
  const fallbackTitle = kind === 'markdown' ? firstMarkdownHeading(normalized) : null
  return {
    title: title ?? fallbackTitle ?? null,
    text: normalized,
    pageCount: 0,
    format: kind,
  }
}

/** Extract HTML content into normalized Markdown-shaped text. */
export const extractHtmlDocument = (raw: string): ExtractedDocument => {
  const extracted = extractHtml(raw)
  return {
    title: extracted.title,
    text: normalizeText(extracted.markdown),
    pageCount: 0,
    format: 'html',
  }
}

/**
 * Turn OCR per-page text into one normalized document plus page offsets.
 * Each page is normalized individually so offsets remain valid after the join.
 */
export const pagesToDocument = (pages: string[]): { text: string; pageStarts: PageStart[] } => {
  const normalizedPages = pages.map((page) => normalizeText(page))
  const pageStarts: PageStart[] = []
  const parts: string[] = []
  let offset = 0
  normalizedPages.forEach((page, index) => {
    pageStarts.push({ start: offset, page: index + 1 })
    parts.push(page)
    offset += page.length + (index < normalizedPages.length - 1 ? 2 : 0)
  })
  return { text: parts.join('\n\n'), pageStarts }
}

/** Remove DeepSeek OCR special tokens and normalized box coordinates. */
export const cleanOcrText = (text: string): string =>
  text
    .replace(/<｜\s*\/?\s*(?:ref|box)\s*｜>/g, ' ')
    .replace(/\[\[\s*-?\d+(?:\s*,\s*-?\d+){3}\s*\]\]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/** First short line of the first page is a decent OCR title fallback. */
export const titleFromOcrPages = (pages: string[], fileName: string): string => {
  const firstPage = pages.map((page) => page.trim()).find((page) => page.length > 0) ?? ''
  const firstLine = firstPage.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? ''
  if (firstLine.length >= 3 && firstLine.length <= 100 && !/[.!?]$/.test(firstLine)) {
    return firstLine
  }
  return titleFromFileName(fileName)
}
