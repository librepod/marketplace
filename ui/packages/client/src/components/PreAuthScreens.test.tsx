import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { UseDomainScreen, WakingScreen } from "@/components/PreAuthScreens"
import type { OnboardingStatus } from "@librepod/shared"

const ready: OnboardingStatus = {
  mode: "ready", arrival: "ip", baseDomain: "libre.pod",
  casdoorUp: true, wgEasyUp: true, adminClaimed: true, peerCount: 1,
  lastHandshakeAt: "2026-09-05T10:00:00Z",
}

describe("PreAuthScreens", () => {
  it("WakingScreen names the raw-IP situation as normal", () => {
    render(<MemoryRouter><WakingScreen /></MemoryRouter>)
    expect(screen.getByText(/waking up/i)).toBeVisible()
    expect(screen.getByText(/raw device address/i)).toBeVisible()
  })

  it("UseDomainScreen leads with the domain and links CA + keys", () => {
    render(<MemoryRouter><UseDomainScreen status={ready} /></MemoryRouter>)
    expect(screen.getByText("libre.pod")).toBeVisible()
    expect(screen.getByRole("link", { name: /download root ca/i })).toHaveAttribute("href", "/api/bootstrap/ca")
    expect(screen.getByRole("link", { name: /connection keys/i })).toHaveAttribute("href", "/onboarding")
  })
})
