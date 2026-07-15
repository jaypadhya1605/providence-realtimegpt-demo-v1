import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ApiClient realtime lifecycle', () => {
  it('sends fully played avatar turns as evaluator question evidence', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await new ApiClient().evaluate(
      'SCN-001',
      ['I hear that you are scared.'],
      ['What happens next?'],
      0,
      0,
      0,
    )

    const request = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({
      learnerTurns: ['I hear that you are scared.'],
      avatarTurns: ['What happens next?'],
    })
  })

  it('resets a stale browser session before reconnecting', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await new ApiClient().resetRealtimeSession()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/realtime/reset',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('keeps the release request alive during navigation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await new ApiClient().endRealtimeSession('session-123', true)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/realtime/end',
      expect.objectContaining({ keepalive: true }),
    )
  })
})