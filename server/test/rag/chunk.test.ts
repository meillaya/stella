import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  chunkDocument,
  chunkIdFor,
  DEFAULT_CHUNK_OPTIONS,
  makeBreadcrumb,
} from '../../src/rag/chunk.ts'
import { buildCodeTokens, expandIdentifier, splitIdentifier } from '../../src/rag/code-tokens.ts'
import { normalizeText } from '../../src/rag/text.ts'
import { readFixture } from './helpers.ts'

const CODE_LINES = [
  'export const getUserName = (id: number): string => {',
  '  return `user-${id}`',
  '}',
  '',
  'const retryCount = parse_retry_count(response.headers)',
  'const httpStatus = fetch_http_response.status',
  'const kebabCaseValue = fetch-http-response',
].join('\n')

test('chunker: heading breadcrumbs, char offsets and stable ids', () => {
  const text = normalizeText(readFixture('refund-policy.md'))
  const source = { id: 'doc_refund1', title: 'refund-policy.md', text }
  const chunks = chunkDocument(source)
  assert.ok(chunks.length >= 2, 'fixture should produce several chunks')

  for (const chunk of chunks) {
    assert.equal(
      chunk.text,
      text.slice(chunk.charStart, chunk.charEnd),
      'chunk text must be an exact slice of the normalized text'
    )
    assert.equal(chunk.id, chunkIdFor('doc_refund1', chunk.charStart, chunk.charEnd))
    assert.ok(chunk.breadcrumb.startsWith('refund-policy.md'))
    assert.ok(Array.isArray(chunk.headingPath))
    assert.ok(chunk.tokenEst > 0)
    assert.equal(chunk.ordinal, chunks.indexOf(chunk))
  }

  const ids = new Set(chunks.map((chunk) => chunk.id))
  assert.equal(ids.size, chunks.length, 'chunk ids must be unique')

  for (let index = 1; index < chunks.length; index += 1) {
    const previous = chunks[index - 1]
    const current = chunks[index]
    assert.ok(previous && current)
    assert.ok(current.charStart > previous.charStart, 'offsets advance')
    assert.ok(current.charStart >= previous.charEnd, 'chunks must not overlap by default')
  }

  assert.equal(chunks[0]?.charStart, 0)
  assert.equal(chunks[chunks.length - 1]?.charEnd, text.length)

  const eligibility = chunks.find((chunk) => chunk.breadcrumb.includes('Eligibility'))
  assert.ok(eligibility, 'heading path is preserved in the breadcrumb')
  assert.deepEqual(eligibility.headingPath.slice(-1), ['Eligibility'])

  const again = chunkDocument(source)
  assert.deepEqual(
    again.map((chunk) => [chunk.id, chunk.charStart, chunk.charEnd, chunk.text]),
    chunks.map((chunk) => [chunk.id, chunk.charStart, chunk.charEnd, chunk.text]),
    'chunk ids and offsets are deterministic'
  )
})

test('chunker: fenced code blocks stay whole when under the cap', () => {
  const text = normalizeText(
    [
      '# Example',
      '',
      'Intro paragraph before the code.',
      '',
      '```ts',
      'const FENCE_START = true',
      CODE_LINES,
      'const FENCE_END = true',
      '```',
      '',
      'Outro paragraph after the code.',
    ].join('\n')
  )
  // The section must exceed the cap so it splits, while the fence itself fits.
  const chunks = chunkDocument(
    { id: 'doc_code', title: 'code.md', text },
    { targetTokens: 40, maxTokens: 95, minTokens: 10 }
  )
  assert.ok(chunks.length > 1, 'small target should split the section')
  const fenceChunks = chunks.filter((chunk) => chunk.text.includes('FENCE_START'))
  assert.equal(fenceChunks.length, 1)
  const fenceChunk = fenceChunks[0]
  assert.ok(fenceChunk)
  assert.ok(fenceChunk.text.includes('FENCE_END'), 'closing fence marker is in the same chunk')
  assert.ok(fenceChunk.text.includes('```ts'))
  assert.ok(
    chunks.every((chunk) => !chunk.text.includes('FENCE_START') === !chunk.text.includes('FENCE_END')),
    'fence content is never split across chunks'
  )
})

test('chunker: markdown tables stay whole when under the cap', () => {
  const text = normalizeText(readFixture('shipping.md'))
  const chunks = chunkDocument({ id: 'doc_shipping', title: 'shipping.md', text })
  const tableChunk = chunks.find((chunk) => chunk.text.includes('| Service | Cost |'))
  assert.ok(tableChunk, 'table header is present')
  for (const row of ['Standard', 'Express', 'International', '| --- | --- |']) {
    assert.ok(tableChunk.text.includes(row), `table chunk contains "${row}"`)
  }
})

