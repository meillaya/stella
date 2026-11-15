import type { FastifyInstance } from 'fastify'
import { config, keyStatus } from '../config.ts'
import { getSetting } from '../db/index.ts'

export const registerApi = (app: FastifyInstance): void => {
  app.get('/api/health', async () => {
    getSetting('active_profile_id')
    return {
      ok: true,
      name: config.name,
      version: config.version,
      mode: config.mode,
      hasKey: keyStatus().configured,
      key: keyStatus(),
      dataDir: config.dataDir,
      db: config.dbPath,
    }
  })
}
