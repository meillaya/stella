import { Ajv, type ValidateFunction } from 'ajv'
import { config } from '../config.ts'
import {
  ProviderError,
  canonicalJsonSchemaCall,
  jsonSchemaCallKey,
  type ChatMessage,
  type JsonSchemaCall,
} from './contracts.ts'
import { resolveApiKey, resolveBaseUrl } from './live.ts'
import {
  jsonSchemaCassettePath,
  readJsonSchemaCassetteResult,
  writeJsonSchemaCassette,
  type WriteJsonSchemaCassetteOptions,
} from './replay.ts'

/**
 * Responses-API JSON-schema caller used by the eval judge and the optional
 * reranker.
 *
 * Primary request: `POST ${baseUrl}/responses` with `text.format` JSON schema.
 * If the endpoint answers 400/404/405/422/501, or the response shape is not a
 * Responses payload, or the JSON does not validate, we retry once through
 * Chat Completions `response_format: {type: "json_object"}` with the schema in
 * the prompt. Any other failure (auth, rate limit, 5xx) is thrown directly.
 *
 * In replay mode (`STELLA_MODE=replay` or `options.mode`) recorded results are
 * read from `${dataDir}/cassettes/json-schema/<sha256>.json`; a missing cassette
 * throws `ReplayMissError` and never touches the network.
 */

export type CallJsonSchemaOptions = {
  signal?: AbortSignal
  /** Defaults to `config.mode`. */
  mode?: 'live' | 'replay'
  baseUrl?: string
  apiKey?: string | null
  cassettesDir?: string
  fetchImpl?: typeof fetch
}

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true })
const validators = new Map<string, ValidateFunction>()

