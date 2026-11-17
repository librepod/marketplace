import { describe, it, expect, vi, afterEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useDevice, useDeviceWrite } from "./useDevice"

afterEach(() => vi.restoreAllMocks())

const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response

describe("useDeviceWrite", () => {
  it("a poll that read the Device before the write can't overwrite the write's answer", async () => {
    let answerPoll!: (r: Response) => void
    vi.spyOn(global, "fetch").mockImplementation((_url, init) =>
      init?.method
        ? Promise.resolve(reply({ os: "present", device: { name: "fresh" } }))
        : new Promise<Response>((r) => (answerPoll = r)),
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => ({ q: useDevice(), w: useDeviceWrite() }), { wrapper })
    await waitFor(() => expect(answerPoll).toBeDefined())

    await act(() => result.current.w.mutateAsync({ path: "power", method: "POST", body: {} }))
    await act(async () => answerPoll(reply({ os: "present", device: { name: "stale" } })))

    expect(result.current.q.data).toEqual({ os: "present", device: { name: "fresh" } })
  })
})
