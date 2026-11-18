import { describe, it, expect, vi, afterEach } from "vitest"
import { screen, fireEvent } from "@testing-library/react"
import { UpdatesCard } from "./UpdatesCard"
import { deviceView } from "./fixtures"
import { renderCard, sentBody } from "./test-utils"

afterEach(() => vi.restoreAllMocks())

const withUpdate = (update: object | null, over = {}) => deviceView({ update, ...over })
const settings = { channel: "stable" as const, auto: true, timezone: "Europe/Minsk" }

const ROWS: Array<[string, object | null, string, string[]]> = [
  ["no update", null, "Checking for updates…", []],
  ["up-to-date", { state: "up-to-date", current: "0.5.0" }, "Up to date", []],
  ["downloading", { state: "downloading", available: "0.5.1" }, "Downloading 0.5.1", []],
  ["ready", { state: "ready", available: "0.5.1", settings }, "0.5.1 is ready to install", ["Install now", "Install tonight"]],
  ["scheduled", { state: "scheduled", available: "0.5.1", installAt: "2026-11-17T02:13:00+03:00" }, "0.5.1 installs tonight at 02:13", ["Install now instead"]],
  ["installing", { state: "installing", available: "0.5.1" }, "Installing 0.5.1", []],
  ["done", { state: "done", current: "0.5.1" }, "Updated to 0.5.1", []],
  ["rolled-back", { state: "rolled-back", available: "0.5.1", current: "0.5.0" }, "0.5.1 didn't start, so 0.5.0 is back", ["Try 0.5.1 again"]],
  ["rolled-back, nothing to retry", { state: "rolled-back", current: "0.5.0" }, "Update status: rolled-back", []],
  ["failed", { state: "failed", available: "0.5.1" }, "0.5.1 didn't install", ["Try again"]],
  ["unknown state", { state: "weird" }, "Update status: weird", []],
  // Older LibrePod OS may omit any status field: never "undefined" on screen.
  ["no state", { current: "0.5.0" }, "Update status unknown", []],
  ["downloading, no version", { state: "downloading" }, "Downloading an update", []],
  ["ready, no version", { state: "ready", settings }, "An update is ready to install", ["Install now", "Install tonight"]],
  ["installing, no version", { state: "installing" }, "Installing an update", []],
  ["done, no version", { state: "done" }, "Updated", []],
  ["rolled-back, no current", { state: "rolled-back", available: "0.5.1" }, "0.5.1 didn't start, so the previous version is back", ["Try 0.5.1 again"]],
]
const ALL_BUTTONS = ["Install now", "Install tonight", "Install now instead", "Try 0.5.1 again", "Try again"]

describe("UpdatesCard", () => {
  it.each(ROWS)("%s", (_n, update, headline, buttons) => {
    renderCard((d) => <UpdatesCard device={d} />, withUpdate(update))
    expect(screen.getByText(headline)).toBeVisible()
    for (const b of ALL_BUTTONS) {
      const found = screen.queryByRole("button", { name: b })
      if (buttons.includes(b)) expect(found).not.toBeNull()
      else if (b !== "Install now" || !buttons.includes("Install now instead")) expect(found).toBeNull()
    }
  })

  it("shows the device's detail under the headline", () => {
    renderCard((d) => <UpdatesCard device={d} />, withUpdate({ state: "failed", available: "0.5.1", detail: "disk full" }))
    expect(screen.getByText("disk full")).toBeVisible()
  })

  it("ready shows the install window in the device's zone", () => {
    renderCard((d) => <UpdatesCard device={d} />, withUpdate({ state: "ready", available: "0.5.1", settings }))
    expect(screen.getByText("tonight = 02:00–05:00, Europe/Minsk")).toBeVisible()
  })

  it.each([
    ["Install now", "now"],
    ["Install tonight", "tonight"],
  ])("%s posts { when: %s }", async (label, when) => {
    const { fetchMock } = renderCard((d) => <UpdatesCard device={d} />, withUpdate({ state: "ready", available: "0.5.1", settings }))
    fireEvent.click(screen.getByRole("button", { name: label }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toBe("/api/device/install")
    expect(sentBody(fetchMock)).toEqual({ when })
  })

  it("install buttons are disabled while not reporting or pending", () => {
    const update = { state: "ready", available: "0.5.1", settings }
    const { rerender } = renderCard((d) => <UpdatesCard device={d} />, withUpdate(update, { reporting: false }))
    expect(screen.getByRole("button", { name: "Install now" })).toBeDisabled()
    rerender(withUpdate(update, { pending: { updates: false, install: true, power: false, sshKeys: false } }))
    expect(screen.getByRole("button", { name: "Install tonight" })).toBeDisabled()
    expect(screen.getByText("Sending to the device…")).toBeVisible()
  })

  it("a refused install shows the device's reason", () => {
    renderCard((d) => <UpdatesCard device={d} />, withUpdate({ state: "ready", available: "0.5.1", settings }, { rejected: { install: "when is not now or tonight" } }))
    expect(screen.getByText("The device refused your install: when is not now or tonight")).toBeVisible()
  })

  it("a failed version reads 'failed last time — try again'", () => {
    renderCard((d) => <UpdatesCard device={d} />, withUpdate({ state: "ready", available: "0.5.1", failedVersions: ["0.5.1"], settings }))
    expect(screen.getByText("0.5.1 failed last time — try again")).toBeVisible()
    expect(screen.getByRole("button", { name: "Install now" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Install tonight" })).toBeVisible()
  })
})
