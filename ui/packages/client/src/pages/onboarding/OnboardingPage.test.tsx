import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import type { OnboardingStatus } from "@librepod/shared"
import {
  ACCOUNT, CLAIM, CONNECT, GRADUATE, OnboardingPage, VPN, deriveStep,
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
    // Any status past not_installed goes straight to Connect — certificate trust
    // is no longer a wizard step; the app's banner teaches it after sign-in.
    ["installing", { ...claimed, vpnStatus: "installing" as const, peerCount: 0 }, CONNECT],
    ["running, no peers", { ...claimed, vpnStatus: "running" as const, peerCount: 0 }, CONNECT],
    ["error, no peers", { ...claimed, vpnStatus: "error" as const, peerCount: 0 }, CONNECT],
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

  it("WireGuard path: VPN → Connect", async () => {
    mockApi()
    const onRefresh = vi.fn()
    page(claimed, onRefresh)
    fireEvent.click(screen.getByRole("button", { name: /set up wireguard/i }))
    await screen.findByRole("heading", { name: /connect your first device/i })
    expect(onRefresh).toHaveBeenCalled()
  })

  it("bring-my-own path: VPN → Graduate checklist, no Connect", () => {
    page(claimed)
    fireEvent.click(screen.getByRole("button", { name: /i'll bring my own/i }))
    expect(screen.getByRole("list", { name: /before you sign in/i })).toBeVisible()
    expect(screen.queryByRole("heading", { name: /connect your first device/i })).toBeNull()
  })

  it("bring-my-own: the rail never marks the skipped Connect step done", () => {
    page(claimed)
    fireEvent.click(screen.getByRole("button", { name: /i'll bring my own/i }))
    const connectItem = within(screen.getByRole("list", { name: /setup progress/i }))
      .getByText("Connect")
      .closest("li")
    expect(connectItem).not.toHaveTextContent("✓")
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
    fireEvent.click(screen.getByRole("button", { name: /use my own connectivity instead/i }))
    expect(screen.getByRole("list", { name: /before you sign in/i })).toBeVisible()
  })

  it.each([
    ["Claim", open],
    ["Account", { ...claimed, account: null }],
    ["Reach", claimed],
    ["Connect", { ...claimed, vpnStatus: "running" as const, peerCount: 1 }],
  ])("%s has no Back: the device's state decides the step, and a reload is the way back", (_step, status) => {
    localStorage.setItem("librepod-onboarding-welcome", "1")
    mockApi()
    page(status)
    expect(screen.queryByRole("button", { name: /^back$/i })).toBeNull()
  })

  it("a reload between install and the first peer resumes at Connect", () => {
    mockApi()
    localStorage.setItem("librepod-onboarding-welcome", "1")
    page({ ...claimed, vpnStatus: "running", peerCount: 0 })
    expect(screen.getByRole("heading", { name: /connect your first device/i })).toBeVisible()
  })

  it("a handshake leads to Graduate, the end of the road — no way back to make more keys", () => {
    mockApi()
    page({ ...claimed, vpnStatus: "running", peerCount: 1, lastHandshakeAt: "2026-10-14T10:00:00Z" })
    expect(screen.getByRole("link", { name: /open libre\.pod/i })).toHaveAttribute("href", "https://libre.pod")
    expect(screen.queryByRole("button")).toBeNull()
  })
})
