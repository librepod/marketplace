import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import type { OnboardingStatus } from "@librepod/shared"
import { RootGate } from "@/components/RootGate"
import { useBootstrapStatus } from "@/hooks/useBootstrapStatus"

vi.mock("@/hooks/useBootstrapStatus", () => ({ useBootstrapStatus: vi.fn() }))

const base: OnboardingStatus = {
  state: "waiting", arrival: "ip", baseDomain: "libre.pod", session: false, account: null, previousAccount: null,
  vpnStatus: null, peerCount: null, lastHandshakeAt: null, endpointSuggestion: null,
}

function gateWith(status: OnboardingStatus | undefined, isPending = false) {
  vi.mocked(useBootstrapStatus).mockReturnValue({ data: status, isPending, refetch: vi.fn() } as unknown as ReturnType<
    typeof useBootstrapStatus
  >)
  return render(
    <MemoryRouter initialEntries={["/catalog"]}>
      <Routes>
        <Route element={<RootGate />}>
          <Route path="*" element={<p>APP-MARKER</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe("RootGate — state × arrival", () => {
  beforeEach(() => localStorage.clear())

  it("pending: a spinner, never the app", () => {
    gateWith(undefined, true)
    expect(screen.queryByText("APP-MARKER")).toBeNull()
  })

  // The regression the whole flow exists for: no answer or a converging cluster
  // shows WakingScreen — never the app or an SSO bounce.
  it.each([
    ["no answer from the server", undefined],
    ["waiting, raw IP", { ...base, state: "waiting" as const }],
    ["waiting, domain", { ...base, state: "waiting" as const, arrival: "domain" as const }],
  ])("%s → WakingScreen", (_name, status) => {
    gateWith(status)
    expect(screen.getByRole("heading", { name: /waking up/i })).toBeVisible()
    expect(screen.queryByText("APP-MARKER")).toBeNull()
  })

  it("open, raw IP → the wizard, at any path", () => {
    gateWith({ ...base, state: "open" })
    expect(screen.getByText(/welcome to your librepod/i)).toBeVisible()
  })

  it("open, domain → not set up yet", () => {
    gateWith({ ...base, state: "open", arrival: "domain" })
    expect(screen.getByRole("heading", { name: /isn't set up yet/i })).toBeVisible()
  })

  it("claimed, raw IP, no setup session → Resume", () => {
    gateWith({ ...base, state: "claimed" })
    expect(screen.getByRole("heading", { name: /continue setting up/i })).toBeVisible()
  })

  it("claimed, raw IP, setup session → the wizard continues", () => {
    gateWith({ ...base, state: "claimed", session: true })
    expect(screen.getByRole("heading", { name: /create your account/i })).toBeVisible()
  })

  it("claimed, domain → the app (its SSO sign-in finishes onboarding)", () => {
    gateWith({ ...base, state: "claimed", arrival: "domain" })
    expect(screen.getByText("APP-MARKER")).toBeVisible()
  })

  it("finished, domain → the app", () => {
    gateWith({ ...base, state: "finished", arrival: "domain" })
    expect(screen.getByText("APP-MARKER")).toBeVisible()
  })

  it("finished, raw IP → UseDomainScreen, no wizard", () => {
    gateWith({ ...base, state: "finished" })
    expect(screen.getByRole("heading", { name: "libre.pod" })).toBeVisible()
    expect(screen.queryByText(/welcome to your librepod/i)).toBeNull()
  })
})
