import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, render, screen, fireEvent } from "@testing-library/react"
import type { OnboardingStatus } from "@librepod/shared"
import { ConnectStep, GraduateStep, STUCK_AFTER_MS, TrustStep, VpnStep } from "@/pages/onboarding/ConnectivitySteps"

const status: OnboardingStatus = {
  state: "claimed", arrival: "ip", baseDomain: "libre.pod", session: true, account: "alex",
  previousAccount: null, vpnStatus: "not_installed", peerCount: null, lastHandshakeAt: null,
  endpointSuggestion: "192.168.1.50",
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}
function mockApi(routes: Record<string, Response> = {}) {
  return vi.spyOn(global, "fetch").mockImplementation(async (url) => routes[String(url)] ?? jsonResponse(200, {}))
}
function bodyOf(fetchMock: ReturnType<typeof mockApi>, url: string) {
  const call = fetchMock.mock.calls.find(([u]) => String(u) === url)
  return call ? JSON.parse(String(call[1]!.body)) : undefined
}
const noop = () => {}

describe("VpnStep", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("pre-fills the endpoint and installs WireGuard with it — never a password", async () => {
    const fetchMock = mockApi()
    const onWireguard = vi.fn()
    render(<VpnStep status={status} onWireguard={onWireguard} onOwn={noop} onSessionLost={noop} />)
    expect(screen.getByLabelText("Endpoint host")).toHaveValue("192.168.1.50")
    fireEvent.change(screen.getByLabelText("Endpoint host"), { target: { value: " 203.0.113.7 " } })
    fireEvent.click(screen.getByRole("button", { name: /set up wireguard/i }))
    await vi.waitFor(() => expect(onWireguard).toHaveBeenCalled())
    expect(bodyOf(fetchMock, "/api/bootstrap/install")).toEqual({ app: "wg-easy", settings: { INIT_HOST: "203.0.113.7" } })
  })

  it("an empty endpoint disables the install", () => {
    render(<VpnStep status={status} onWireguard={noop} onOwn={noop} onSessionLost={noop} />)
    fireEvent.change(screen.getByLabelText("Endpoint host"), { target: { value: "  " } })
    expect(screen.getByRole("button", { name: /set up wireguard/i })).toBeDisabled()
  })

  it("a 409 (already installed — e.g. a retry) counts as success", async () => {
    mockApi({ "/api/bootstrap/install": jsonResponse(409, { message: "WG Easy is already installed" }) })
    const onWireguard = vi.fn()
    render(<VpnStep status={status} onWireguard={onWireguard} onOwn={noop} onSessionLost={noop} />)
    fireEvent.click(screen.getByRole("button", { name: /set up wireguard/i }))
    await vi.waitFor(() => expect(onWireguard).toHaveBeenCalled())
  })

  it("an endpoint field error shows under the field; other errors show the server message", async () => {
    mockApi({
      "/api/bootstrap/install": jsonResponse(400, {
        message: "Some settings need attention", errors: [{ name: "INIT_HOST", message: "Too long (max 16 KiB)" }],
      }),
    })
    render(<VpnStep status={status} onWireguard={noop} onOwn={noop} onSessionLost={noop} />)
    fireEvent.click(screen.getByRole("button", { name: /set up wireguard/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Too long (max 16 KiB)")
  })

  it("a retryable server message (503) is shown and the step stays", async () => {
    mockApi({ "/api/bootstrap/install": jsonResponse(503, { message: "Couldn't determine this device's address. Try again in a minute." }) })
    render(<VpnStep status={status} onWireguard={noop} onOwn={noop} onSessionLost={noop} />)
    fireEvent.click(screen.getByRole("button", { name: /set up wireguard/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/try again in a minute/i)
    expect(screen.getByRole("heading", { name: /reach your librepod by name/i })).toBeVisible()
  })

  it('"I\'ll bring my own" takes the other path', () => {
    const onOwn = vi.fn()
    render(<VpnStep status={status} onWireguard={noop} onOwn={onOwn} onSessionLost={noop} />)
    fireEvent.click(screen.getByRole("button", { name: /i'll bring my own/i }))
    expect(onOwn).toHaveBeenCalled()
  })

  it("already installed: just continue", () => {
    const onWireguard = vi.fn()
    render(<VpnStep status={{ ...status, vpnStatus: "running" }} onWireguard={onWireguard} onOwn={noop} onSessionLost={noop} />)
    fireEvent.click(screen.getByRole("button", { name: /continue/i }))
    expect(onWireguard).toHaveBeenCalled()
  })

  it("a lost setup session (401) hands back to the page", async () => {
    mockApi({ "/api/bootstrap/install": jsonResponse(401, {}) })
    const onSessionLost = vi.fn()
    render(<VpnStep status={status} onWireguard={noop} onOwn={noop} onSessionLost={onSessionLost} />)
    fireEvent.click(screen.getByRole("button", { name: /set up wireguard/i }))
    await vi.waitFor(() => expect(onSessionLost).toHaveBeenCalled())
  })
})

describe("TrustStep", () => {
  beforeEach(() => localStorage.clear())

  it("offers the root CA and continues once installed", () => {
    const onDone = vi.fn()
    render(<TrustStep onDone={onDone} />)
    expect(screen.getByRole("link", { name: /download root certificate/i })).toHaveAttribute("href", "/api/bootstrap/ca")
    const go = screen.getByRole("button", { name: /continue/i })
    expect(go).toBeDisabled()
    fireEvent.click(screen.getByLabelText(/i installed the certificate/i))
    fireEvent.click(go)
    expect(onDone).toHaveBeenCalled()
  })
})

describe("ConnectStep", () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.useRealTimers())

  it("installing: progress, no key form, no peer polling", () => {
    const fetchMock = mockApi()
    render(<ConnectStep status={{ ...status, vpnStatus: "installing", peerCount: 0 }} onConnected={noop} onUseOwn={noop} onSessionLost={noop} />)
    expect(screen.getByText(/setting up wireguard/i)).toBeVisible()
    expect(screen.queryByRole("button", { name: /create connection key/i })).toBeNull()
    expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/bootstrap/wireguard")).toBe(false)
  })

  it("error: WireGuard couldn't start — offers my own connectivity", () => {
    mockApi()
    const onUseOwn = vi.fn()
    render(<ConnectStep status={{ ...status, vpnStatus: "error", peerCount: 0 }} onConnected={noop} onUseOwn={onUseOwn} onSessionLost={noop} />)
    expect(screen.getByText(/couldn't start on this device/i)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: /use my own connectivity instead/i }))
    expect(onUseOwn).toHaveBeenCalled()
  })

  it("installing for more than five minutes: the same fallback", () => {
    vi.useFakeTimers()
    mockApi()
    render(<ConnectStep status={{ ...status, vpnStatus: "installing", peerCount: 0 }} onConnected={noop} onUseOwn={noop} onSessionLost={noop} />)
    expect(screen.queryByText(/couldn't start on this device/i)).toBeNull()
    act(() => { vi.advanceTimersByTime(STUCK_AFTER_MS + 10_000) })
    expect(screen.getByRole("button", { name: /use my own connectivity instead/i })).toBeVisible()
  })

  it("running, no peers: creates a key and swaps the form for the QR", async () => {
    let peers: unknown[] = []
    vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      if (String(url) === "/api/bootstrap/wireguard/peer") {
        peers = [{ clientId: "c1", name: "phone", enabled: true, latestHandshakeAt: null }]
        return jsonResponse(200, { clientId: "c1", name: "phone" })
      }
      return jsonResponse(200, { peers })
    })
    render(<ConnectStep status={{ ...status, vpnStatus: "running", peerCount: 0 }} onConnected={noop} onUseOwn={noop} onSessionLost={noop} />)
    fireEvent.change(await screen.findByLabelText(/name this device/i), { target: { value: "phone" } })
    fireEvent.click(screen.getByRole("button", { name: /create connection key/i }))
    expect(await screen.findByAltText(/QR for phone/i)).toHaveAttribute("src", "/api/bootstrap/wireguard/clients/c1/qrcode.svg")
  })

  it("the server's message reaches the user instead of a bare status code", async () => {
    mockApi({
      "/api/bootstrap/wireguard": jsonResponse(200, { peers: [] }),
      "/api/bootstrap/wireguard/peer": jsonResponse(503, { message: "WireGuard rejected its admin password — it was changed in WireGuard itself." }),
    })
    render(<ConnectStep status={{ ...status, vpnStatus: "running", peerCount: 0 }} onConnected={noop} onUseOwn={noop} onSessionLost={noop} />)
    fireEvent.click(await screen.findByRole("button", { name: /create connection key/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/rejected its admin password/i)
  })

  it("with peers: the QR, plus a way to add another device", async () => {
    mockApi({
      "/api/bootstrap/wireguard": jsonResponse(200, { peers: [{ clientId: "c1", name: "phone", enabled: true, latestHandshakeAt: null }] }),
    })
    render(<ConnectStep status={{ ...status, vpnStatus: "running", peerCount: 1 }} onConnected={noop} onUseOwn={noop} onSessionLost={noop} />)
    expect(await screen.findByAltText(/QR for phone/i)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: /add another device/i }))
    expect(screen.getByRole("button", { name: /create connection key/i })).toBeVisible()
  })

  it("a handshake enables Continue", () => {
    mockApi()
    const onConnected = vi.fn()
    render(<ConnectStep status={{ ...status, vpnStatus: "running", peerCount: 1, lastHandshakeAt: "2026-10-14T10:00:00Z" }} onConnected={onConnected} onUseOwn={noop} onSessionLost={noop} />)
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }))
    expect(onConnected).toHaveBeenCalled()
  })
})

describe("GraduateStep", () => {
  it("WireGuard path: open the domain and sign in with the personal account", () => {
    const onAnotherDevice = vi.fn()
    render(<GraduateStep status={status} path="wireguard" onAnotherDevice={onAnotherDevice} />)
    expect(screen.getByRole("link", { name: /open libre\.pod/i })).toHaveAttribute("href", "https://libre.pod")
    expect(screen.getByText("alex@libre.pod")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: /connect another device/i }))
    expect(onAnotherDevice).toHaveBeenCalled()
  })

  it("bring-my-own path: the checklist", () => {
    render(<GraduateStep status={status} path="own" onAnotherDevice={noop} />)
    const list = screen.getByRole("list", { name: /before you sign in/i })
    expect(list).toHaveTextContent("*.libre.pod")
    expect(list).toHaveTextContent(/root certificate/i)
    expect(list).toHaveTextContent("alex@libre.pod")
    expect(screen.getByRole("link", { name: /open libre\.pod/i })).toHaveAttribute("href", "https://libre.pod")
  })
})
