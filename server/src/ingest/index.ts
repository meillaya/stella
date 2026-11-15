/**
 * Ingestion pipeline for one collection:
 *
 * - Markdown / TXT / HTML: parsed locally (`node-html-parser` for HTML only).
 * - URLs: DeepSeek Fetch API (`POST /v1/tools/fetch`) when a key is configured,
 *   local `fetch` + HTML strip fallback otherwise.
 * - PDF / DOC(X) / PPT(X) / images: DeepSeek OCR (`POST /v1/tools/ocr`,
 *   multipart `purpose=text_recognition`, per-page text). No local parser.
 *
 * Dedupe: a document with the same sha256 content hash in the collection is
 * updated in place (metadata refreshed, chunks replaced atomically). A URL
 * whose content changed reuses the document id for that URI.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Db } from '../db/index.ts'
import { getDb } from '../db/index.ts'
import { RagError, type IngestResult } from '../rag/contract.ts'
import { sha256Hex } from '../rag/hash.ts'
import { resolveCollection } from '../rag/store.ts'
import { normalizeText } from '../rag/text.ts'
import type {
  IngestFileInput,
  IngestPathsInput,
  IngestPathsResult,
  IngestPathError,
  IngestTextInput,
  IngestUrlInput,
  IngestUrlError,
  IngestUrlsInput,
  IngestUrlsResult,
} from '../rag/contract.ts'
import {
  cleanOcrText,
  decodeUtf8,
  detectSourceKind,
  extractHtmlDocument,
  extractMarkdownOrText,
  isOcrKind,
  pagesToDocument,
  SUPPORTED_EXTENSIONS,
  titleFromFileName,
  titleFromOcrPages,
} from './local.ts'
import { localFetchMarkdown, remoteFetchMarkdown, remoteOcr, resolveRemoteConfig, type FetchedUrl } from './remote.ts'
import { persistDocument } from './store.ts'

const MAX_URLS = 50

const requireCollection = (db: Db, collectionId: string) => {
  const collection = resolveCollection(collectionId, db)
  if (!collection) {
    throw new RagError('not_found', `Collection "${collectionId}" was not found`)
  }
  return collection
}

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

const codeOf = (error: unknown): IngestUrlError['code'] | undefined =>
  error instanceof RagError ? error.code : undefined

const urlTitle = (value: string): string => {
  try {
    const url = new URL(value)
    const last = url.pathname.split('/').filter(Boolean).pop()
    if (last) {
      const decoded = decodeURIComponent(last).replace(/[-_]+/g, ' ').trim()
      if (decoded) {return decoded.replace(/\.[a-z0-9]+$/i, '') || decoded}
    }
    return url.hostname
  } catch {
    return value.slice(0, 80)
  }
}

const decodeOcrPages = (pages: { text: string }[]): string[] =>
  pages.map((page) => cleanOcrText(page.text))

/** Ingest one local file from raw bytes (Markdown/TXT/HTML or OCR formats). */
export const ingestFile = async (input: IngestFileInput, db?: Db): Promise<IngestResult> => {
  const database = db ?? getDb()
  const collection = requireCollection(database, input.collectionId)
  if (!input.data || input.data.byteLength === 0) {
    throw new RagError('invalid_input', 'File is empty')
  }
  const fileName = input.fileName?.trim() || 'document'
  const kind = detectSourceKind(fileName, input.mimeType, input.data)
  const contentHash = sha256Hex(input.data)

  if (kind === 'markdown' || kind === 'text' || kind === 'html') {
    const raw = decodeUtf8(input.data)
    const extracted =
      kind === 'html' ? extractHtmlDocument(raw) : extractMarkdownOrText(kind, raw)
    const title = input.title?.trim() || extracted.title || titleFromFileName(fileName)
    return persistDocument(
      {
        collectionId: collection.id,
        title,
        sourceType: 'file',
        uri: null,
        contentHash,
        bytes: input.data.byteLength,
        pageCount: 0,
        meta: { format: extracted.format, fileName },
        text: extracted.text,
      },
      database
    )
  }

  if (!isOcrKind(kind)) {
    throw new RagError(
      'unsupported_type',
      `Unsupported file type for "${fileName}". Supported: Markdown, TXT, HTML, PDF, DOC(X), PPT(X), PNG/JPEG/WebP/GIF/BMP/TIFF.`
    )
  }

  const remote = resolveRemoteConfig(input)
  const ocr = await remoteOcr(remote, { fileName, mimeType: input.mimeType, data: input.data })
  const pages = decodeOcrPages(ocr.pages)
  const { text, pageStarts } = pagesToDocument(pages)
  const title = input.title?.trim() || titleFromOcrPages(pages, fileName)
  return persistDocument(
    {
      collectionId: collection.id,
      title,
      sourceType: 'file',
      uri: null,
      contentHash,
      bytes: input.data.byteLength,
      pageCount: ocr.pageCount,
      meta: {
        format: kind,
        fileName,
        ocr: { id: ocr.id, purpose: ocr.purpose, usage: ocr.usage },
      },
      text,
      pageStarts,
    },
    database
  )
}