const validatorFor = (schema: Record<string, unknown>): ValidateFunction => {
  const key = JSON.stringify(schema)
  const cached = validators.get(key)
  if (cached) {return cached}
  let validator: ValidateFunction
  try {
    validator = ajv.compile(schema)
  } catch (error) {
    throw new ProviderError(
      'protocol_error',
      `Invalid JSON schema supplied to callJsonSchema: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  validators.set(key, validator)
  return validator
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const messageFromErrorBody = (raw: string, status: number): string => {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string') {
      return parsed.error.message
    }
    if (isRecord(parsed) && typeof parsed.message === 'string') {return parsed.message}
  } catch {
    // Non-JSON error body below.
  }
  return raw.slice(0, 500) || `Upstream returned HTTP ${status}`
}

/**
 * Extract the assistant text from a Responses API response object.
 * DeepSeek returns the OpenAI-compatible `output` array; some SDK-shaped
 * gateways also expose `output_text`. Returns null when the shape is foreign.
 */
export const responseTextOf = (payload: unknown): string | null => {
  if (!isRecord(payload)) {return null}
  if (typeof payload.output_text === 'string') {return payload.output_text}
  if (typeof payload.output === 'string') {return payload.output}
  if (!Array.isArray(payload.output)) {return null}
  let text: string | null = null
  for (const item of payload.output) {
    if (!isRecord(item)) {continue}
    if (isRecord(item.content)) {
      // Single content object (not spec, but cheap to accept).
      const part = item.content
      if (typeof part.text === 'string') {text = `${text ?? ''}${part.text}`}
      continue
    }
    if (!Array.isArray(item.content)) {continue}
    for (const part of item.content) {
      if (!isRecord(part)) {continue}
      if (typeof part.text === 'string' && (part.type === 'output_text' || part.type === 'text')) {
        text = `${text ?? ''}${part.text}`
      }
    }
  }
  return text
}

const parseJsonObject = (text: string): unknown => {
  const trimmed = text.trim()
  const unfenced = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    : trimmed
  return JSON.parse(unfenced)
}

const validateResult = (value: unknown, schema: Record<string, unknown>, source: string): unknown => {
  const validate = validatorFor(schema)
  if (validate(value)) {return value}
  const detail = ajv.errorsText(validate.errors, { separator: '; ' })
  throw new ProviderError(
    'protocol_error',
    `${source} response does not match the requested JSON schema: ${detail}`
  )
}

type LiveResult = { value: unknown; source: 'responses' | 'chat' }

const requestLive = async (
  call: JsonSchemaCall,
  options: CallJsonSchemaOptions,
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string
): Promise<LiveResult> => {
  const canonical = canonicalJsonSchemaCall(call)
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  }

  let responsesFailure: string | null = null
  let responsesResponse: Response | null = null
  try {
    responsesResponse = await fetchImpl(`${baseUrl}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: canonical.model,
        instructions: canonical.system,
        input: canonical.input,
        max_output_tokens: canonical.maxTokens,
        temperature: canonical.temperature,
        // Thinking is disabled with `effort: none` so grading stays deterministic.
        reasoning: canonical.thinking ? { effort: 'high' } : { effort: 'none' },
        text: {
          format: {
            type: 'json_schema',
            name: 'result',
            schema: canonical.schema,
            strict: true,
          },
        },
      }),
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal?.aborted) {throw new ProviderError('aborted', 'JSON-schema call aborted.', { cause: error })}
    responsesFailure = error instanceof Error ? error.message : String(error)
    responsesResponse = null
  }

  if (responsesResponse && responsesResponse.ok) {
    const raw = await responsesResponse.text()
    let payload: unknown = null
    try {
      payload = JSON.parse(raw)
    } catch {
      responsesFailure = `responses endpoint returned non-JSON: ${raw.slice(0, 300)}`
    }
    const text = payload === null ? null : responseTextOf(payload)
    if (typeof text === 'string' && text.trim()) {
      try {
        const parsed = parseJsonObject(text)
        return { value: validateResult(parsed, canonical.schema, 'Responses API'), source: 'responses' }
      } catch (error) {
        if (error instanceof ProviderError) {
          responsesFailure = error.message
        } else {
          responsesFailure = `responses JSON was not parseable: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    } else if (responsesFailure === null) {
      responsesFailure = 'responses endpoint returned an unrecognized shape'
    }
  } else if (responsesResponse) {
    const raw = await responsesResponse.text().catch(() => '')
    const message = messageFromErrorBody(raw, responsesResponse.status)
    if (![400, 404, 405, 415, 422, 501].includes(responsesResponse.status)) {
      throw new ProviderError('http_error', `Responses API failed: ${message}`, {
        status: responsesResponse.status,
      })
    }
    responsesFailure = `responses endpoint unavailable (HTTP ${responsesResponse.status}): ${message}`
  }

  // Careful fallback: Chat Completions JSON mode with the schema in the prompt.
  const schemaText = JSON.stringify(canonical.schema)
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        `${canonical.system}\n\n` +
        'Respond with ONE JSON object and nothing else: no markdown fence, no prose, no trailing text. ' +
        `The object must validate against this JSON Schema:\n${schemaText}`,
    },
    { role: 'user', content: canonical.input },
  ]
  let fallbackResponse: Response
  try {
    fallbackResponse = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: canonical.model,
        messages,
        response_format: { type: 'json_object' },
        max_tokens: canonical.maxTokens,
        temperature: canonical.temperature,
        thinking: { type: canonical.thinking ? 'enabled' : 'disabled' },
      }),
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal?.aborted) {throw new ProviderError('aborted', 'JSON-schema call aborted.', { cause: error })}
    throw new ProviderError(
      'http_error',
      `Responses API failed (${responsesFailure}) and the chat fallback was unreachable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
  if (!fallbackResponse.ok) {
    const raw = await fallbackResponse.text().catch(() => '')
    throw new ProviderError(
      'http_error',
      `Responses API failed (${responsesFailure}); chat json_object fallback failed with HTTP ${fallbackResponse.status}: ${messageFromErrorBody(raw, fallbackResponse.status)}`,
      { status: fallbackResponse.status }
    )
  }
  const fallbackPayload: unknown = await fallbackResponse.json().catch(() => null)
  const content =
    isRecord(fallbackPayload) &&
    Array.isArray(fallbackPayload.choices) &&
    isRecord(fallbackPayload.choices[0]) &&
    isRecord(fallbackPayload.choices[0].message) &&
    typeof fallbackPayload.choices[0].message.content === 'string'
      ? fallbackPayload.choices[0].message.content
      : null
  if (!content) {
    throw new ProviderError(
      'protocol_error',
      `Responses API failed (${responsesFailure}); chat fallback returned no message content.`
    )
  }
  let parsed: unknown
  try {
    parsed = parseJsonObject(content)
  } catch (error) {
    throw new ProviderError(
      'protocol_error',
      `Chat fallback was not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  return { value: validateResult(parsed, canonical.schema, 'Chat Completions fallback'), source: 'chat' }
}

/**
 * Call the model with a JSON schema and return the parsed, schema-validated object.
 * Throws {@link ProviderError} on transport/protocol failures and
 * {@link ReplayMissError} in replay mode when no cassette was recorded.
 */
export const callJsonSchema = async <T = unknown>(
  call: JsonSchemaCall,
  options: CallJsonSchemaOptions = {}
): Promise<T> => {
  const mode = options.mode ?? config.mode
  if (mode === 'replay') {
    return (await readJsonSchemaCassetteResult(call, { cassetteDir: options.cassettesDir })) as T
  }
  const apiKey = resolveApiKey(options.apiKey)
  const baseUrl = resolveBaseUrl(options.baseUrl)
  const fetchImpl = options.fetchImpl ?? fetch
  const live = await requestLive(call, options, fetchImpl, baseUrl, apiKey)
  return live.value as T
}

/** Call live and persist the result as a replay cassette (for `stella record`). */
export const recordJsonSchema = async <T = unknown>(
  call: JsonSchemaCall,
  options: CallJsonSchemaOptions & { cassettesDir?: string } = {}
): Promise<{ result: T; cassettePath: string }> => {
  const apiKey = resolveApiKey(options.apiKey)
  const baseUrl = resolveBaseUrl(options.baseUrl)
  const fetchImpl = options.fetchImpl ?? fetch
  const live = await requestLive(call, { ...options, mode: 'live' }, fetchImpl, baseUrl, apiKey)
  const path = await writeJsonSchemaCassette(call, live.value, {
    cassetteDir: options.cassettesDir,
  } satisfies WriteJsonSchemaCassetteOptions)
  return { result: live.value as T, cassettePath: path }
}

export { jsonSchemaCallKey, jsonSchemaCassettePath }

/* ------------------------------ listwise rerank ------------------------------ */

export type RerankDocument = { id: string; text: string }

export type RerankListwiseInput = {
  query: string
  documents: RerankDocument[]
  model?: JsonSchemaCall['model']
  signal?: AbortSignal
  /** Safety cap on candidates sent to the model. Default 60. */
  maxDocuments?: number
  /** Character cap per candidate text. Default 700. */
  maxDocumentChars?: number
  /** Optional transport overrides (tests, alternate gateways). */
  baseUrl?: string
  apiKey?: string | null
  mode?: 'live' | 'replay'
}

const RERANK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    order: { type: 'array', items: { type: 'string' } },
  },
  required: ['order'],
  additionalProperties: false,
}

/**
 * LLM listwise rerank used by RAG (`retrieve({rerank: 'llm'})`).
 * Returns every input id exactly once, most relevant first; ids the model
 * invents are dropped and ids it omits keep their original relative order.
 * Throws on transport/replay failures — callers should fall back to lexical
 * order (the RAG layer does).
 */
export const rerankListwise = async (input: RerankListwiseInput): Promise<string[]> => {
  const documents = input.documents.slice(0, input.maxDocuments ?? 60)
  const allIds = input.documents.map((document) => document.id)
  if (documents.length <= 1) {return allIds}
  const maxChars = input.maxDocumentChars ?? 700
  const listing = documents
    .map((document) => `[${document.id}] ${document.text.replace(/\s+/g, ' ').trim().slice(0, maxChars)}`)
    .join('\n\n')
  const result = await callJsonSchema<{ order?: unknown }>(
    {
      model: input.model,
      system:
        'You are a retrieval reranker. Rank every candidate passage by how well it supports answering the query. ' +
        'Return only JSON of the form {"order": ["s1", "s2", ...]} listing ALL candidate ids, most relevant first.',
      input: `Query:\n${input.query}\n\nCandidates:\n${listing}`,
      schema: RERANK_SCHEMA,
      maxTokens: 1024,
    },
    {
      signal: input.signal,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      mode: input.mode,
    }
  )
  const known = new Set(allIds)
  const ordered: string[] = []
  const seen = new Set<string>()
  const rawOrder = Array.isArray(result.order) ? result.order : []
  for (const id of rawOrder) {
    if (typeof id === 'string' && known.has(id) && !seen.has(id)) {
      seen.add(id)
      ordered.push(id)
    }
  }
  for (const id of allIds) {
    if (!seen.has(id)) {
      seen.add(id)
      ordered.push(id)
    }
  }
  return ordered
}
