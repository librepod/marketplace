import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { AccountStep, ClaimStep, ResumeScreen, WelcomeStep } from "@/pages/onboarding/AccessSteps"

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

/** Answers by URL; anything else gets 200 {}. */
function mockApi(routes: Record<string, Response> = {}) {
  return vi.spyOn(global, "fetch").mockImplementation(async (url) => routes[String(url)] ?? jsonResponse(200, {}))
}

function bodyOf(fetchMock: ReturnType<typeof mockApi>, url: string) {
  const call = fetchMock.mock.calls.find(([u]) => String(u) === url)
  return call ? JSON.parse(String(call[1]!.body)) : undefined
}

const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

describe("WelcomeStep", () => {
  it("explains the steps and begins", () => {
    const onBegin = vi.fn()
    render(<WelcomeStep onBegin={onBegin} />)
    expect(screen.getByText(/welcome to your librepod/i)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: /begin/i }))
    expect(onBegin).toHaveBeenCalled()
  })
})

describe("ClaimStep", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("needs a setup code and a valid, confirmed admin password", () => {
    render(<ClaimStep onClaimed={vi.fn()} />)
    const claim = screen.getByRole("button", { name: /claim this device/i })
    type("Admin password", "correct-horse-12")
    type("Confirm admin password", "correct-horse-12")
    expect(claim).toBeDisabled() // no code yet
    type("Setup code", "7KQM-X3RT-9VHC")
    expect(claim).toBeEnabled()
    type("Admin password", "elevenchars")
    type("Confirm admin password", "elevenchars")
    expect(claim).toBeDisabled()
    type("Admin password", "correct horse12")
    type("Confirm admin password", "correct horse12")
    expect(claim).toBeDisabled()
  })

  it("says where the code is", () => {
    render(<ClaimStep onClaimed={vi.fn()} />)
    expect(screen.getByText('kubectl -n marketplace-ui logs deploy/marketplace-ui | grep "setup code"')).toBeInTheDocument()
    // reset-onboarding prints its code to the exec stream, not the log the command above reads
    expect(screen.getByText(/use the code it printed instead/)).toBeInTheDocument()
  })

  it("posts the code and password, then hands over", async () => {
    const fetchMock = mockApi()
    const onClaimed = vi.fn()
    render(<ClaimStep onClaimed={onClaimed} />)
    type("Setup code", "7kqm-x3rt-9vhc")
    type("Admin password", "correct-horse-12")
    type("Confirm admin password", "correct-horse-12")
    fireEvent.click(screen.getByRole("button", { name: /claim this device/i }))
    await vi.waitFor(() => expect(onClaimed).toHaveBeenCalled())
    expect(bodyOf(fetchMock, "/api/bootstrap/claim")).toEqual({ code: "7kqm-x3rt-9vhc", password: "correct-horse-12" })
  })

  it("shows the server's reason and stays", async () => {
    mockApi({ "/api/bootstrap/claim": jsonResponse(403, { message: "That setup code isn't right" }) })
    const onClaimed = vi.fn()
    render(<ClaimStep onClaimed={onClaimed} />)
    type("Setup code", "AAAA-BBBB-CCCC")
    type("Admin password", "correct-horse-12")
    type("Confirm admin password", "correct-horse-12")
    fireEvent.click(screen.getByRole("button", { name: /claim this device/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent("That setup code isn't right")
    expect(onClaimed).not.toHaveBeenCalled()
  })
})

describe("ResumeScreen", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("posts the code and resumes", async () => {
    const fetchMock = mockApi()
    const onResumed = vi.fn()
    render(<ResumeScreen onResumed={onResumed} />)
    expect(screen.getByRole("heading", { name: /continue setting up/i })).toBeVisible()
    type("Setup code", "7KQM-X3RT-9VHC")
    fireEvent.click(screen.getByRole("button", { name: /continue/i }))
    await vi.waitFor(() => expect(onResumed).toHaveBeenCalled())
    expect(bodyOf(fetchMock, "/api/bootstrap/resume")).toEqual({ code: "7KQM-X3RT-9VHC" })
  })

  it("a wrong code shows the reason", async () => {
    mockApi({ "/api/bootstrap/resume": jsonResponse(403, { message: "That setup code isn't right" }) })
    render(<ResumeScreen onResumed={vi.fn()} />)
    type("Setup code", "AAAA-BBBB-CCCC")
    fireEvent.click(screen.getByRole("button", { name: /continue/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent("That setup code isn't right")
  })
})

describe("AccountStep", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("a new account: lowercase username and a confirmed password", async () => {
    const fetchMock = mockApi()
    const onDone = vi.fn()
    render(<AccountStep baseDomain="libre.pod" previousAccount={null} onDone={onDone} onSessionLost={vi.fn()} />)
    type("Username", "Alex")
    expect(screen.getByText("alex@libre.pod")).toBeVisible()
    type("Password", "personal-pass-12")
    type("Confirm password", "personal-pass-12")
    fireEvent.click(screen.getByRole("button", { name: /create account/i }))
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(bodyOf(fetchMock, "/api/bootstrap/account")).toEqual({ username: "alex", password: "personal-pass-12" })
  })

  it('"admin" and invalid characters are refused before posting', () => {
    render(<AccountStep baseDomain="libre.pod" previousAccount={null} onDone={vi.fn()} onSessionLost={vi.fn()} />)
    type("Password", "personal-pass-12")
    type("Confirm password", "personal-pass-12")
    const create = screen.getByRole("button", { name: /create account/i })
    for (const name of ["admin", "al ex", "al_ex", ""]) {
      type("Username", name)
      expect(create).toBeDisabled()
    }
  })

  it("after a reset: keep the account as is — no password sent", async () => {
    const fetchMock = mockApi()
    const onDone = vi.fn()
    render(<AccountStep baseDomain="libre.pod" previousAccount="alex" onDone={onDone} onSessionLost={vi.fn()} />)
    expect(screen.getByLabelText(/keep alex/i)).toBeChecked()
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }))
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(bodyOf(fetchMock, "/api/bootstrap/account")).toEqual({ username: "alex" })
  })

  it("after a reset: keep the account with a new password (the forgotten-password recovery)", async () => {
    const fetchMock = mockApi()
    render(<AccountStep baseDomain="libre.pod" previousAccount="alex" onDone={vi.fn()} onSessionLost={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/set a new password for alex/i))
    const go = screen.getByRole("button", { name: /^continue$/i })
    expect(go).toBeDisabled()
    type("Password", "brand-new-pass-12")
    type("Confirm password", "brand-new-pass-12")
    fireEvent.click(go)
    await vi.waitFor(() =>
      expect(bodyOf(fetchMock, "/api/bootstrap/account")).toEqual({ username: "alex", password: "brand-new-pass-12" }),
    )
  })

  it("after a reset: a different account shows the username field", () => {
    render(<AccountStep baseDomain="libre.pod" previousAccount="alex" onDone={vi.fn()} onSessionLost={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/create a different account/i))
    expect(screen.getByLabelText("Username")).toBeVisible()
  })

  it("a lost setup session (401) hands back to the page", async () => {
    mockApi({ "/api/bootstrap/account": jsonResponse(401, { message: "Unauthorized" }) })
    const onSessionLost = vi.fn()
    render(<AccountStep baseDomain="libre.pod" previousAccount="alex" onDone={vi.fn()} onSessionLost={onSessionLost} />)
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }))
    await vi.waitFor(() => expect(onSessionLost).toHaveBeenCalled())
  })
})
