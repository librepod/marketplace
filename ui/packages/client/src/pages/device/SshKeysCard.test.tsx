import { describe, it, expect, vi, afterEach } from "vitest"
import { screen, fireEvent, within } from "@testing-library/react"
import { SshKeysCard } from "./SshKeysCard"
import { deviceView } from "./fixtures"
import { renderCard, sentBody } from "./test-utils"

afterEach(() => vi.restoreAllMocks())

const K1 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMq me@laptop"
const K2 = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC phone"
const NEW = "ssh-ed25519 AAAAC3x me@x"
const card = (keys: string[], over = {}) => renderCard((d) => <SshKeysCard device={d} />, deviceView({ sshKeys: keys, ...over }))

async function openAdd() {
  fireEvent.click(screen.getByRole("button", { name: "Add key" }))
  return within(await screen.findByRole("dialog"))
}
const paste = (dialog: ReturnType<typeof within>, value: string) =>
  fireEvent.change(dialog.getByLabelText("Public key"), { target: { value } })

describe("SshKeysCard", () => {
  it("lists each key as type + name with a trash icon button", () => {
    card([K1, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMq"])
    expect(screen.getByRole("button", { name: "Remove me@laptop" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Remove AAAAC3Nz…AIOMq" })).toBeVisible()
  })

  it("removing a key PUTs the rest of the list, in order", async () => {
    const K3 = "ssh-ed25519 AAAAC3zzz third"
    const { fetchMock } = card([K1, K2, K3])
    fireEvent.click(screen.getByRole("button", { name: "Remove phone" }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toBe("/api/device/ssh-keys")
    expect(sentBody(fetchMock)).toEqual({ keys: [K1, K3] })
  })

  it("removing the last key asks first", async () => {
    const { fetchMock } = card([K1])
    fireEvent.click(screen.getByRole("button", { name: "Remove me@laptop" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText(/SSH will be off/)).toBeVisible()
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove key" }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(sentBody(fetchMock)).toEqual({ keys: [] })
  })

  it("Add key appends the pasted key", async () => {
    const { fetchMock } = card([K1])
    const dialog = await openAdd()
    paste(dialog, NEW)
    fireEvent.click(dialog.getByRole("button", { name: "Add" }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(sentBody(fetchMock)).toEqual({ keys: [K1, NEW] })
  })

  it("a pasted key with surrounding spaces, a trailing newline or CRLF is trimmed", async () => {
    const { fetchMock } = card([])
    const dialog = await openAdd()
    paste(dialog, `  ${NEW}\r\n`)
    fireEvent.click(dialog.getByRole("button", { name: "Add" }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(sentBody(fetchMock)).toEqual({ keys: [NEW] })
  })

  it.each([
    ["two keys pasted at once", `${K1}\n${K2}`, "Paste one key at a time"],
    ["a key already on the list (comment ignored)", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMq other-name", "That key is already on the list"],
    ["something that isn't a public key", "hello", "That doesn't look like a public key (it should start with ssh-ed25519, ssh-rsa or similar)"],
  ])("%s → refused, nothing sent", async (_n, value, message) => {
    const { fetchMock } = card([K1])
    const dialog = await openAdd()
    paste(dialog, value)
    fireEvent.click(dialog.getByRole("button", { name: "Add" }))
    expect(await dialog.findByText(message)).toBeVisible()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("33rd key → 'A LibrePod holds at most 32 keys'", async () => {
    const keys = Array.from({ length: 32 }, (_, i) => `ssh-ed25519 AAAAC3key${i} k${i}`)
    const { fetchMock } = card(keys)
    const dialog = await openAdd()
    paste(dialog, NEW)
    fireEvent.click(dialog.getByRole("button", { name: "Add" }))
    expect(await dialog.findByText("A LibrePod holds at most 32 keys")).toBeVisible()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("controls are disabled while sshKeys is pending", () => {
    card([K1], { pending: { updates: false, install: false, power: false, sshKeys: true } })
    expect(screen.getByRole("button", { name: "Add key" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Remove me@laptop" })).toBeDisabled()
    expect(screen.getByText("Sending to the device…")).toBeVisible()
  })

  it("a refused list shows the device's reason", () => {
    card([K1], { rejected: { sshKeys: "key 2 is not a public key" } })
    expect(screen.getByText("The device refused your key list: key 2 is not a public key")).toBeVisible()
  })

  it("the note reads 'These keys can log in as librepod. With none, SSH is off.'", () => {
    card([])
    expect(screen.getByText("These keys can log in as librepod. With none, SSH is off.")).toBeVisible()
  })
})