/** Ingest already-extracted text (CLI, promote flows, tests). */
export const ingestText = async (input: IngestTextInput, db?: Db): Promise<IngestResult> => {
  const database = db ?? getDb()
  const collection = requireCollection(database, input.collectionId)
  const title = input.title?.trim()
  if (!title) {throw new RagError('invalid_input', 'Document title is required')}
  const raw = typeof input.text === 'string' ? input.text : ''
  if (!raw.trim()) {throw new RagError('invalid_input', 'Document text is empty')}
  const sourceType = input.sourceType ?? 'text'
  const extracted =
    sourceType === 'text'
      ? { text: normalizeText(raw), format: 'text', title: null as string | null }
      : extractMarkdownOrText('markdown', raw)
  const uri = input.uri?.trim() || null
  const contentHash = sha256Hex(raw)
  return persistDocument(
    {
      collectionId: collection.id,
      title: input.title?.trim() || extracted.title || title,
      sourceType,
      uri,
      contentHash,
      bytes: new TextEncoder().encode(raw).byteLength,
      pageCount: 0,
      meta: { format: extracted.format, sourceType },
      text: extracted.text,
    },
    database
  )
}

/** Ingest one URL through the DeepSeek Fetch API (or local fetch fallback). */
export const ingestUrl = async (input: IngestUrlInput, db?: Db): Promise<IngestResult> => {
  const database = db ?? getDb()
  const collection = requireCollection(database, input.collectionId)
  const rawUrl = typeof input.url === 'string' ? input.url.trim() : ''
  if (!rawUrl) {throw new RagError('invalid_input', 'URL is required')}

  const remote = resolveRemoteConfig(input)
  let fetched: FetchedUrl
  if (remote.apiKey) {
    try {
      fetched = await remoteFetchMarkdown(remote, rawUrl)
    } catch (error) {
      if (error instanceof RagError && error.code === 'no_api_key') {
        fetched = await localFetchMarkdown(remote.fetchImpl, rawUrl)
      } else {
        throw error
      }
    }
  } else {
    fetched = await localFetchMarkdown(remote.fetchImpl, rawUrl)
  }

  const markdown = normalizeText(fetched.markdown)
  if (!markdown.trim()) {
    throw new RagError('upstream_error', `No extractable content was found at ${rawUrl}`)
  }
  const title = input.title?.trim() || fetched.title?.trim() || urlTitle(rawUrl)
  return persistDocument(
    {
      collectionId: collection.id,
      title,
      sourceType: 'url',
      uri: rawUrl,
      contentHash: sha256Hex(markdown),
      bytes: new TextEncoder().encode(markdown).byteLength,
      pageCount: 0,
      meta: { format: 'url', url: rawUrl, fetchedWith: remote.apiKey ? 'deepseek-fetch' : 'local-fetch' },
      text: markdown,
    },
    database
  )
}

/** Ingest a batch of URLs sequentially; per-URL failures are reported, not thrown. */
export const ingestUrls = async (input: IngestUrlsInput, db?: Db): Promise<IngestUrlsResult> => {
  const database = db ?? getDb()
  const urls = Array.isArray(input.urls)
    ? input.urls.filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
    : []
  if (urls.length === 0) {throw new RagError('invalid_input', 'At least one URL is required')}
  if (urls.length > MAX_URLS) {
    throw new RagError('invalid_input', `At most ${MAX_URLS} URLs can be ingested at once`)
  }
  requireCollection(database, input.collectionId)

  const documents: IngestResult[] = []
  const errors: IngestUrlError[] = []
  for (const url of urls) {
    try {
      documents.push(
        await ingestUrl(
          {
            collectionId: input.collectionId,
            url,
            apiKey: input.apiKey,
            baseUrl: input.baseUrl,
            fetchImpl: input.fetchImpl,
          },
          database
        )
      )
    } catch (error) {
      errors.push({ url, message: messageOf(error), code: codeOf(error) })
    }
  }
  return { documents, errors }
}

const walkSupportedFiles = async (target: string, output: string[]): Promise<void> => {
  const info = await stat(target)
  if (info.isDirectory()) {
    const entries = await readdir(target, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {continue}
      await walkSupportedFiles(path.join(target, entry.name), output)
    }
    return
  }
  if (info.isFile()) {
    const extension = path.extname(target).toLowerCase()
    if (SUPPORTED_EXTENSIONS.includes(extension)) {output.push(target)}
  }
}

/** Ingest local files and directories (recursive, supported extensions only). */
export const ingestPaths = async (input: IngestPathsInput, db?: Db): Promise<IngestPathsResult> => {
  const database = db ?? getDb()
  const paths = Array.isArray(input.paths) ? input.paths.filter((entry) => typeof entry === 'string' && entry.trim()) : []
  if (paths.length === 0) {throw new RagError('invalid_input', 'At least one file or directory path is required')}
  const collection = requireCollection(database, input.collectionId)

  const files: string[] = []
  const errors: IngestPathError[] = []
  for (const target of paths) {
    try {
      await walkSupportedFiles(target, files)
    } catch (error) {
      errors.push({ path: target, message: messageOf(error), code: codeOf(error) })
    }
  }

  const documents: IngestResult[] = []
  for (const file of files) {
    try {
      const data = await readFile(file)
      documents.push(
        await ingestFile(
          {
            collectionId: collection.id,
            fileName: path.basename(file),
            data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
          },
          database
        )
      )
    } catch (error) {
      errors.push({ path: file, message: messageOf(error), code: codeOf(error) })
    }
  }
  return { documents, errors }
}
