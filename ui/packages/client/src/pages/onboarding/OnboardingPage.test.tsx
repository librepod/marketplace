import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import type { OnboardingStatus } from "@librepod/shared"
import {
  ACCOUNT, CLAIM, CONNECT, GRADUATE, OnboardingPage, TRUST, VPN, deriveStep,
} from "@/pages/onboarding/OnboardingPage"

const open: OnboardingStatus = {
  state: "open", arrival: "ip", baseDomain: "libre.pod", session: false, account: null, previousAccount: null,
  vpnStatus: null, peerCount: null, lastHandshakeAt: null, endpointSuggestion: null,
}
const claimed: OnboardingStatus = {
  ...open, state: "claimed", session: true, account: "alex", vpnStatus: "not_installed", endpointSuggestion: "192.168.1.50",
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}
const mockApi = () => vi.spyOn(global, "fetch").mockImplementation(async () => jsonResponse(200, {}))
const page = (status: OnboardingStatus, onRefresh = vi.fn()) => render(<OnboardingPage status={status} onRefresh={onRefresh} />)
const vpnHeading = () => screen.getByRole("heading", { name: /reach your librepod by name/i })

describe("deriveStep — cluster truth decides the step", () => {
  it.each([
    ["open", open, CLAIM],
    ["claimed, no account confirmed", { ...claimed, account: null }, ACCOUNT],
    ["VPN not installed", claimed, VPN],
    ["VPN status unknown", { ...claimed, vpnStatus: null }, VPN],
    ["installing, no peers", { ...claimed, vpnStatus: "installing" as const, peerCount: 0 }, TRUST],
    ["running, no peers", { ...claimed, vpnStatus: "running" as const, peerCount: 0 }, TRUST],
    ["error, no peers", { ...claimed, vpnStatus: "error" as const, peerCount: 0 }, TRUST],
    ["a peer, no handshake", { ...claimed, vpnStatus: "running" as const, peerCount: 1 }, CONNECT],
    ["a handshake", { ...claimed, vpnStatus: "running" as const, peerCount: 1, lastHandshakeAt: "2026-10-14T10:00:00Z" }, GRADUATE],
  ])("%s", (_name, status, step) => {
    expect(deriveStep(status)).toBe(step)
  })
})

describe("OnboardingPage", () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it("a fresh device starts at Welcome, then Claim", () => {
    page(open)
    fireEvent.click(screen.getByRole("button", { name: /begin/i }))
    expect(screen.getByRole("heading", { name: /claim your device/i })).toBeVisible()
  })

  it("claimed, but this browser has no setup session → Resume", () => {
    page({ ...claimed, session: false })
    expect(screen.getByRole("heading", { name: /continue setting up/i })).toBeVisible()
  })

  it("after a reset the Account step offers to keep the old account", () => {
    page({ ...claimed, account: null, previousAccount: "alex" })
    expect(screen.getByLabelText(/keep alex/i)).toBeChecked()
  })

  it("WireGuard path: VPN → Trust → Connect", async () => {
    mockApi()
    const onRefresh = vi.fn()
    page(claimed, onRefresh)
    fireEvent.click(screen.getByRole("button", { name: /set up wireguard/i }))
    await screen.findByRole("heading", { name: /trust your device/i })
    expect(onRefresh).toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText(/i installed the certificate/i))
    fireEvent.click(screen.getByRole("button", { name: /continue/i }))
    expect(screen.getByRole("heading", { name: /connect your first device/i })).toBeVisible()
  })

  it("bring-my-own path: VPN → Trust → Graduate checklist, no Connect", () => {
    page(claimed)
    fireEvent.click(screen.getByRole("button", { name: /i'll bring my own/i }))
    fireEvent.click(screen.getByLabelText(/i installed the certificate/i))
    fireEvent.click(screen.getByRole("button", { name: /continue/i }))
    expect(screen.getByRole("list", { name: /before you sign in/i })).toBeVisible()
    expect(screen.queryByRole("heading", { name: /connect your first device/i })).toBeNull()
  })

  it("the path is page state: a reload asks again", () => {
    const { unmount } = page(claimed)
    fireEvent.click(screen.getByRole("button", { name: /i'll bring my own/i }))
    unmount()
    page(claimed)
    expect(vpnHeading()).toBeVisible()
  })

  it("WireGuard couldn't start: Connect falls back to the bring-my-own Graduate", () => {
    mockApi()
    page({ ...claimed, vpnStatus: "error", peerCount: 0 })
    fireEvent.click(screen.getByLabelText(/i installed the certificate/i))
    fireEvent.click(screen.getByRole("button", { name: /continue/i }))
    fireEvent.click(screen.getByRole("button", { name: /use my own connectivity instead/i }))
    expect(screen.getByRole("list", { name: /before you sign in/i })).toBeVisible()
  })

  it("a handshake leads to Graduate, which can go back to Connect for another device", () => {
    mockApi()
    page({ ...claimed, vpnStatus: "running", peerCount: 1, lastHandshakeAt: "2026-10-14T10:00:00Z" })
    expect(screen.getByRole("link", { name: /open libre\.pod/i })).toHaveAttribute("href", "https://libre.pod")
    fireEvent.click(screen.getByRole("button", { name: /connect another device/i }))
    expect(screen.getByRole("heading", { name: /connect your first device/i })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }))
    expect(screen.getByRole("link", { name: /open libre\.pod/i })).toBeVisible()
  })
})
