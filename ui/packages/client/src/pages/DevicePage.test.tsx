import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { DeviceInfo } from "@librepod/shared"
import { DevicePage } from "./DevicePage"
import { deviceView } from "./device/fixtures"

function renderPage(info: DeviceInfo) {
  vi.spyOn(global, "fetch").mockResolvedValue({ ok: true, status: 200, json: async () => info } as Response)
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/device"]}>
        <Routes>
          <Route path="/" element={<div>home</div>} />
          <Route path="/device" element={<DevicePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
const present = (over = {}): DeviceInfo => ({ os: "present", device: deviceView(over) })

afterEach(() => vi.restoreAllMocks())

describe("DevicePage", () => {
  it("renders version and reported time", async () => {
    renderPage(present({ reportedAt: new Date(Date.now() - 2 * 60_000).toISOString() }))
    expect(await screen.findByText(/LibrePod OS 0\.5\.0/)).toBeVisible()
    expect(screen.getByText(/reported 2 min ago/)).toBeVisible()
  })

  it("renders the four tiles", async () => {
    renderPage(present())
    expect(await screen.findByText("CPU")).toBeVisible()
    expect(screen.getByText("12%")).toBeVisible()
    expect(screen.getByText("Memory")).toBeVisible()
    expect(screen.getByText("System disk")).toBeVisible()
    expect(screen.getByText("Data disk")).toBeVisible()
  })

  it("a bare Device renders dashes and 'Checking for updates…'", async () => {
    renderPage({
      os: "present",
      device: deviceView({ reportedAt: null, reporting: false, version: null, rootDisk: null, dataDisk: null, update: null, metrics: null }),
    })
    expect(await screen.findByText("CPU")).toBeVisible()
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4)
  })

  it("amber banner when not reporting", async () => {
    renderPage(present({ reporting: false, reportedAt: "2026-11-16T10:00:00Z" }))
    expect(await screen.findByText(/Your LibrePod hasn't reported since/)).toBeVisible()
  })

  it("red banner and 'Missing' tile when the data disk is missing", async () => {
    renderPage(present({ dataDisk: { present: false } }))
    expect(await screen.findByText("The data disk is missing.")).toBeVisible()
    expect(screen.getByText("Missing")).toBeVisible()
  })

  it("starting shows 'Your LibrePod is still starting up'", async () => {
    renderPage({ os: "starting" })
    expect(await screen.findByText(/Your LibrePod is still starting up/)).toBeVisible()
  })

  it("absent redirects to /", async () => {
    renderPage({ os: "absent" })
    expect(await screen.findByText("home")).toBeVisible()
  })
})
