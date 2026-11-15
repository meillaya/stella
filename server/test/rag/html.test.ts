import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractHtml } from '../../src/ingest/html.ts'

const PAGE = `<!doctype html>
<html>
  <head><title>Meridian Help</title><meta property="og:title" content="OG Meridian"></head>
  <body>
    <nav>Navigation noise</nav>
    <script>bad()</script>
    <style>.x { color: red }</style>
    <header><p>Site header noise</p></header>
    <main>
      <h1>Getting Started</h1>
      <p>Welcome to <strong>Meridian</strong>.</p>
      <h2>Install</h2>
      <pre><code class="language-bash">npm install meridian</code></pre>
      <h2>Plans</h2>
      <table>
        <tr><th>Plan</th><th>Price</th></tr>
        <tr><td>Pro</td><td>20</td></tr>
        <tr><td>Max</td><td>50</td></tr>
      </table>
      <h2>Highlights</h2>
      <ul><li>Fast</li><li>Simple</li></ul>
      <blockquote>Quoted words.</blockquote>
      <p>Use <code>getUserName</code> to resolve names.</p>
    </main>
    <footer>Footer noise</footer>
  </body>
</html>`

test('html: strip chrome, keep headings/code/tables/lists and decode entities', () => {
  const extracted = extractHtml(PAGE)
  assert.equal(extracted.title, 'Meridian Help')
  const markdown = extracted.markdown
  assert.match(markdown, /^# Getting Started$/m)
  assert.match(markdown, /^## Install$/m)
  assert.ok(!markdown.includes('Navigation noise'))
  assert.ok(!markdown.includes('bad()'))
  assert.ok(!markdown.includes('Site header noise'))
  assert.ok(!markdown.includes('Footer noise'))
  assert.ok(!markdown.includes('color: red'))
  assert.match(markdown, /```bash\nnpm install meridian\n```/)
  assert.ok(markdown.includes('| Plan | Price |'))
  assert.ok(markdown.includes('| --- | --- |'))
  assert.ok(markdown.includes('| Pro | 20 |'))
  assert.ok(markdown.includes('| Max | 50 |'))
  assert.ok(markdown.includes('- Fast'))
  assert.ok(markdown.includes('- Simple'))
  assert.ok(markdown.includes('> Quoted words.'))
  assert.ok(markdown.includes('`getUserName`'))
  assert.ok(extracted.headings >= 4)
})

test('html: nested blocks, entities, pre without <code>, and fragment roots', () => {
  const extracted = extractHtml(
    '<article><h2>Entities</h2><p>&lt;tag&gt; &amp; more</p><div><p>Nested paragraph</p></div><pre>plain pre text</pre></article>'
  )
  assert.equal(extracted.title, 'Entities', 'first h1/h2 fallback title is the heading text')
  assert.ok(extracted.markdown.includes('<tag> & more'))
  assert.ok(extracted.markdown.includes('Nested paragraph'))
  assert.ok(extracted.markdown.includes('```\nplain pre text\n```'))

  const fragment = extractHtml('<h1>Only H1</h1><p>Body.</p>')
  assert.equal(fragment.title, 'Only H1')
  assert.ok(fragment.markdown.includes('# Only H1'))
})
