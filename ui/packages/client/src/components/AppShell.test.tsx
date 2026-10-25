import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { version } from "../../../../package.json"
import { AppShell } from "@/components/AppShell"

// The shell spec targets the chrome (nav + footer); the banner and user menu
// carry their own query/fetch machinery and are covered by their own specs.
vi.mock("@/components/TrustBanner", () => ({ TrustBanner: () => null }))
vi.mock("@/components/UserMenu", () => ({ UserMenu: () => null }))

describe("AppShell", () => {
  it("shows the app version at the bottom of the screen", () => {
    render(
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>,
    )
    expect(screen.getByText(`LibrePod v${version}`)).toBeVisible()
  })
})
