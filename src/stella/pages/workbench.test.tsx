import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Overview } from '../../../shared/types.js'
import { parseHash } from '../router.js'

const overview: Overview = {
  hasKey: false,
  activeProfile: null,
  dataset: null,
  latestRun: null,
  baselineRun: null,
  gate: null,
  metrics: {
    passRate: null,
    passRateDeltaPp: null,
    costPerPassUsd: null,
    costDeltaPct: null,
    p95LatencyMs: null,
    latencyDeltaPct: null,
    cases: 0,
    traces24h: 0,
    negativeFeedback24h: 0,
  },
  trend: [],
  failingCases: [],
  reviewQueue: [],
}

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const renderRoute = async (hash: string) => {
  const { WorkbenchRoute } = await import('./index.js')
  return render(<WorkbenchRoute route={parseHash(hash)} />)
}

describe('WorkbenchRoute', () => {
  it('loads the quality page and renders the honest empty state', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/overview') {return jsonResponse(overview)}
      return jsonResponse({ error: { message: 'Not found' } }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    await renderRoute('#/quality')

    expect(await screen.findByRole('heading', { name: 'Quality' })).toBeInTheDocument()
    expect(await screen.findByText('No evaluation runs yet')).toBeInTheDocument()
    expect(screen.getByText('NO RUNS')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/overview', expect.anything())
  })

  it('renders a useful not-found page for an unknown route', async () => {
    await renderRoute('#/does-not-exist')
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    expect(screen.getByText('Nothing lives at this address')).toBeInTheDocument()
  })
})
