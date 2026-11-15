import { randomUUID } from 'node:crypto'

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`

export const now = (): number => Date.now()
