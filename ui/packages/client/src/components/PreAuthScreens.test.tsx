import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import type { OnboardingStatus } from "@librepod/shared"
import { NotSetUpScreen, UseDomainScreen, WakingScreen } from "@/components/PreAuthScreens"

const finished: OnboardingStatus = {
  state: "finished", arrival: "ip", baseDomain: "libre.pod", session: false, account: null, previousAccount: null,
  vpnStatus: null, peerCount: null, lastHandshakeAt: null, endpointSuggestion: null,
}

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

  it("UseDomainScreen leads with the domain, links the root CA, and offers no wizard", () => {
    render(<UseDomainScreen status={finished} />)
    expect(screen.getByRole("heading", { name: "libre.pod" })).toBeVisible()
    expect(screen.getByRole("link", { name: /open libre\.pod/i })).toHaveAttribute("href", "https://libre.pod")
    expect(screen.getByRole("link", { name: /download root ca/i })).toHaveAttribute("href", "/api/bootstrap/ca")
    expect(screen.queryByRole("link", { name: /connection keys/i })).toBeNull()
  })
})
