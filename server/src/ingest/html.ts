/**
 * HTML → normalized Markdown-ish text using `node-html-parser` (the only HTML
 * dependency in the repo). Navigation/scripts/styles/forms are stripped;
 * headings, paragraphs, fenced code, lists, blockquotes and tables are kept as
 * text so the chunker can reason about their structure.
 *
 * `pre` content is not parsed into a DOM by node-html-parser (v9 keeps it as
 * raw text), so code is unwrapped from its optional `<code class="language-x">`
 * wrapper manually. Text getters already decode HTML entities.
 */
import { parse, NodeType, type HTMLElement, type Node, type TextNode } from 'node-html-parser'
import { collapseWhitespace } from '../rag/text.ts'

export type ExtractedHtml = {
  title: string | null
  markdown: string
  /** Approximate number of `<h*>` sections, stored in document metadata. */
  headings: number
}

const NOISE_TAGS = new Set([
  'script',
  'style',
  'nav',
  'noscript',
  'iframe',
  'svg',
  'form',
  'button',
  'input',
  'select',
  'textarea',
  'template',
  'canvas',
  'object',
  'embed',
])

const NOISE_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'search', 'dialog', 'alert'])

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'aside',
  'figure',
  'figcaption',
  'dl',
  'dt',
  'dd',
  'form',
  'address',
])

const isElement = (node: Node): node is HTMLElement => node.nodeType === NodeType.ELEMENT_NODE

const isBlockNode = (node: Node): boolean => {
  if (!isElement(node)) {return false}
  const tag = node.tagName.toLowerCase()
  return BLOCK_TAGS.has(tag) || /^h[1-6]$/.test(tag) || ['pre', 'table', 'ul', 'ol', 'blockquote', 'hr'].includes(tag)
}

const stripNoise = (root: HTMLElement): void => {
  for (const element of root.querySelectorAll('*')) {
    const tag = element.tagName.toLowerCase()
    const role = (element.getAttribute('role') ?? '').toLowerCase()
    const hidden = element.getAttribute('aria-hidden') === 'true'
    if (NOISE_TAGS.has(tag) || NOISE_ROLES.has(role) || hidden) {
      element.remove()
      continue
    }
    if (tag === 'header' || tag === 'footer') {
      // Page chrome only when it is a direct child of body; article headers are content.
      const parent = element.parentNode
      if (!parent || parent.tagName.toLowerCase() === 'body' || parent.tagName.toLowerCase() === 'html') {
        element.remove()
      }
    }
  }
}

/** Inline text of a node: text + inline code in backticks, `<br>` becomes a space. */
const inlineText = (node: Node): string => {
  if (node.nodeType === NodeType.TEXT_NODE) {return (node as TextNode).text}
  if (!isElement(node)) {return ''}
  const tag = node.tagName.toLowerCase()
  if (tag === 'br') {return ' '}
  if (tag === 'img') {return node.getAttribute('alt') ?? ''}
  if (tag === 'code' || tag === 'kbd') {
    const raw = node.text.trim()
    if (!raw) {return ''}
    return raw.includes('`') ? `\`\`${raw}\`\`` : `\`${raw}\``
  }
  return node.childNodes.map(inlineText).join('')
}

const fenced = (content: string, language: string): string => {
  const fence = content.includes('```') ? '````' : '```'
  return `${fence}${language}\n${content.trim()}\n${fence}`
}

