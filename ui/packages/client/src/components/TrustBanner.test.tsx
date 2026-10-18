import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { TrustBanner } from "@/components/TrustBanner"

vi.mock("@/hooks/useConfig", () => ({
  useConfig: () => ({ data: { baseDomain: "libre.pod" } }),
}))

const reject = () => vi.spyOn(global, "fetch").mockRejectedValue(new TypeError("Failed to fetch"))

beforeEach(() => vi.restoreAllMocks())

describe("TrustBanner", () => {
  it("an untrusted probe shows the strip; it probes id.<domain>, cross-origin from the app", async () => {
    const fetchSpy = reject()
    render(<TrustBanner />)
    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible())
    expect(fetchSpy).toHaveBeenCalledWith("https://id.libre.pod/", expect.anything())
    expect(screen.getByText(/doesn't trust this device's certificates/i)).toBeVisible()
  })

  it("expands the shared TrustSheet — download link and platform instructions", async () => {
    reject()
    render(<TrustBanner />)
    await waitFor(() => screen.getByRole("alert"))
    expect(screen.queryByText(/iPhone\/iPad/)).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /install the root certificate/i }))
    expect(screen.getByRole("link", { name: /download root certificate/i })).toHaveAttribute("href", "/api/bootstrap/ca")
    fireEvent.click(screen.getByText("How to install")) // the instructions live behind <details>
    expect(screen.getByText(/iPhone\/iPad/)).toBeVisible()
  })

  it("checkAgain after the CA is installed dismisses the strip for good", async () => {
    vi.spyOn(global, "fetch")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
    render(<TrustBanner />)
    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible())
    fireEvent.click(screen.getByRole("button", { name: /check again/i }))
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
  })

  it("a trusted probe renders nothing at all", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({ ok: true, status: 200 } as Response)
    render(<TrustBanner />)
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
