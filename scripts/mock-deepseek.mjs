import { createServer } from 'node:http'

/**
 * Minimal DeepSeek-compatible upstream for local E2E/visual QA.
 * No network, no key. Emits an Anthropic-shaped SSE stream with a title and usage.
 * It is intentionally naive: it never runs inference.
 */
const port = Number(process.env.MOCK_PORT ?? 9899)

const json = (res, value, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

const readBody = async (req) => {
  const chunks = []
  for await (const chunk of req) {chunks.push(chunk)}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    return {}
  }
}

const lastUserText = (body) => {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') {continue}
    if (typeof message.content === 'string') {return message.content}
    if (Array.isArray(message.content)) {
      return message.content
        .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
        .join('\n')
    }
  }
  return ''
}

const answerFor = (text) => {
  const lower = text.toLowerCase()
  if (lower.includes('refund')) {
    return 'Annual plans can be cancelled for a full refund within 14 days of purchase; after that, a pro-rated credit is issued minus a 5% administration fee. Exceptions need Finance Operations approval. [1][2]'
  }
  if (lower.includes('retention') || lower.includes('retain')) {
    return 'Deleted exports are retained for 14 days, and the purge completes within 30 days under policy v4.0. Raw event data is retained for 90 days. [1]'
  }
  if (lower.includes('rate limit') || lower.includes('requests')) {
    return 'The Query API allows 1,200 requests per minute and 50 exports per day. Use cursor pagination for result sets above 50,000 rows. [1]'
  }
  return 'I can answer that from the Meridian documentation. The relevant detail is in the cited source. [1]'
}

const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

  if (url.pathname === '/models') {
    return json(res, {
      object: 'list',
      data: [
        { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' },
        { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
      ],
    })
  }

  if (url.pathname.endsWith('/messages') && req.method === 'POST') {
    const body = await readBody(req)
    const text = answerFor(lastUserText(body))
    const inputTokens = 1800
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (name, data) => res.write(event(name, data))
    send('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_stella_mock',
        type: 'message',
        role: 'assistant',
        model: body.model ?? 'deepseek-flash',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 600,
          output_tokens: 0,
          service_tier: 'standard',
        },
      },
    })
    send('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })
    const words = text.split(' ')
    for (const word of words) {
      send('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: `${word} ` },
      })
    }
    send('content_block_stop', { type: 'content_block_stop', index: 0 })
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null, title: 'Refund window and exceptions' },
      usage: {
        input_tokens: inputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 600,
        output_tokens: 120,
        service_tier: 'standard',
      },
    })
    send('message_stop', { type: 'message_stop' })
    res.end()
    return
  }

  json(res, { error: { message: `mock: unsupported ${req.method} ${url.pathname}` } }, 404)
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`mock deepseek on http://127.0.0.1:${port}\n`)
})
