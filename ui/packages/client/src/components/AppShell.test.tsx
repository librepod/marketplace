import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import { version } from "../../../../package.json"
import { AppShell } from "@/components/AppShell"

// The shell spec targets the chrome (nav + footer); the banner and user menu
// carry their own query/fetch machinery and are covered by their own specs.
vi.mock("@/components/TrustBanner", () => ({ TrustBanner: () => null }))
vi.mock("@/components/UserMenu", () => ({ UserMenu: () => null }))

function shell() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="*" element={<p>PAGE</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe("AppShell", () => {
  it("shows the app version at the bottom of the screen", () => {
    shell()
    // `version` is the workspace-root release (the value pinned in the image
    // tag), not the client package's own never-bumped 0.1.0.
    expect(screen.getByText(`LibrePod v${version}`)).toBeVisible()
  })
})
