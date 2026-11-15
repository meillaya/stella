/** Error types shared by the eval runner, gate logic, fine-tuning pipeline and CLI. */

/** A business failure: bad input, impossible operation, or a gate that failed. Exit code 1 in the CLI. */
export class BusinessError extends Error {
  readonly code: string
  readonly status: number

  constructor(message: string, code = 'business_error', status = 400) {
    super(message)
    this.name = 'BusinessError'
    this.code = code
    this.status = status
  }
}

/** A usage or configuration error (bad flags, invalid config file). Exit code 2 in the CLI. */
export class UsageError extends Error {
  readonly code = 'usage_error'

  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
    this.code = 'usage_error'
  }
}

export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export const errorCode = (error: unknown): string | null => {
  if (error instanceof BusinessError) {
    return error.code
  }
  if (error instanceof UsageError) {
    return error.code
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') {
      return code
    }
  }
  return null
}