test('chunker: code_tokens shadow text expands identifiers', () => {
  const text = normalizeText(readFixture('api-reference.md'))
  const chunks = chunkDocument({ id: 'doc_api', title: 'api-reference.md', text })
  const shadow = chunks.map((chunk) => chunk.codeTokens).join(' ')
  for (const expansion of ['get user name', 'parse retry count']) {
    assert.ok(shadow.includes(expansion), `expected "${expansion}" in code_tokens`)
  }

  assert.deepEqual(splitIdentifier('getUserName'), ['get', 'User', 'Name'])
  assert.deepEqual(splitIdentifier('get_user_name'), ['get', 'user', 'name'])
  assert.deepEqual(splitIdentifier('get-user-name'), ['get', 'user', 'name'])
  assert.deepEqual(expandIdentifier('XMLHttpRequest'), ['XML', 'Http', 'Request'])
  assert.deepEqual(expandIdentifier('refund'), [])

  const built = buildCodeTokens('const userName = getUserName(); parse_retry_count()')
  assert.ok(built.includes('get User Name'))
  assert.ok(built.includes('parse retry count'))
  assert.equal(buildCodeTokens('plain words only'), '')
})

test('chunker: tiny sections merge without fabricating unrelated breadcrumbs', () => {
  const text = normalizeText('# Meridian Guide\n\n## Refunds\n\nShort policy.\n\n## Shipping\n\nShort shipping note.')
  const chunks = chunkDocument({ id: 'doc_tiny', title: 'guide.md', text })
  assert.equal(chunks.length, 1, 'all tiny sibling sections merge into one chunk')
  const [chunk] = chunks
  assert.ok(chunk)
  assert.ok(chunk.text.includes('## Refunds'))
  assert.ok(chunk.text.includes('## Shipping'))
  assert.ok(chunk.meta.mergedSections.length >= 1)
  assert.ok(chunk.breadcrumb.startsWith('guide.md > Meridian Guide'))
  assert.equal(makeBreadcrumb('Doc', ['Doc', 'Doc']), 'Doc')

  const big = normalizeText(
    '# Parent\n\n' +
      'Alpha filler sentence for the parent section. '.repeat(40) +
      '\n\n## Child\n\n' +
      'Beta filler sentence for the child section. '.repeat(40)
  )
  const bigChunks = chunkDocument({ id: 'doc_big', title: 'big.md', text: big })
  assert.ok(bigChunks.length > 2)
  assert.ok(
    bigChunks.every(
      (chunk) => !(chunk.text.includes('Alpha') && chunk.breadcrumb.includes('Child')),
      'parent-section text never reports the child heading'
    )
  )
  assert.ok(
    bigChunks.some((chunk) => chunk.text.includes('Beta') && chunk.breadcrumb.endsWith('Parent > Child')),
    'child-section chunks keep their own breadcrumb'
  )
})

test('chunker: oversized sections split at or below the token cap', () => {
  const paragraph = 'Refunds are processed within five business days after approval. '.repeat(60)
  const chunks = chunkDocument({ id: 'doc_long', title: 'long.md', text: normalizeText(paragraph) })
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(
      chunk.tokenEst <= DEFAULT_CHUNK_OPTIONS.maxTokens,
      `chunk ${chunk.ordinal} has ${chunk.tokenEst} tokens (max ${DEFAULT_CHUNK_OPTIONS.maxTokens})`
    )
  }
})

test('chunker: page ranges come from OCR page offsets', () => {
  const pageOne = normalizeText('First page talks about refunds and returns.')
  const pageTwo = normalizeText('Second page covers shipping and delivery times.')
  const text = `${pageOne}\n\n${pageTwo}`
  const pageStarts = [
    { start: 0, page: 1 },
    { start: pageOne.length + 2, page: 2 },
  ]
  const chunks = chunkDocument(
    { id: 'doc_paged', title: 'ocr.pdf', text, pageStarts },
    { targetTokens: 10, maxTokens: 15, minTokens: 0 }
  )
  assert.ok(chunks.length >= 2)
  assert.equal(chunks[0]?.pageFrom, 1)
  assert.equal(chunks[0]?.pageTo, 1)
  const second = chunks[chunks.length - 1]
  assert.ok(second)
  assert.equal(second.pageFrom, 2)
  assert.equal(second.pageTo, 2)
})

test('chunker: empty input produces no chunks', () => {
  assert.deepEqual(chunkDocument({ id: 'doc_empty', title: 'empty.md', text: '   \n\n ' }), [])
})
