import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  countOccurrences,
  escapeFtsQuery,
  escapeLike,
  makeSnippet,
  parseQuery,
} from '../../src/rag/query.ts'

test('query: FTS5 escaping survives identifiers, operators, quotes and unicode', () => {
  assert.equal(escapeFtsQuery('C++'), '"C"')
  assert.equal(escapeFtsQuery('"quoted phrase"'), '"quoted phrase"')
  assert.equal(escapeFtsQuery('AND OR NOT'), null, 'operator-only query has no tokens')
  assert.equal(escapeFtsQuery('   '), null)
  assert.equal(escapeFtsQuery('* () - : ^'), null)

  const safe = escapeFtsQuery('what about "exact phrase" AND C++?')
  assert.ok(safe)
  const clauses = safe.split(' OR ')
  assert.ok(clauses.includes('"exact phrase"'))
  assert.ok(clauses.includes('"C"'))
  assert.ok(!clauses.includes('"AND"'), 'uppercase boolean operators are dropped')
  // Every clause is a quoted string: no bare FTS5 operators can reach SQLite.
  for (const clause of clauses) {
    assert.match(clause, /^"(?:[^"]|"")*"$/)
  }

  assert.equal(escapeFtsQuery('退款政策'), '"退款政策"')
  assert.equal(escapeFtsQuery('退款 政策'), '"退款" OR "政策"')
  assert.equal(escapeFtsQuery('naïve café'), '"naïve" OR "café"')
})

test('query: camelCase identifiers are expanded in the query', () => {
  const escaped = escapeFtsQuery('getUserName')
  assert.ok(escaped)
  assert.ok(escaped.includes('"getUserName"'))
  assert.ok(escaped.includes('"get user name"'), 'expansion phrase clause is added')
  assert.equal(escapeFtsQuery('",;"++'), null)
})

test('query: parseQuery splits terms and quoted phrases', () => {
  const parts = parseQuery('hello "two words" C++')
  assert.deepEqual(parts, [
    { kind: 'term', token: 'hello' },
    { kind: 'phrase', tokens: ['two', 'words'] },
    { kind: 'term', token: 'C' },
  ])
})

test('query: makeSnippet centres on the earliest term and cleans markdown markers', () => {
  const long = `${'filler text '.repeat(80)}refund policy details ${'more filler '.repeat(80)}`
  const snippet = makeSnippet(long, 'refund')
  assert.ok(snippet.startsWith('…'))
  assert.ok(snippet.endsWith('…'))
  assert.ok(snippet.includes('refund policy'))

  const short = '# Refund Policy\n\nRefunds are processed quickly.'
  const cleaned = makeSnippet(short, 'refund')
  assert.ok(!cleaned.includes('#'), 'heading markers are stripped from snippets')
  assert.ok(cleaned.startsWith('Refund Policy'))

  assert.ok(makeSnippet('abcdef '.repeat(100), 'zzz').endsWith('…'))
})

test('query: escapeLike and countOccurrences', () => {
  assert.equal(escapeLike('50%_off\\'), '50\\%\\_off\\\\')
  assert.equal(countOccurrences('Refund refund REFUND', 'refund'), 3)
  assert.equal(countOccurrences('abc', 'z'), 0)
  assert.equal(countOccurrences('aaaa', 'aa'), 2)
})
