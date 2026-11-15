import type { Profile, RetrievedChunk } from '../../../shared/types.ts'
import { log } from '../logger.ts'
import type { Db } from '../db/index.ts'
import type { RetrieveFn } from './options.ts'
import { contentText } from './trace-store.ts'

/**
 * RAG context injection for the chat gateway.
 *
 * Only the final user message is touched, and only by appending one extra text
 * block. Everything before it (system prompt, earlier turns, assistant
 * thinking/signatures) stays byte-identical, so DeepSeek's prefix cache and
 * thinking signatures keep working. If retrieval fails or is disabled we send
 * the request unmodified and record the failure — the chat must never fail
 * because retrieval did.
 */

export type InjectionInput = {
  body: Record<string, unknown>
  profile: Profile | null
  db: Db
  retrieve: RetrieveFn | null
}

export type InjectionResult = {
  /** True when the active profile has retrieval enabled (attempted or not). */
  retrievalEnabled: boolean
  /** Request body with the context block appended; null when untouched. */
  mutatedBody: Record<string, unknown> | null
  /** Exact injected block (also stored in traces.injected_context). */
  injectedContext: string | null
  sources: RetrievedChunk[]
  retrievalError: string | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const contextInstruction = (template: string): string => {
  if (template === 'rag-v2') {
    return 'Answer only from these retrieved sources. Cite each factual sentence with its bracket number, e.g. [1]. If the sources do not contain the answer, say so instead of guessing.'
  }
  return 'Use these retrieved sources when they are relevant, and cite them by bracket number, e.g. [1]. If the sources do not contain the answer, say so.'
}

/** Numbered source block appended as one extra text block on the final user message. */
export const formatSourceContext = (chunks: RetrievedChunk[], template = 'rag-v1'): string => {
  const lines: string[] = ['<retrieved_sources>']
  chunks.forEach((chunk, index) => {
    const heading = chunk.heading ? ` — ${chunk.heading}` : ''
    const page = chunk.page !== null && chunk.page !== undefined ? ` (p. ${chunk.page})` : ''
    lines.push(`[${index + 1}] ${chunk.title}${heading}${page}`)
    lines.push((chunk.text ?? chunk.snippet ?? '').trim())
    lines.push('')
  })
  lines.push('</retrieved_sources>')
  lines.push('')
  lines.push(contextInstruction(template))
  return lines.join('\n')
}

const noInjection = (retrievalEnabled: boolean, error: string | null = null): InjectionResult => ({
  retrievalEnabled,
  mutatedBody: null,
  injectedContext: null,
  sources: [],
  retrievalError: error,
})

export const injectRetrieval = async (input: InjectionInput): Promise<InjectionResult> => {
  const spec = input.profile?.spec.retrieval
  const retrievalEnabled = spec?.enabled === true
  if (!input.profile || !spec || !retrievalEnabled) {return noInjection(retrievalEnabled)}
  if (!spec.collection) {return noInjection(true)}
  if (!input.retrieve) {return noInjection(true, 'retrieval implementation unavailable')}

  const messages = input.body.messages
  if (!Array.isArray(messages) || messages.length === 0) {return noInjection(true)}
  const lastIndex = messages.length - 1
  const last = messages[lastIndex]
  if (!isRecord(last) || last.role !== 'user') {return noInjection(true)}

  const query = contentText(last.content).trim()
  if (!query) {return noInjection(true)}

  let chunks: RetrievedChunk[]
  try {
    const result = await input.retrieve({
      collectionId: spec.collection,
      query,
      k: spec.k,
      candidates: spec.candidates,
      rerank: spec.rerank,
      contextBudgetTokens: spec.contextBudgetTokens,
      parentExpansion: spec.parentExpansion,
      db: input.db,
    })
    chunks = result.chunks
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('gateway: retrieval failed; continuing without context', { message })
    return noInjection(true, message)
  }
  if (!Array.isArray(chunks) || chunks.length === 0) {return noInjection(true)}

  const block = formatSourceContext(chunks, input.profile.spec.prompt.template)
  const lastCopy: Record<string, unknown> = { ...last }
  if (typeof last.content === 'string') {
    // Append as a distinct text block so upstream context and citations stay
    // separable; everything before this message stays byte-identical.
    lastCopy.content = [
      { type: 'text', text: last.content },
      { type: 'text', text: block },
    ]
  } else if (Array.isArray(last.content)) {
    lastCopy.content = [...last.content, { type: 'text', text: block }]
  } else {
    lastCopy.content = [{ type: 'text', text: block }]
  }
  const mutatedBody: Record<string, unknown> = {
    ...input.body,
    messages: [...messages.slice(0, lastIndex), lastCopy],
  }

  return {
    retrievalEnabled: true,
    mutatedBody,
    injectedContext: block,
    sources: chunks,
    retrievalError: null,
  }
}