const languageFromClass = (value: string | undefined): string => {
  const match = /(?:language|lang)-([\w+#-]+)/i.exec(value ?? '')
  return match?.[1] ?? ''
}

const renderPre = (element: HTMLElement): string => {
  const raw = element.text
  const open = /^\s*<code(\s[^>]*)?>/i.exec(raw)
  let content = raw
  let language = languageFromClass(element.getAttribute('class'))
  if (open) {
    language = language || languageFromClass(open[1])
    content = raw.slice(open[0].length)
    const closing = content.lastIndexOf('</code>')
    if (closing >= 0) {content = content.slice(0, closing)}
  }
  return fenced(content, language)
}

const renderTable = (element: HTMLElement): string => {
  const rows = element.querySelectorAll('tr')
  if (rows.length === 0) {return ''}
  const rendered = rows.map((row) => {
    const cells = row.childNodes
      .filter((cell): cell is HTMLElement => isElement(cell) && /^(td|th)$/i.test(cell.tagName))
      .map((cell) => collapseWhitespace(cell.text).replaceAll('|', '\\|'))
    return cells
  })
  const nonEmpty = rendered.filter((cells) => cells.length > 0)
  if (nonEmpty.length === 0) {return ''}
  const width = Math.max(...nonEmpty.map((cells) => cells.length))
  const pad = (cells: string[]): string[] => {
    const next = [...cells]
    while (next.length < width) {next.push('')}
    return next
  }
  const header = pad(nonEmpty[0] as string[])
  const body = nonEmpty.slice(1).map(pad)
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`]
  for (const cells of body) {lines.push(`| ${cells.join(' | ')} |`)}
  return lines.join('\n')
}

const renderList = (element: HTMLElement, out: string[], depth = 0): void => {
  const ordered = element.tagName.toLowerCase() === 'ol'
  let index = 0
  for (const child of element.childNodes) {
    if (!isElement(child) || child.tagName.toLowerCase() !== 'li') {continue}
    index += 1
    const nested: HTMLElement[] = []
    let text = ''
    for (const grand of child.childNodes) {
      if (isElement(grand) && /^(ul|ol)$/i.test(grand.tagName)) {
        nested.push(grand)
        continue
      }
      text += `${inlineText(grand)} `
    }
    const value = collapseWhitespace(text)
    const prefix = ordered ? `${index}. ` : '- '
    if (value) {out.push(`${'  '.repeat(depth)}${prefix}${value}`)}
    for (const sub of nested) {renderList(sub, out, depth + 1)}
  }
}

const renderBlockquote = (element: HTMLElement): string => {
  const inner: string[] = []
  for (const child of element.childNodes) {renderNode(child, inner)}
  const body = inner.join('\n\n').trim()
  if (!body) {return ''}
  return body
    .split('\n')
    .map((line) => (line.trim().length > 0 ? `> ${line}` : '>'))
    .join('\n')
}

const renderNode = (node: Node, out: string[]): void => {
  if (node.nodeType === NodeType.TEXT_NODE) {
    const value = collapseWhitespace((node as TextNode).text)
    if (value) {out.push(value)}
    return
  }
  if (!isElement(node)) {return}

  const tag = node.tagName.toLowerCase()
  if (tag === 'pre') {
    const rendered = renderPre(node)
    if (rendered) {out.push(rendered)}
    return
  }
  if (tag === 'table') {
    const rendered = renderTable(node)
    if (rendered) {out.push(rendered)}
    return
  }
  const heading = /^h([1-6])$/.exec(tag)
  if (heading) {
    const value = collapseWhitespace(inlineText(node))
    if (value) {out.push(`${'#'.repeat(Number(heading[1]))} ${value}`)}
    return
  }
  if (tag === 'ul' || tag === 'ol') {
    renderList(node, out)
    return
  }
  if (tag === 'blockquote') {
    const rendered = renderBlockquote(node)
    if (rendered) {out.push(rendered)}
    return
  }
  if (tag === 'hr' || tag === 'br') {return}

  const hasBlockChildren = node.childNodes.some(isBlockNode)
  if (hasBlockChildren) {
    for (const child of node.childNodes) {renderNode(child, out)}
    return
  }
  const value = collapseWhitespace(inlineText(node))
  if (value) {out.push(value)}
}

const firstHeadingText = (doc: HTMLElement): string => {
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    const heading = doc.querySelector(tag)
    if (heading) {
      const text = collapseWhitespace(heading.text)
      if (text) {return text}
    }
  }
  return ''
}

const metaTitle = (doc: HTMLElement): string | null => {
  for (const meta of doc.querySelectorAll('meta')) {
    const property = meta.getAttribute('property') ?? meta.getAttribute('name')
    if (property === 'og:title' || property === 'twitter:title') {
      const content = collapseWhitespace(meta.getAttribute('content') ?? '')
      if (content) {return content}
    }
  }
  return null
}

/** Extract title + normalized Markdown from an HTML document or fragment. */
export const extractHtml = (html: string): ExtractedHtml => {
  const doc = parse(html, { comment: false })
  const titleTag = doc.querySelector('title')
  const title =
    (titleTag ? collapseWhitespace(titleTag.text) : '') ||
    (metaTitle(doc) ?? '') ||
    firstHeadingText(doc) ||
    null

  const body = doc.querySelector('body') ?? doc
  stripNoise(body)

  const root = body.querySelector('main') ?? body.querySelector('article') ?? body
  const blocks: string[] = []
  for (const child of root.childNodes) {renderNode(child, blocks)}

  const headingCount = root.querySelectorAll('h1,h2,h3,h4,h5,h6').length
  const markdown = blocks
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .join('\n\n')

  return { title, markdown, headings: headingCount }
}
