import { useMemo, useSyncExternalStore } from 'react'

/** Hash routes keep the static build simple and work on reload without server routing. */
export type RouteName =
  | 'chat'
  | 'quality'
  | 'traces'
  | 'trace'
  | 'datasets'
  | 'dataset'
  | 'runs'
  | 'run'
  | 'compare'
  | 'improve'
  | 'settings'
  | 'notfound'

export type Route = {
  name: RouteName
  path: string
  id?: string
  query: URLSearchParams
}

const subscribe = (listener: () => void): (() => void) => {
  window.addEventListener('hashchange', listener)
  window.addEventListener('popstate', listener)
  return () => {
    window.removeEventListener('hashchange', listener)
    window.removeEventListener('popstate', listener)
  }
}

export const parseHash = (hash: string): Route => {
  const raw = (hash || '').replace(/^#/, '') || '/'
  const [rawPath, rawQuery = ''] = raw.split('?')
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent)
  const query = new URLSearchParams(rawQuery)
  const route = (name: RouteName, id?: string): Route => ({ name, path, id, query })

  if (segments.length === 0 || segments[0] === 'chat') {return route('chat')}
  switch (segments[0]) {
    case 'quality':
      return route('quality')
    case 'traces':
      return segments[1] ? route('trace', segments[1]) : route('traces')
    case 'datasets':
      return segments[1] ? route('dataset', segments[1]) : route('datasets')
    case 'runs':
      if (segments[1] === 'compare') {return route('compare')}
      return segments[1] ? route('run', segments[1]) : route('runs')
    case 'improve':
      return route('improve')
    case 'settings':
      return route('settings')
    default:
      return route('notfound')
  }
}

export const useRoute = (): Route => {
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => ''
  )
  return useMemo(() => parseHash(hash), [hash])
}

const normalize = (path: string): string => {
  if (path === '' || path === '#') {return '#/'}
  if (path.startsWith('#')) {return path}
  return `#${path.startsWith('/') ? path : `/${path}`}`
}

export const navigate = (path: string, options: { replace?: boolean } = {}): void => {
  const next = normalize(path)
  if (window.location.hash === next) {return}
  if (options.replace) {
    window.history.replaceState(null, '', next)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  } else {
    window.location.hash = next
  }
}

export const href = (path: string): string => normalize(path)

export const withQuery = (path: string, query: Record<string, string | number | null | undefined>): string => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined && value !== '') {params.set(key, String(value))}
  }
  const suffix = params.toString()
  return suffix ? `${path}?${suffix}` : path
}
