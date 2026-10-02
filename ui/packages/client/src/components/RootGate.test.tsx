import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { RootGate } from "@/components/RootGate"
import { useBootstrapStatus } from "@/hooks/useBootstrapStatus"
import type { OnboardingStatus } from "@librepod/shared"

vi.mock("@/hooks/useBootstrapStatus", () => ({ useBootstrapStatus: vi.fn() }))

const base: OnboardingStatus = {
  mode: "waiting", arrival: "ip", baseDomain: "libre.pod",
  casdoorUp: false, wgEasyUp: false, adminClaimed: null, peerCount: null, lastHandshakeAt: null,
}

function gateWith(status: OnboardingStatus | undefined, isPending = false) {
  vi.mocked(useBootstrapStatus).mockReturnValue({ data: status, isPending } as ReturnType<typeof useBootstrapStatus>)
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route element={<RootGate />}>
          <Route path="/" element={<p>APP-MARKER</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe("RootGate", () => {
  beforeEach(() => localStorage.clear())

  // The regression the whole flow exists for: a fresh cluster (casdoor still
  // converging) must show the WakingScreen, never the app or an SSO bounce.
  it("waiting → WakingScreen owns the first paint", () => {
    gateWith({ ...base, mode: "waiting" })
    expect(screen.getByRole("heading", { name: /waking up/i })).toBeVisible()
    expect(screen.queryByText("APP-MARKER")).toBeNull()
  })

  it("onboarding → the wizard owns the screen", () => {
    gateWith({ ...base, mode: "onboarding" })
    expect(screen.getByText(/welcome to your librepod/i)).toBeVisible()
  })

  it("ready + domain arrival → the authenticated app (Outlet)", () => {
    gateWith({ ...base, mode: "ready", arrival: "domain" })
    expect(screen.getByText("APP-MARKER")).toBeVisible()
  })

  it("ready + ip + handshake seen → UseDomainScreen", () => {
    gateWith({
      ...base, mode: "ready", arrival: "ip", adminClaimed: true, peerCount: 1,
      lastHandshakeAt: "2026-09-05T10:00:00Z",
    })
    expect(screen.getByText(/has a name/i)).toBeVisible()
  })

  it("ready + ip, no handshake yet → wizard resumes at Connect", () => {
    gateWith({ ...base, mode: "ready", arrival: "ip", adminClaimed: true, peerCount: 1 })
    expect(screen.getByRole("heading", { name: /connect your first device/i })).toBeVisible()
  })
})
