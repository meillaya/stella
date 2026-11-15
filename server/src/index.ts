import fastifyMultipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerApi } from './api/router.ts'
import { config, isLoopback, keyStatus } from './config.ts'
import { getDb } from './db/index.ts'
import { registerGateway } from './gateway/index.ts'
import { log } from './logger.ts'

const isApiPath = (url: string): boolean =>
  url.startsWith('/api') ||
  url.startsWith('/anthropic') ||
  url.startsWith('/v1') ||
  url === '/models'

export const buildServer = async (): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: false,
    bodyLimit: config.bodyLimitBytes,
    trustProxy: false,
  })

  await app.register(fastifyMultipart, {
    limits: { fileSize: 100 * 1024 * 1024, files: 4, fields: 20 },
  })

  // Loopback is the default, trusted deployment. If Stella is exposed on a
  // network interface, require an explicit access token.
  app.addHook('onRequest', async (request, reply) => {
    if (!config.accessToken || isLoopback(request.ip)) {return}
    const header = request.headers.authorization
    const token =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    if (token !== config.accessToken) {
      await reply.code(401).send({ error: { message: 'Unauthorized' } })
    }
  })

  getDb()

  registerApi(app)
  registerGateway(app)

  if (existsSync(config.distDir)) {
    await app.register(fastifyStatic, {
      root: config.distDir,
      prefix: '/',
      wildcard: false,
      index: ['index.html'],
    })
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !isApiPath(request.url)) {
        return reply.type('text/html').sendFile('index.html')
      }
      return reply.code(404).send({ error: { message: 'Not found' } })
    })
  } else {
    app.get('/', async () => ({
      name: config.name,
      version: config.version,
      hint: 'No dist/ build found. Run `pnpm build`, or use `pnpm dev` for the dev server.',
      hasKey: keyStatus().configured,
    }))
  }

  return app
}

export const startServer = async (): Promise<FastifyInstance> => {
  const app = await buildServer()
  await app.listen({ host: config.host, port: config.port })
  log.info(`listening on http://${config.host}:${config.port}`)
  return app
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1] as string)).href

if (isMain) {
  startServer().catch((error: unknown) => {
    log.error('failed to start Stella', error)
    process.exit(1)
  })
}
