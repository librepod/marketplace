import { describe, it, expect } from "vitest"
import { formatAgo, formatBytes, keyLabel } from "./format"

const NOW = Date.parse("2026-11-16T12:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe("formatAgo", () => {
  it("says 'just now' under a minute and for a time in the future", () => {
    expect(formatAgo(ago(20_000), NOW)).toBe("just now")
    expect(formatAgo(ago(-120_000), NOW)).toBe("just now")
  })
  it("counts minutes and hours", () => {
    expect(formatAgo(ago(60_000), NOW)).toBe("1 min ago")
    expect(formatAgo(ago(42 * 60_000), NOW)).toBe("42 min ago")
    expect(formatAgo(ago(3 * 3_600_000), NOW)).toBe("3 h ago")
  })
})

describe("formatBytes", () => {
  it("uses decimal units, one decimal under 100", () => {
    expect(formatBytes(9.8e9)).toBe("9.8 GB")
    expect(formatBytes(412e9)).toBe("412 GB")
    expect(formatBytes(1.2e12)).toBe("1.2 TB")
  })
})

describe("keyLabel", () => {
  it("splits type and comment", () => {
    expect(keyLabel("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMq me@laptop")).toEqual({ type: "ssh-ed25519", name: "me@laptop" })
  })
  it("shortens the base64 when there is no comment", () => {
    expect(keyLabel("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMq")).toEqual({ type: "ssh-ed25519", name: "AAAAC3Nz…AIOMq" })
  })
})
