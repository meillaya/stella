/**
 * DeepSeek remote ingestion.
 *
 * - URLs: `POST /v1/tools/fetch` returns Markdown (1,000 requests for $0.75).
 *   Without an API key we fall back to a local `fetch` + HTML→Markdown strip.
 * - PDF/DOC/DOCX/PPT/PPTX/images: `POST /v1/tools/ocr` (multipart,
 *   `purpose=text_recognition`) returns text per page (1,000 pages for $0.225).
 *   There is deliberately no local PDF parser.
 *
 * Error statuses are mapped to `RagError` codes with actionable messages:
 * 402 insufficient balance, 408/504 timeout, 413 too large, 429 concurrency/QPS,
 * 5xx service errors.
 */
import { config } from '../config.ts'
import { RagError } from '../rag/contract.ts'

export type RemoteConfig = {
  apiKey: string | null
  baseUrl: string
  fetchImpl: typeof fetch
}

export const resolveRemoteConfig = (overrides?: {
  apiKey?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}): RemoteConfig => ({
  apiKey: overrides?.apiKey?.trim() || config.apiKey,
  baseUrl: (overrides?.baseUrl ?? config.deepseekBaseUrl).replace(/\/+$/, ''),
  fetchImpl: overrides?.fetchImpl ?? fetch,
})

export type FetchedUrl = {
  title: string
  markdown: string
}

export type OcrPage = {
  index: number
  text: string
  finishReason: string
}

export type OcrResult = {
  id: string | null
  purpose: string
  pageCount: number
  pages: OcrPage[]
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null
}

const FETCH_TIMEOUT_MS = 30_000
const OCR_TIMEOUT_MS = 180_000
const LOCAL_FETCH_TIMEOUT_MS = 20_000
const MAX_LOCAL_BYTES = 5 * 1024 * 1024

type ErrorBody = { error?: { message?: unknown; code?: unknown; type?: unknown } }

const errorMessageFrom = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object') {return null}
  const error = (payload as ErrorBody).error
  if (!error || typeof error !== 'object') {return null}
  const message = error.message
  return typeof message === 'string' && message.trim() ? message.trim() : null
}

/** Map an HTTP status from the Fetch/OCR APIs to a typed, actionable error. */
export const remoteErrorFromStatus = (
  status: number,
  payload: unknown,
  action: 'fetch' | 'ocr'
): RagError => {
  const upstream = errorMessageFrom(payload)
  const suffix = upstream ? `: ${upstream}` : ''
  const label = action === 'ocr' ? 'DeepSeek OCR' : 'DeepSeek Fetch'
  if (status === 400) {return new RagError('invalid_input', `${label} rejected the request${suffix}`)}
  if (status === 401 || status === 403) {
    return new RagError('upstream_error', `${label} authentication failed — check DEEPSEEK_API_KEY${suffix}`)
  }
  if (status === 402) {
    return new RagError(
      'upstream_error',
      `${label} needs a positive account balance. Top up the DeepSeek account and retry${suffix}`
    )
  }
  if (status === 404) {
    return new RagError(
      'upstream_error',
      action === 'fetch'
        ? 'The Fetch API could not retrieve usable page content for this URL (404). Check the URL or site policy.'
        : `${label} endpoint was not found (404)${suffix}`
    )
  }
  if (status === 408) {
    return new RagError('upstream_error', `${label} timed out while reading the request (408). Try a smaller document or retry.`)
  }
  if (status === 413) {
    return new RagError('too_large', `${label} rejected the file as too large (413). Maximum is 100 MiB / 1,000 pages.`)
  }
  if (status === 429) {
    return new RagError(
      'upstream_error',
      action === 'ocr'
        ? 'DeepSeek OCR has 15 concurrent recognitions per account (429). Wait for a running job to finish and retry.'
        : 'DeepSeek Fetch QPS limit exceeded (429). Retry in a moment.'
    )
  }
  if (status === 503) {
    return new RagError('upstream_error', `${label} service is busy (503). Retry later.`)
  }
  if (status === 504) {
    return new RagError('upstream_error', `${label} did not finish in time (504). Try a smaller document.`)
  }
  if (status >= 500) {
    return new RagError('upstream_error', `${label} had an internal error (${status}). Retry later${suffix}`)
  }
  return new RagError('upstream_error', `${label} request failed (${status})${suffix}`)
}

