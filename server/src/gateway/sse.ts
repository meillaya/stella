/**
 * Byte-exact SSE frame splitting for the gateway proxy.
 *
 * The proxy must forward every upstream byte except the two semantics-bearing
 * `message_start` / `message_delta` frames it rewrites (trace id/sources/cost).
 * Decoding the whole stream and re-encoding it would break byte fidelity for
 * comments, keep-alives and unknown frames, and a chunk boundary may split a
 * UTF-8 code point. So we split at the byte level into complete frames (bytes
 * ending in a blank line) and only decode a frame when we intentionally inspect
 * or rewrite it. Multi-byte code points can never contain CR/LF, so splitting
 * on line terminators never splits a UTF-8 sequence.
 */

const LF = 0x0a
const CR = 0x0d

export type SseFrame = {
  event: string
  data: string
}

export class SseFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)
  private scan = 0
  private frameStart = 0
  private lineStart = 0

  /** Feed one upstream chunk; returns every complete frame (raw bytes). */
  push(chunk: Uint8Array): Buffer[] {
    if (chunk.length > 0) {
      this.buffer =
        this.buffer.length === 0
          ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : Buffer.concat([this.buffer, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)])
    }
    const frames: Buffer[] = []
    this.scanFrames(frames)
    if (this.frameStart > 0) {
      this.buffer = this.buffer.subarray(this.frameStart)
      this.scan -= this.frameStart
      this.lineStart -= this.frameStart
      this.frameStart = 0
    }
    return frames
  }

  /** Flush the trailing partial frame (an interrupted stream). Returns raw bytes. */
  end(): Buffer[] {
    if (this.buffer.length <= this.frameStart) {
      this.reset()
      return []
    }
    const rest = Buffer.from(this.buffer.subarray(this.frameStart))
    this.reset()
    return [rest]
  }

  private reset(): void {
    this.buffer = Buffer.alloc(0)
    this.scan = 0
    this.frameStart = 0
    this.lineStart = 0
  }

  private emit(frames: Buffer[]): void {
    frames.push(Buffer.from(this.buffer.subarray(this.frameStart, this.scan)))
    this.frameStart = this.scan
    this.lineStart = this.scan
  }

  private scanFrames(frames: Buffer[]): void {
    const buffer = this.buffer
    while (this.scan < buffer.length) {
      const byte = buffer[this.scan] as number
      if (byte === LF) {
        const emptyLine = this.scan === this.lineStart
        this.scan += 1
        if (emptyLine) {this.emit(frames)}
        else {this.lineStart = this.scan}
        continue
      }
      if (byte === CR) {
        const next = buffer[this.scan + 1]
        if (next === undefined) {
          // Could be a CR or the first half of CRLF; wait for the next chunk.
          break
        }
        const emptyLine = this.scan === this.lineStart
        this.scan += next === LF ? 2 : 1
        if (emptyLine) {this.emit(frames)}
        else {this.lineStart = this.scan}
        continue
      }
      this.scan += 1
    }
  }
}

type Line = { content: string; terminator: string }

/** Split a decoded frame into lines, keeping each line's exact terminator. */
export const splitSseLines = (text: string): Line[] => {
  const lines: Line[] = []
  let index = 0
  while (index < text.length) {
    let end = -1
    let terminator = ''
    for (let cursor = index; cursor < text.length; cursor += 1) {
      const char = text[cursor] as string
      if (char === '\r') {
        end = cursor
        terminator = text[cursor + 1] === '\n' ? '\r\n' : '\r'
        break
      }
      if (char === '\n') {
        end = cursor
        terminator = '\n'
        break
      }
    }
    if (end === -1) {
      lines.push({ content: text.slice(index), terminator: '' })
      break
    }
    lines.push({ content: text.slice(index, end), terminator })
    index = end + terminator.length
  }
  return lines
}

/** Decode a complete frame's `event:` / `data:` fields (comments ignored). */
export const parseSseFrame = (frame: Buffer): SseFrame | null => {
  let event = ''
  const data: string[] = []
  for (const line of splitSseLines(frame.toString('utf8'))) {
    const content = line.content
    if (!content || content.startsWith(':')) {continue}
    const colon = content.indexOf(':')
    const field = colon === -1 ? content : content.slice(0, colon)
    let value = colon === -1 ? '' : content.slice(colon + 1)
    if (value.startsWith(' ')) {value = value.slice(1)}
    if (field === 'event') {event = value}
    else if (field === 'data') {data.push(value)}
  }
  return data.length === 0 ? null : { event: event || 'message', data: data.join('\n') }
}

/**
 * Replace a frame's `data:` payload(s) with one new data line, preserving the
 * `event:` line, comments, line endings and the terminating blank line.
 * Callers must only pass complete frames (the decoder guarantees that).
 */
export const replaceFrameData = (frame: Buffer, data: string): Buffer => {
  const lines = splitSseLines(frame.toString('utf8'))
  const out: Line[] = []
  let replaced = false
  for (const line of lines) {
    if (line.content.startsWith('data:')) {
      if (!replaced) {
        out.push({ content: `data: ${data}`, terminator: line.terminator })
        replaced = true
      }
      continue
    }
    out.push(line)
  }
  if (!replaced) {return frame}
  return Buffer.from(out.map((line) => line.content + line.terminator).join(''), 'utf8')
}

/** True for `message_start` / `message_delta` frames whose usage we augment. */
export const framePayloadType = (frame: Buffer): string | null => {
  const parsed = parseSseFrame(frame)
  if (!parsed) {return null}
  try {
    const payload: unknown = JSON.parse(parsed.data)
    if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
      const type = (payload as Record<string, unknown>).type
      return typeof type === 'string' ? type : null
    }
  } catch {
    return null
  }
  return null
}
