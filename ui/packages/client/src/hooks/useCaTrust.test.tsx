import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"
import { useCaTrust } from "./useCaTrust"

beforeEach(() => vi.restoreAllMocks())

describe("useCaTrust", () => {
  it("any HTTP answer means trusted — even an error status — and the probe is no-cors", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({ ok: false, status: 404 } as Response)
    const { result } = renderHook(() => useCaTrust("https://id.libre.pod/"))
    await waitFor(() => expect(result.current.trust).toBe("trusted"))
    expect(fetchSpy).toHaveBeenCalledWith("https://id.libre.pod/", { mode: "no-cors", signal: expect.any(AbortSignal) })
  })

  it("a rejected fetch means untrusted — TLS rejection surfaces as a bare TypeError", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new TypeError("Failed to fetch"))
    const { result } = renderHook(() => useCaTrust("https://libre.pod/api/health"))
    await waitFor(() => expect(result.current.trust).toBe("untrusted"))
  })

  it("a probe that never answers counts as untrusted after the timeout", async () => {
    vi.useFakeTimers()
    // Hangs until aborted — the timeout's abort is the only way out.
    vi.spyOn(global, "fetch").mockImplementation((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
      }))
    const { result } = renderHook(() => useCaTrust("https://id.libre.pod/"))
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(result.current.trust).toBe("untrusted")
    vi.useRealTimers()
  })

  it("no URL yet: nothing to probe, verdict stays unknown", () => {
    const { result } = renderHook(() => useCaTrust(undefined))
    expect(result.current.trust).toBe("unknown")
    expect(result.current.checking).toBe(false)
  })

  it("checkAgain re-probes and can flip the verdict", async () => {
    vi.spyOn(global, "fetch")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
    const { result } = renderHook(() => useCaTrust("https://id.libre.pod/"))
    await waitFor(() => expect(result.current.trust).toBe("untrusted"))
    act(() => result.current.checkAgain())
    await waitFor(() => expect(result.current.trust).toBe("trusted"))
  })
})
