import { describe, it, expect, vi, afterEach } from "vitest"
import { screen, fireEvent, within } from "@testing-library/react"
import { UpdateSettingsCard } from "./UpdateSettingsCard"
import { deviceView } from "./fixtures"
import { renderCard, sentBody } from "./test-utils"

afterEach(() => vi.restoreAllMocks())

const stubZones = (zones: string[]) =>
  vi.spyOn(Intl, "supportedValuesOf").mockReturnValue(zones)

describe("UpdateSettingsCard", () => {
  it("shows channel, automatic updates and time zone from status", () => {
    renderCard((d) => <UpdateSettingsCard device={d} />)
    expect(screen.getByText("Stable")).toBeVisible()
    expect(screen.getByText("On")).toBeVisible()
    expect(screen.getByText("Europe/Minsk")).toBeVisible()
  })

  it("Change opens a dialog prefilled from status and PUTs all three", async () => {
    stubZones(["Europe/Minsk", "UTC"])
    const { fetchMock } = renderCard((d) => <UpdateSettingsCard device={d} />)
    fireEvent.click(screen.getByRole("button", { name: "Change" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("radio", { name: /Stable/ })).toBeChecked()
    fireEvent.click(within(dialog).getByRole("radio", { name: /Beta/ }))
    fireEvent.click(within(dialog).getByRole("switch", { name: "Automatic updates" }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toBe("/api/device/update-settings")
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PUT")
    expect(sentBody(fetchMock)).toEqual({ channel: "beta", auto: false, timezone: "Europe/Minsk" })
  })

  it("the device's zone stays selectable when the browser's list lacks it", async () => {
    stubZones(["Europe/Kyiv", "UTC"])
    const device = deviceView({ update: { state: "up-to-date", settings: { channel: "stable", auto: true, timezone: "Europe/Kiev" } } })
    renderCard((d) => <UpdateSettingsCard device={d} />, device)
    fireEvent.click(screen.getByRole("button", { name: "Change" }))
    const select = within(await screen.findByRole("dialog")).getByRole("combobox", { name: "Time zone" })
    expect(select).toHaveValue("Europe/Kiev")
  })

  it("a refused change shows the reason", () => {
    renderCard((d) => <UpdateSettingsCard device={d} />, deviceView({ rejected: { updates: "updates rev 4: the time zone is unknown" } }))
    expect(screen.getByText("The device refused your change: updates rev 4: the time zone is unknown")).toBeVisible()
  })
})
