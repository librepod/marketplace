import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import type { OnboardingStatus } from "@librepod/shared"
import { NotSetUpScreen, UseDomainScreen, WakingScreen } from "@/components/PreAuthScreens"

const finished: OnboardingStatus = {
  state: "finished", arrival: "ip", baseDomain: "libre.pod", session: false, account: null, previousAccount: null,
  vpnStatus: null, peerCount: null, lastHandshakeAt: null, endpointSuggestion: null,
}

// The status-driven screens probe the domain over no-cors; jsdom has no real
// network, so an unmocked fetch would reject and flip screens mid-test.
beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(global, "fetch").mockResolvedValue({ ok: true, status: 200 } as Response)
})

describe("PreAuthScreens", () => {
  it("WakingScreen says the device is starting and the page updates itself", () => {
    render(<WakingScreen />)
    expect(screen.getByRole("heading", { name: /waking up/i })).toBeVisible()
    expect(screen.getByText(/updates itself/i)).toBeVisible()
  })

  it("NotSetUpScreen sends the visitor to the device's IP address", () => {
    render(<NotSetUpScreen />)
    expect(screen.getByRole("heading", { name: /isn't set up yet/i })).toBeVisible()
    expect(screen.getByText(/ip address/i)).toBeVisible()
  })

  it("UseDomainScreen, trusted: leads with the domain, links the root CA, offers no wizard", async () => {
    render(<UseDomainScreen status={finished} />)
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("https://libre.pod/api/health", expect.anything()))
    expect(screen.getByRole("heading", { name: "libre.pod" })).toBeVisible()
    expect(screen.getByRole("link", { name: /open libre\.pod/i })).toHaveAttribute("href", "https://libre.pod")
    expect(screen.getByRole("link", { name: /download root ca/i })).toHaveAttribute("href", "/api/bootstrap/ca")
    expect(screen.queryByRole("link", { name: /connection keys/i })).toBeNull()
  })

  it("UseDomainScreen, untrusted: the two-step helper — trust first, then the tunnel key", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new TypeError("Failed to fetch"))
    render(<UseDomainScreen status={finished} />)
    await waitFor(() => expect(screen.getByText(/two steps, in this order/i)).toBeVisible())
    expect(screen.getByRole("heading", { name: "libre.pod" })).toBeVisible()
    expect(screen.getByText(/^1 · Trust the device$/)).toBeVisible()
    expect(screen.getByRole("link", { name: /download root certificate/i })).toHaveAttribute("href", "/api/bootstrap/ca")
    expect(screen.getByText(/^2 · Connect this device$/)).toBeVisible()
    expect(screen.getByText(/wg-easy\.libre\.pod/)).toBeVisible()
    // A link to the domain would only land on an interstitial — the CTA is Check again.
    expect(screen.queryByRole("link", { name: /open libre\.pod/i })).toBeNull()
    expect(screen.getByRole("button", { name: /check again/i })).toBeVisible()
  })
})

