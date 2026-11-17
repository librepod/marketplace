import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, within, fireEvent, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { DeviceView } from "@librepod/shared"
import { PowerControls } from "./PowerControls"
import { deviceView } from "./fixtures"

function setup(device: DeviceView) {
  const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue({
    ok: true, status: 200, json: async () => ({ os: "present", device }),
  } as Response)
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
  const ui = (d: DeviceView) => (
    <QueryClientProvider client={client}>
      <PowerControls device={d} />
    </QueryClientProvider>
  )
  const view = render(ui(device))
  return { fetchMock, rerender: (d: DeviceView) => view.rerender(ui(d)) }
}
const bodyOf = (m: ReturnType<typeof vi.spyOn>) => JSON.parse((m.mock.calls[0][1] as RequestInit).body as string)

afterEach(() => vi.restoreAllMocks())

describe("PowerControls", () => {
  it("Restart asks first, then posts { action: 'reboot' }", async () => {
    const { fetchMock } = setup(deviceView())
    fireEvent.click(screen.getByRole("button", { name: "Restart" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText("Restart your LibrePod?")).toBeVisible()
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole("button", { name: "Restart" }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toBe("/api/device/power")
    expect(bodyOf(fetchMock)).toEqual({ action: "reboot" })
  })

  it("Power off warns that someone must turn it back on", async () => {
    const { fetchMock } = setup(deviceView())
    fireEvent.click(screen.getByRole("button", { name: "Power off" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText(/someone has to be at the device to turn it back on/)).toBeVisible()
    fireEvent.click(within(dialog).getByRole("button", { name: "Power off" }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(bodyOf(fetchMock)).toEqual({ action: "poweroff" })
  })

  it.each([
    ["not reporting", { reporting: false }],
    ["an update installing", { update: { state: "installing" } }],
    ["power pending", { pending: { updates: false, install: false, power: true, sshKeys: false } }],
  ])("both are disabled while %s", (_n, over) => {
    setup(deviceView(over))
    expect(screen.getByRole("button", { name: "Restart" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Power off" })).toBeDisabled()
  })

  it("shows 'Restarting…' once the device takes this tab's restart, until it reports again", async () => {
    const t0 = "2026-11-16T12:00:00Z"
    const { rerender, fetchMock } = setup(deviceView({ reportedAt: t0 }))
    fireEvent.click(screen.getByRole("button", { name: "Restart" }))
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Restart" }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const pending = { updates: false, install: false, power: true, sshKeys: false }
    await act(async () => rerender(deviceView({ reportedAt: t0, pending })))
    await act(async () => rerender(deviceView({ reportedAt: t0 })))
    expect(screen.getByText(/Restarting…/)).toBeVisible()
    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull()) // the closing dialog's own Restart button
    expect(screen.getByRole("button", { name: "Restart" })).toBeDisabled()
    await act(async () => rerender(deviceView({ reportedAt: "2026-11-16T12:05:00Z" })))
    expect(screen.queryByText(/Restarting…/)).toBeNull()
    expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled()
  })

  it("a refused restart shows the device's reason, and no 'Restarting…'", () => {
    setup(deviceView({ rejected: { power: "an update is installing" } }))
    expect(screen.getByText("The device refused your restart: an update is installing.")).toBeVisible()
    expect(screen.queryByText(/Restarting…/)).toBeNull()
  })

  it("goes into 'Restarting…' straight from an accepted write, even if the agent handled it before the response", async () => {
    // the device already shows the answer handled (pending false) in the write's own response
    const { fetchMock } = setup(deviceView())
    fireEvent.click(screen.getByRole("button", { name: "Restart" }))
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Restart" }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(await screen.findByText(/Restarting…/)).toBeVisible()
  })
})