const parseJsonBody = (raw: string): unknown => {
  const trimmed = raw.trim()
  if (!trimmed) {return null}
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

const postJson = async (
  remote: RemoteConfig,
  pathname: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  action: 'fetch' | 'ocr'
): Promise<unknown> => {
  if (!remote.apiKey) {throw new RagError('no_api_key', 'DEEPSEEK_API_KEY is not configured')}
  const url = `${remote.baseUrl}${pathname}`
  let response: Response
  try {
    response = await remote.fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${remote.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/timeout|aborted/i.test(message)) {
      throw new RagError('upstream_error', `DeepSeek Fetch timed out after ${Math.round(timeoutMs / 1000)}s. Retry.`)
    }
    throw new RagError('upstream_error', `Could not reach ${url}: ${message}`)
  }

  const raw = await response.text()
  const payload = parseJsonBody(raw)
  if (!response.ok) {throw remoteErrorFromStatus(response.status, payload, action)}
  return payload
}

/** Fetch a URL as Markdown through the DeepSeek Fetch API. */
export const remoteFetchMarkdown = async (remote: RemoteConfig, url: string): Promise<FetchedUrl> => {
  const payload = await postJson(remote, '/v1/tools/fetch', { url }, FETCH_TIMEOUT_MS, 'fetch')
  if (!payload || typeof payload !== 'object') {
    throw new RagError('upstream_error', 'DeepSeek Fetch returned an empty response')
  }
  const record = payload as { title?: unknown; content?: unknown }
  const markdown = typeof record.content === 'string' ? record.content : ''
  if (!markdown.trim()) {
    throw new RagError('upstream_error', 'DeepSeek Fetch returned no extractable Markdown content for this URL')
  }
  return {
    title: typeof record.title === 'string' ? record.title.trim() : '',
    markdown,
  }
}

const mapOcrFailureMessage = (message: string): RagError => {
  if (/password-protected/i.test(message)) {
    return new RagError('invalid_input', 'The file is password-protected. Remove the password and try again.')
  }
  if (/more than 1000 pages/i.test(message)) {
    return new RagError('too_large', 'The document has more than 1,000 pages; split it and try again.')
  }
  if (/file is too large/i.test(message)) {
    return new RagError('too_large', 'The file is larger than the 100 MiB OCR limit.')
  }
  if (/did not finish|timed out|timeout/i.test(message)) {
    return new RagError('upstream_error', 'DeepSeek OCR did not finish in time. Try a smaller document.')
  }
  if (/could not be parsed|format is not supported|could not be decoded|invalid/i.test(message)) {
    return new RagError('invalid_input', `DeepSeek OCR could not process the file: ${message}`)
  }
  return new RagError('upstream_error', `DeepSeek OCR failed: ${message}`)
}

const OCR_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}

