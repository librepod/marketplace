import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { HealthTiles } from "./HealthTiles"
import { deviceView } from "./fixtures"

describe("HealthTiles", () => {
  it("a disk with no reported size reads '—', never '0%'", () => {
    render(<HealthTiles device={deviceView({ rootDisk: { sizeBytes: 0, usedBytes: 9.8e9 }, dataDisk: { present: true } })} />)
    expect(screen.queryByText("0%")).toBeNull()
    expect(screen.getAllByText("—")).toHaveLength(2)
  })

  it("a disk with a size reads its share used", () => {
    render(<HealthTiles device={deviceView()} />)
    expect(screen.getByText("31%")).toBeVisible() // 9.8 of 32 GB
    expect(screen.getByText("86%")).toBeVisible() // 412 of 480 GB
  })
})
