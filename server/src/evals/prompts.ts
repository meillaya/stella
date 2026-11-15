/**
 * Prompt construction for eval runs.
 *
 * Retrieval context is appended to the **final user message** only, which
 * mirrors the gateway's cache-safe injection rule (the visible history is
 * re-sent every turn; mutating earlier assistant messages breaks prefix caching
 * and thinking signatures).
 */

import { estimateTokens } from '../../../shared/pricing.ts'
import type { DatasetCase, PromptSpec, RetrievedChunk } from '../../../shared/types.ts'

export const BASE_SYSTEM_PROMPT =
  'You are Stella, a helpful assistant. Answer the user question accurately and concisely.'

const TEMPLATE_INSTRUCTIONS: Record<PromptSpec['template'], string> = {
  plain: '',
  'rag-v1':
    'Use the numbered sources below when they help. When you rely on a source, cite its number in brackets, e.g. [1].',
  'rag-v2':
    'Answer using only the numbered sources below. Use all relevant sources and answer every part of the question. Cite each factual claim with the source number in brackets, e.g. [1]. Include exact figures, identifiers, plan names and limits as written in the sources, and name the specific product, plan or error code when the sources provide one. When sources conflict, prefer the one with the latest effective date or version. If the sources do not contain the answer, say you do not know instead of guessing.',
}

export type PackedSource = { source: RetrievedChunk; text: string }

/**
 * Keep whole chunks until the token budget is spent. The retriever already
 * packs to a budget; this is a defensive second cap for prompts assembled from
 * an injected stub retriever.
 */
export const packContext = (chunks: RetrievedChunk[], budgetTokens: number): PackedSource[] => {
  if (chunks.length === 0) {
    return []
  }
  const unlimited = !Number.isFinite(budgetTokens) || budgetTokens <= 0
  const packed: PackedSource[] = []
  let used = 0
  for (const chunk of chunks) {
    const cost = estimateTokens(chunk.text)
    if (!unlimited && packed.length > 0 && used + cost > budgetTokens) {
      break
    }
    const remaining = unlimited ? chunk.text.length : Math.max(0, budgetTokens - used)
    const text = unlimited
      ? chunk.text
      : chunk.text.length <= remaining * 3
        ? chunk.text
        : chunk.text.slice(0, Math.max(0, Math.floor(remaining * 3)))
    packed.push({ source: chunk, text })
    used += estimateTokens(text)
  }
  return packed
}

export const formatSourceBlock = (packed: PackedSource[]): string => {
  if (packed.length === 0) {
    return ''
  }
  const lines = packed.map(({ source, text }, index) => {
    const heading = source.heading ? ` — ${source.heading}` : ''
    return `[${index + 1}] ${source.title}${heading}\n${text}`
  })
  return `Sources:\n\n${lines.join('\n\n')}`
}

export type PromptMessages = {
  system: string
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[]
  /** The injected retrieval context, or null when retrieval is off/empty. */
  injectedContext: string | null
}

export type BuildPromptInput = {
  case: DatasetCase
  prompt: PromptSpec
  chunks: RetrievedChunk[]
  contextBudgetTokens: number
  retrievalEnabled: boolean
}

/**
 * Build the provider messages for one eval case. The final user message gets
 * an instruction + numbered sources block when retrieval returned chunks.
 */
export const buildPromptMessages = (input: BuildPromptInput): PromptMessages => {
  const caseSystem = input.case.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')
  const system =
    caseSystem.length > 0 ? `${BASE_SYSTEM_PROMPT}\n\n${caseSystem}` : BASE_SYSTEM_PROMPT
  const conversation = input.case.messages
    .filter((message) => message.role === 'user')
    .map((message) => ({ role: 'user' as const, content: message.content }))
  const packed = input.retrievalEnabled ? packContext(input.chunks, input.contextBudgetTokens) : []
  const injectedContext = packed.length > 0 ? formatSourceBlock(packed) : null
  const messages = [...conversation]
  if (injectedContext) {
    const instruction = TEMPLATE_INSTRUCTIONS[input.prompt.template]
    const lastIndex = messages.length - 1
    const last = messages[lastIndex]
    if (last) {
      const prefix = instruction.length > 0 ? `${instruction}\n\n` : ''
      messages[lastIndex] = {
        role: 'user',
        content: `${prefix}${injectedContext}\n\nQuestion: ${last.content}`,
      }
    }
  }
  return { system, messages, injectedContext }
}

export const questionOf = (input: DatasetCase): string => {
  const userMessages = input.messages.filter((message) => message.role === 'user')
  const last = userMessages[userMessages.length - 1]
  return last ? last.content : ''
}
