import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { OnboardingPage } from "@/pages/onboarding/OnboardingPage"
import type { OnboardingStatus } from "@librepod/shared"

const base: OnboardingStatus = {
  mode: "onboarding", arrival: "ip", baseDomain: "libre.pod",
  casdoorUp: true, wgEasyUp: false, adminClaimed: false, peerCount: null, lastHandshakeAt: null,
}

function withStatus(s: OnboardingStatus) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OnboardingPage status={s} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe("OnboardingPage", () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it("starts at Welcome for a fresh unclaimed device", () => {
    withStatus(base)
    expect(screen.getByText(/welcome to your librepod/i)).toBeVisible()
  })

  it("resume: claimed + no peers lands on Trust", () => {
    withStatus({ ...base, mode: "ready", adminClaimed: true, peerCount: 0 })
    expect(screen.getByText(/trust your device/i)).toBeVisible()
  })

  it("resume: unknown peer count (wg-easy unreachable) also lands on Trust — never skips the CA step", () => {
    withStatus({ ...base, mode: "ready", adminClaimed: true, peerCount: null })
    expect(screen.getByText(/trust your device/i)).toBeVisible()
  })

  it("resume: peer exists + no handshake lands on Connect and shows the QR", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ peers: [{ clientId: "c1", name: "phone", enabled: true, latestHandshakeAt: null }] }),
    } as Response)
    withStatus({ ...base, mode: "ready", adminClaimed: true, peerCount: 1 })
    expect(screen.getByText(/connect your first device/i)).toBeVisible()
    // the peer list arrives via the usePeers fetch — wait for it
    expect(await screen.findByAltText(/QR for phone/i)).toHaveAttribute("src", "/api/bootstrap/wireguard/clients/c1/qrcode.svg")
  })

  it("handshake seen → Graduate leads with the domain", () => {
    withStatus({ ...base, mode: "ready", adminClaimed: true, peerCount: 1, lastHandshakeAt: "2026-09-05T10:00:00Z" })
    expect(screen.getByText("libre.pod")).toBeVisible()
    expect(screen.getByRole("link", { name: /enter libre\.pod/i })).toHaveAttribute("href", "https://libre.pod")
  })

  it("claim posts the password and advances", async () => {
    localStorage.setItem("librepod-onboarding-welcome", "1")
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response)
    withStatus(base)
    expect(screen.getByText("admin@libre.pod")).toBeVisible()
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "longenough1" } })
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "longenough1" } })
    fireEvent.click(screen.getByRole("button", { name: /claim this device/i }))
    await screen.findByText(/trust your device/i)
    const [url, init] = fetchMock.mock.calls.at(-1)!
    expect(String(url)).toBe("/api/bootstrap/claim")
    expect(JSON.parse(String(init!.body))).toEqual({ password: "longenough1" })
  })
})
