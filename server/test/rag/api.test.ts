import assert from 'node:assert/strict'
import { test } from 'node:test'
import fastifyMultipart from '@fastify/multipart'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Collection, DocumentRecord, RetrievedChunk } from '../../../shared/types.ts'
import { registerCollectionsApi } from '../../src/api/collections.ts'
import { makeDb, readFixture } from './helpers.ts'

type TestApp = {
  app: FastifyInstance
  close: () => Promise<void>
}

const buildApp = async (): Promise<TestApp> => {
  const db = makeDb()
  const app = Fastify({ logger: false })
  await app.register(fastifyMultipart, {
    limits: { fileSize: 100 * 1024 * 1024, files: 4, fields: 20 },
  })
  registerCollectionsApi(app, { db })
  await app.ready()
  return {
    app,
    close: async () => {
      await app.close()
      db.close()
    },
  }
}

const multipartFile = (
  fileName: string,
  content: string,
  contentType = 'text/markdown'
): { body: Buffer; boundary: string } => {
  const boundary = '----StellaRagTestBoundary'
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`
    ),
    Buffer.from(content, 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { body, boundary }
}

test('collections API: create, upload, list, search, delete and error shape', async () => {
  const { app, close } = await buildApp()
  try {
    const empty = await app.inject({ method: 'GET', url: '/api/collections' })
    assert.equal(empty.statusCode, 200)
    assert.deepEqual(empty.json(), { items: [] })

    const created = await app.inject({
      method: 'POST',
      url: '/api/collections',
      payload: { name: 'API Test', description: 'collections api test' },
    })
    assert.equal(created.statusCode, 200)
    const collection = created.json() as Collection
    assert.ok(collection.id.startsWith('col_'))
    assert.equal(collection.name, 'API Test')
    assert.equal(collection.documentCount, 0)

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/collections',
      payload: { name: 'API Test' },
    })
    assert.equal(duplicate.statusCode, 409)
    assert.equal((duplicate.json() as { error: { code: string } }).error.code, 'conflict')

    const { body, boundary } = multipartFile('refund-policy.md', readFixture('refund-policy.md'))
    const upload = await app.inject({
      method: 'POST',
      url: `/api/collections/${collection.id}/documents`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    })
    assert.equal(upload.statusCode, 200, upload.body)
    const uploaded = upload.json() as { document: DocumentRecord; chunks: number }
    assert.equal(uploaded.document.title, 'Refund Policy')
    assert.ok(uploaded.chunks >= 1)

    const documents = await app.inject({
      method: 'GET',
      url: `/api/collections/${collection.id}/documents`,
    })
    assert.equal(documents.statusCode, 200)
    assert.equal((documents.json() as { items: DocumentRecord[] }).items.length, 1)

    const search = await app.inject({
      method: 'POST',
      url: `/api/collections/${collection.id}/search`,
      payload: { query: 'refund eligibility', k: 2 },
    })
    assert.equal(search.statusCode, 200)
    const results = (search.json() as { results: RetrievedChunk[] }).results
    assert.ok(results.length >= 1 && results.length <= 2)
    assert.equal(results[0]?.id, 's1')
    assert.ok((results[0]?.text ?? '').length > 0)

    const missing = await app.inject({
      method: 'GET',
      url: '/api/collections/does-not-exist/documents',
    })
    assert.equal(missing.statusCode, 404)
    const missingBody = missing.json() as { error: { message: string; code: string } }
    assert.equal(missingBody.error.code, 'not_found')
    assert.equal(typeof missingBody.error.message, 'string')

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/collections',
      payload: { name: '' },
    })
    assert.equal(invalid.statusCode, 400)
    assert.equal((invalid.json() as { error: { code: string } }).error.code, 'invalid_input')

    const nonMultipart = await app.inject({
      method: 'POST',
      url: `/api/collections/${collection.id}/documents`,
      payload: { fileName: 'x.md' },
    })
    assert.equal(nonMultipart.statusCode, 400)

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/documents/${uploaded.document.id}`,
    })
    assert.equal(deleted.statusCode, 200)
    assert.deepEqual(deleted.json(), { ok: true })

    const after = await app.inject({
      method: 'GET',
      url: `/api/collections/${collection.id}/documents`,
    })
    assert.equal((after.json() as { items: unknown[] }).items.length, 0)
  } finally {
    await close()
  }
})