export const ocrMimeType = (fileName: string, fallback?: string): string => {
  if (fallback && fallback.includes('/')) {return fallback.split(';')[0] as string}
  const extension = /\.([^.]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? ''
  return OCR_MIME[extension] ?? 'application/octet-stream'
}

/**
 * Recognize a PDF/Office/image file through the DeepSeek OCR API.
 * `purpose=text_recognition` lets Word/PowerPoint files without images return
 * their text directly.
 */
export const remoteOcr = async (
  remote: RemoteConfig,
  input: { fileName: string; mimeType?: string; data: Uint8Array }
): Promise<OcrResult> => {
  if (!remote.apiKey) {
    throw new RagError(
      'no_api_key',
      'PDF/Office/image ingestion needs DEEPSEEK_API_KEY for the DeepSeek OCR API. Add it to .env.local and retry.'
    )
  }
  const url = `${remote.baseUrl}/v1/tools/ocr`
  const form = new FormData()
  form.append('purpose', 'text_recognition')
  const blob = new Blob([input.data], { type: ocrMimeType(input.fileName, input.mimeType) })
  form.append('file', blob, input.fileName)

  let response: Response
  try {
    response = await remote.fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${remote.apiKey}`, accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/timeout|aborted/i.test(message)) {
      throw new RagError('upstream_error', 'DeepSeek OCR timed out after 180s. Try a smaller document.')
    }
    throw new RagError('upstream_error', `Could not reach ${url}: ${message}`)
  }

  const raw = await response.text()
  const payload = parseJsonBody(raw)
  if (!response.ok) {throw remoteErrorFromStatus(response.status, payload, 'ocr')}
  if (!payload || typeof payload !== 'object') {
    throw new RagError('upstream_error', 'DeepSeek OCR returned an unreadable response')
  }

  const record = payload as {
    id?: unknown
    purpose?: unknown
    page_count?: unknown
    pages?: unknown
    usage?: { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown }
    error?: { message?: unknown }
  }
  if (record.error) {
    const message = typeof record.error.message === 'string' ? record.error.message : 'unknown OCR error'
    throw mapOcrFailureMessage(message)
  }

  const pages = Array.isArray(record.pages) ? record.pages : []
  const mappedPages: OcrPage[] = pages.map((page, index) => {
    const entry = (page ?? {}) as { index?: unknown; text?: unknown; finish_reason?: unknown }
    return {
      index: typeof entry.index === 'number' ? entry.index : index,
      text: typeof entry.text === 'string' ? entry.text : '',
      finishReason: typeof entry.finish_reason === 'string' ? entry.finish_reason : 'stop',
    }
  })
  if (mappedPages.length === 0) {
    throw new RagError('upstream_error', 'DeepSeek OCR returned no pages')
  }
  const usage = record.usage
  return {
    id: typeof record.id === 'string' ? record.id : null,
    purpose: typeof record.purpose === 'string' ? record.purpose : 'text_recognition',
    pageCount: typeof record.page_count === 'number' ? record.page_count : mappedPages.length,
    pages: mappedPages,
    usage: usage
      ? {
          inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
          outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
          totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : 0,
        }
      : null,
  }
}

const assertHttpUrl = (value: string): URL => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new RagError('invalid_input', `Invalid URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RagError('invalid_input', 'Only http/https URLs can be ingested')
  }
  if (url.username || url.password) {
    throw new RagError('invalid_input', 'URLs with embedded credentials are not allowed')
  }
  return url
}

/**
 * Local fallback used without an API key: fetch the page and strip HTML to
 * Markdown. PDFs and other binary content are rejected with a clear message.
 */
export const localFetchMarkdown = async (
  fetchImpl: typeof fetch,
  rawUrl: string
): Promise<FetchedUrl> => {
  const url = assertHttpUrl(rawUrl)
  let response: Response
  try {
    response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9,*/*;q=0.5',
        'user-agent': 'Stella/0.1 (local RAG ingestion)',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(LOCAL_FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/timeout|aborted/i.test(message)) {
      throw new RagError('upstream_error', `Fetching ${url.toString()} timed out. Retry or set DEEPSEEK_API_KEY.`)
    }
    throw new RagError('upstream_error', `Could not fetch ${url.toString()}: ${message}`)
  }

  if (!response.ok) {
    throw new RagError('upstream_error', `Fetching ${url.toString()} failed with HTTP ${response.status}`)
  }
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  const contentLength = Number(response.headers.get('content-length') ?? '0')
  if (contentLength > MAX_LOCAL_BYTES) {
    throw new RagError('too_large', `Page is larger than ${MAX_LOCAL_BYTES / (1024 * 1024)} MiB; set DEEPSEEK_API_KEY for server-side extraction.`)
  }
  const rawBody = await response.text()
  if (rawBody.length > MAX_LOCAL_BYTES) {
    throw new RagError('too_large', 'Page is too large to ingest locally')
  }
  const htmlTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(rawBody)?.[1]?.trim() ?? ''

  if (contentType.includes('html') || /^\s*<(!doctype|html)/i.test(rawBody)) {
    // Reuse the HTML extractor for the title/metadata-aware path.
    const { extractHtmlDocument } = await import('./local.ts')
    const extracted = extractHtmlDocument(rawBody)
    return {
      title: extracted.title ?? htmlTitle,
      markdown: extracted.text,
    }
  }
  if (contentType.includes('text/plain') || contentType.includes('markdown') || contentType === '') {
    return { title: htmlTitle, markdown: rawBody.trim() }
  }
  throw new RagError(
    'unsupported_type',
    `Content type "${contentType || 'unknown'}" cannot be converted to text locally. Set DEEPSEEK_API_KEY to use the DeepSeek Fetch API.`
  )
}
