import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { version } from "../../../../package.json"
import { AppShell } from "@/components/AppShell"

// The shell spec targets the chrome (nav + footer); the banner and user menu
// carry their own query/fetch machinery and are covered by their own specs.
vi.mock("@/components/TrustBanner", () => ({ TrustBanner: () => null }))
vi.mock("@/components/UserMenu", () => ({ UserMenu: () => null }))

function renderShell(device: { ok: boolean; body?: unknown }) {
  vi.spyOn(global, "fetch").mockResolvedValue({
    ok: device.ok,
    status: device.ok ? 200 : 503,
    json: async () => device.body,
  } as Response)
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => vi.restoreAllMocks())

describe("AppShell", () => {
  it("shows the app version at the bottom of the screen", () => {
    renderShell({ ok: false })
    expect(screen.getByText(`LibrePod v${version}`)).toBeVisible()
  })

  it.each(["present", "starting"])("shows Device in the nav when the OS is %s", async (os) => {
    renderShell({ ok: true, body: { os } })
    expect(await screen.findByRole("link", { name: "Device" })).toHaveAttribute("href", "/device")
  })

  it.each([
    ["absent", { ok: true, body: { os: "absent" } }],
    ["failing", { ok: false }],
  ])("hides Device when /api/device is %s", async (_n, res) => {
    renderShell(res)
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole("link", { name: "Device" })).toBeNull()
  })
})
