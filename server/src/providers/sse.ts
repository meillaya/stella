/**
 * Minimal server-side SSE reader for provider streams (text level).
 * Byte-exact frame forwarding for the gateway proxy lives in `gateway/sse.ts`;
 * this reader only needs event names and data payloads.
 */

export type SseEvent = {
  event: string
  data: string
}

const LINE_BREAK = /\r\n|\r|\n/g

export async function* readSseEvents(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader()
  const onAbort = () => {
    reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  let eventName = ''
  let finished = false

  const dispatch = (): SseEvent | null => {
    if (data.length === 0) {
      eventName = ''
      return null
    }
    const event: SseEvent = { event: eventName || 'message', data: data.join('\n') }
    data = []
    eventName = ''
    return event
  }

  const processLine = (line: string): SseEvent | null => {
    if (line === '') {return dispatch()}
    if (line.startsWith(':')) {return null}
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) {value = value.slice(1)}
    if (field === 'data') {data.push(value)}
    else if (field === 'event') {eventName = value}
    return null
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        finished = true
        buffer += decoder.decode()
        LINE_BREAK.lastIndex = 0
        for (let match = LINE_BREAK.exec(buffer); match; match = LINE_BREAK.exec(buffer)) {
          const event = processLine(buffer.slice(0, match.index))
          if (event) {yield event}
        }
        return
      }
      buffer += decoder.decode(value, { stream: true })
      let consumed = 0
      LINE_BREAK.lastIndex = 0
      for (let match = LINE_BREAK.exec(buffer); match; match = LINE_BREAK.exec(buffer)) {
        // A trailing CR may be the first half of CRLF split across chunks.
        if (match[0] === '\r' && LINE_BREAK.lastIndex === buffer.length) {break}
        const event = processLine(buffer.slice(consumed, match.index))
        consumed = LINE_BREAK.lastIndex
        if (event) {yield event}
      }
      buffer = buffer.slice(consumed)
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (!finished) {reader.cancel().catch(() => {})}
    else {reader.releaseLock()}
  }
}
