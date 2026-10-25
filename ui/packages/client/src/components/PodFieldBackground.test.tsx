import { describe, expect, it } from "vitest"
import { render } from "@testing-library/react"
import { PodFieldBackground } from "@/components/PodFieldBackground"

// jsdom has no canvas 2d context, so the engine stays inert here — these
// checks cover the mount contract (decorative, non-interactive, unmounts
// cleanly); the paint itself is reviewed against the approved prototype.
describe("PodFieldBackground", () => {
  it("renders a decorative fixed layer that never takes pointer events or focus", () => {
    const { container } = render(<PodFieldBackground />)
    const el = container.firstElementChild as HTMLElement
    expect(el.getAttribute("aria-hidden")).toBe("true")
    expect(el.className).toContain("pointer-events-none")
    expect(el.querySelector("canvas")).not.toBeNull()
  })

  it("unmounts cleanly without a 2d context (jsdom)", () => {
    const { unmount } = render(<PodFieldBackground />)
    expect(() => unmount()).not.toThrow()
  })
})
