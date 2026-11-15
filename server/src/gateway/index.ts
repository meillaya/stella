import type { FastifyInstance } from 'fastify'
import { registerMessagesRoutes } from './messages.ts'
import { resolveGatewayOptions, type GatewayOptions } from './options.ts'
import { registerProxyRoutes } from './proxy.ts'

/**
 * Stella gateway: a local, same-origin proxy in front of the DeepSeek API that
 * records every chat turn, injects retrieval context and hands the forked chat
 * client its provenance/cost metadata through the SSE usage object.
 *
 * Routes (not under /api):
 * - `GET /models`
 * - `POST /anthropic/v1/messages` (streaming proxy + trace capture)
 * - `POST|GET /anthropic/v1/files`, `GET|DELETE /anthropic/v1/files/:id`
 * - `POST /v1/tools/asr`, `POST /v1/tools/tts`
 *
 * Keys: the server key (`DEEPSEEK_API_KEY`) is used when configured; otherwise
 * the client's `x-api-key` / Bearer token is forwarded (BYOK). Keys are never
 * logged, stored or echoed back.
 */
export const registerGateway = (
  app: FastifyInstance,
  gatewayOptions: GatewayOptions = {}
): void => {
  const options = resolveGatewayOptions(gatewayOptions)
  registerProxyRoutes(app, options)
  registerMessagesRoutes(app, options)
}

export type { GatewayOptions } from './options.ts'
export { resolveGatewayOptions } from './options.ts'
