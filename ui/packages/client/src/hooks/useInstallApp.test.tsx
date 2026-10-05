import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { useInstallApp, InstallError } from './useInstallApp'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const reply = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response

let client: QueryClient
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  vi.resetAllMocks()
  client = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } })
})

describe('useInstallApp', () => {
  it('one-click install posts without a body', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(reply({ success: true, message: 'ok' }))
    const { result } = renderHook(() => useInstallApp('demo', 'Demo'), { wrapper })

    result.current.mutate(undefined)

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/apps/demo/install')
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
  })

  it('dialog install posts the request as JSON', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(reply({ success: true, message: 'ok' }))
    const { result } = renderHook(() => useInstallApp('demo', 'Demo'), { wrapper })
    const request = { settings: { TOKEN: 't' }, custom: [{ name: 'A', value: '1' }] }

    result.current.mutate(request)

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body as string)).toEqual(request)
  })

  it('a 400 with field errors becomes an InstallError carrying them, without a toast', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      reply({ message: 'Some settings need attention', errors: [{ name: 'TOKEN', message: 'Required' }] }, 400),
    )
    const { result } = renderHook(() => useInstallApp('demo', 'Demo'), { wrapper })

    result.current.mutate({ settings: {} })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(InstallError)
    expect(result.current.error?.message).toBe('Some settings need attention')
    expect(result.current.error?.fieldErrors).toEqual([{ name: 'TOKEN', message: 'Required' }])
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('one-click failures still toast', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(reply({ message: 'boom' }, 500))
    const { result } = renderHook(() => useInstallApp('demo', 'Demo'), { wrapper })

    result.current.mutate(undefined)

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.fieldErrors).toEqual([])
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't install Demo",
      expect.objectContaining({ description: 'boom' }),
    )
  })
})
