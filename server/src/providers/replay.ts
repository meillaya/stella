import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.ts'
import {
  ReplayMissError,
  canonicalChatRequest,
  canonicalJsonSchemaCall,
  chatRequestKey,
  consumeChat,
  jsonSchemaCallKey,
  type CanonicalChatRequest,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type ChatStreamEvent,
  type JsonSchemaCall,
  type JsonSchemaCassette,
  type ReplayCassette,
} from './contracts.ts'
import { createLiveProvider, type LiveProviderOptions } from './live.ts'

/**
 * Replay provider: serves recorded chat turns from JSON cassettes so evals and
 * demos run with no API key and no network. The cassette key is the sha256 of
 * the canonical request (see `contracts.canonicalChatRequest`), so a cassette
 * only matches when every request field that reaches the model matches.
 *
 * A missing cassette throws `ReplayMissError` (`code === 'replay_miss'`) — it
 * never silently falls back to the network.
 */

export const DEFAULT_CASSETTE_DIR = path.join(config.dataDir, 'cassettes')

export const cassetteDir = (dir?: string): string => path.resolve(dir ?? DEFAULT_CASSETTE_DIR)

export const cassetteFileName = (request: ChatRequest): string => `${chatRequestKey(request)}.json`

export const cassettePath = (request: ChatRequest, dir?: string): string =>
  path.join(cassetteDir(dir), cassetteFileName(request))

export const jsonSchemaCassetteFileName = (call: JsonSchemaCall): string =>
  `${jsonSchemaCallKey(call)}.json`

export const jsonSchemaCassettePath = (call: JsonSchemaCall, dir?: string): string =>
  path.join(cassetteDir(dir), 'json-schema', jsonSchemaCassetteFileName(call))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isReplayCassette = (value: unknown): value is ReplayCassette =>
  isRecord(value) &&
  value.version === 1 &&
  isRecord(value.result) &&
  Array.isArray(value.events) &&
  isRecord(value.request)

const isJsonSchemaCassette = (value: unknown): value is JsonSchemaCassette =>
  isRecord(value) && value.version === 1 && 'result' in value && isRecord(value.request)

export type ReplayProviderOptions = {
  /** Defaults to `$STELLA_DATA_DIR/cassettes`. */
  cassetteDir?: string
  /** In-memory cassettes (tests, tools): key is the request hash. */
  cassettes?: Record<string, ReplayCassette>
  /**
   * Explicit cassette key override (tests/stubs). Defaults to the request hash.
   * In-memory maps and on-disk file names both use this key.
   */
  cassetteKey?: string
}

const cassettePathForKey = (key: string, dir?: string): string =>
  path.join(cassetteDir(dir), `${key}.json`)

const loadChatCassette = async (
  request: ChatRequest,
  options: ReplayProviderOptions
): Promise<ReplayCassette> => {
  const key = options.cassetteKey ?? chatRequestKey(request)
  const inMemory = options.cassettes?.[key]
  if (inMemory) {return inMemory}
  const file = cassettePathForKey(key, options.cassetteDir)
  if (!existsSync(file)) {throw new ReplayMissError(file, `Key ${key}.`)}
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    throw new ReplayMissError(
      file,
      `The file exists but is not valid cassette JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!isReplayCassette(parsed)) {
    throw new ReplayMissError(file, 'The file exists but is not a version-1 replay cassette.')
  }
  return parsed
}

export const readCassette = async (
  request: ChatRequest,
  options: ReplayProviderOptions = {}
): Promise<ReplayCassette | null> => {
  try {
    return await loadChatCassette(request, options)
  } catch (error) {
    if (error instanceof ReplayMissError) {return null}
    throw error
  }
}

export const replayGenerator = async function* (
  request: ChatRequest,
  signal: AbortSignal | undefined,
  options: ReplayProviderOptions
): AsyncGenerator<ChatStreamEvent, ChatResult, void> {
  const cassette = await loadChatCassette(request, options)
  for (const event of cassette.events) {
    if (signal?.aborted) {
      throw new ReplayMissError(cassettePath(request, options.cassetteDir), 'Replay aborted.')
    }
    yield event
  }
  if (signal?.aborted) {
    throw new ReplayMissError(cassettePath(request, options.cassetteDir), 'Replay aborted.')
  }
  return cassette.result
}

export const createReplayProvider = (options: ReplayProviderOptions = {}): ChatProvider => ({
  id: 'replay',
  streamChat: (request, signal) => replayGenerator(request, signal, options),
  chatOnce: (request, signal) => consumeChat(replayGenerator(request, signal, options)),
})

export const replayProvider = createReplayProvider()

/* ------------------------------ recording ------------------------------ */

export type WriteCassetteOptions = ReplayProviderOptions & { createdAt?: number }

export const writeCassette = async (
  request: ChatRequest,
  result: ChatResult,
  events: ChatStreamEvent[],
  options: WriteCassetteOptions = {}
): Promise<string> => {
  const file = cassettePath(request, options.cassetteDir)
  const request2: CanonicalChatRequest = canonicalChatRequest(request)
  const cassette: ReplayCassette = {
    version: 1,
    createdAt: options.createdAt ?? Date.now(),
    request: request2,
    events,
    result,
  }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(cassette, null, 2)}\n`, 'utf8')
  if (options.cassettes) {options.cassettes[chatRequestKey(request)] = cassette}
  return file
}

export type RecordChatOptions = {
  dir?: string
  cassettes?: Record<string, ReplayCassette>
  /** Defaults to the live provider; tests may inject a different transport. */
  provider?: ChatProvider
  liveOptions?: LiveProviderOptions
  signal?: AbortSignal
}

/** Run one live turn and write a replay cassette for it. Returns the cassette path. */
export const recordChat = async (
  request: ChatRequest,
  options: RecordChatOptions = {}
): Promise<{ result: ChatResult; cassettePath: string }> => {
  const provider = options.provider ?? createLiveProvider(options.liveOptions)
  const events: ChatStreamEvent[] = []
  const generator = provider.streamChat(request, options.signal)
  let result: ChatResult | null = null
  for (;;) {
    const next = await generator.next()
    if (next.done) {
      result = next.value
      break
    }
    events.push(next.value)
  }
  const file = await writeCassette(request, result, events, {
    cassetteDir: options.dir,
    cassettes: options.cassettes,
  })
  return { result, cassettePath: file }
}

export const readJsonSchemaCassetteResult = async (
  call: JsonSchemaCall,
  options: ReplayProviderOptions = {}
): Promise<unknown> => {
  const file = jsonSchemaCassettePath(call, options.cassetteDir)
  if (!existsSync(file)) {throw new ReplayMissError(file, `Key ${jsonSchemaCallKey(call)}.`)}
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    throw new ReplayMissError(
      file,
      `The file exists but is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!isJsonSchemaCassette(parsed)) {
    throw new ReplayMissError(file, 'The file exists but is not a version-1 JSON-schema cassette.')
  }
  return parsed.result
}

export type WriteJsonSchemaCassetteOptions = ReplayProviderOptions & { createdAt?: number }

export const writeJsonSchemaCassette = async (
  call: JsonSchemaCall,
  result: unknown,
  options: WriteJsonSchemaCassetteOptions = {}
): Promise<string> => {
  const file = jsonSchemaCassettePath(call, options.cassetteDir)
  const cassette: JsonSchemaCassette = {
    version: 1,
    createdAt: options.createdAt ?? Date.now(),
    request: canonicalJsonSchemaCall(call),
    result,
  }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(cassette, null, 2)}\n`, 'utf8')
  return file
}
