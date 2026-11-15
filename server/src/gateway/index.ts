import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * Gateway placeholder. The real proxy, RAG injection and trace capture live
 * here and are implemented by the gateway workstream. Registered early so the
 * server boots and the chat client gets a protocol-shaped error instead of a
 * generic 404.
 */
export const registerGateway = (app: FastifyInstance): void => {
  const notImplemented = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.code(501).send({
      type: 'error',
      error: {
        type: 'not_implemented',
        message: 'Stella gateway is not wired up yet.',
      },
    })

  app.all('/models', notImplemented)
  app.all('/anthropic/*', notImplemented)
  app.all('/v1/tools/*', notImplemented)
}
