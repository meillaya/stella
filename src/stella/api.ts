import { useCallback, useEffect, useState } from 'react'

export class ApiError extends Error {
  readonly status: number
  readonly code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

const parseError = async (response: Response): Promise<ApiError> => {
  let message = response.statusText || `Request failed with ${response.status}`
  let code: string | undefined
  try {
    const body = (await response.json()) as { error?: { message?: string; code?: string } }
    if (body.error?.message) {message = body.error.message}
    code = body.error?.code
  } catch {
    // Keep the status text when the body is not JSON.
  }
  return new ApiError(message, response.status, code)
}

const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  if (!response.ok) {throw await parseError(response)}
  if (response.status === 204) {return undefined as T}
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) {return (await response.text()) as T}
  return (await response.json()) as T
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal): Promise<T> => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown): Promise<T> =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' }),
  postForm: <T>(path: string, form: FormData): Promise<T> =>
    request<T>(path, { method: 'POST', body: form }),
  text: (path: string): Promise<string> => request<string>(path),
}

export type QueryState<T> = {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
}

/**
 * Small fetch hook. Polling is opt-in and silent once data exists, so tables
 * do not flicker while a run is in progress.
 */
export const useApi = <T>(path: string | null, options: { pollMs?: number } = {}): QueryState<T> => {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(Boolean(path))
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!path) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    const controller = new AbortController()
    setLoading((current) => current || data === null)
    setError(null)
    api
      .get<T>(path, controller.signal)
      .then((result) => {
        setData(result)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') {return}
        setError(cause instanceof Error ? cause.message : String(cause))
        setLoading(false)
      })
    return () => controller.abort()
    // data is intentionally not a dependency: it would refetch on every update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce])

  useEffect(() => {
    if (!options.pollMs || !path) {return}
    const timer = setInterval(() => setNonce((value) => value + 1), options.pollMs)
    return () => clearInterval(timer)
  }, [options.pollMs, path])

  const reload = useCallback(() => setNonce((value) => value + 1), [])

  return { data, error, loading, reload }
}

export const json = <T>(value: T): string => JSON.stringify(value, null, 2)
