import { createHash } from 'node:crypto'

/** Stable content hash used for ingestion dedupe and rerank cache keys. */
export const sha256Hex = (input: string | Uint8Array): string =>
  createHash('sha256').update(input).digest('hex')
