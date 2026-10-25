import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { AccountStep, ClaimStep, WelcomeStep } from "@/pages/onboarding/AccessSteps"

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

  it("claims with the setup code alone — no admin password in the story", () => {
    render(<WelcomeStep onBegin={vi.fn()} />)
    expect(screen.queryByText(/admin password/i)).toBeNull()
  })
})

describe("ClaimStep", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("needs only the setup code and posts { code }", async () => {
    const fetchMock = mockApi()
    const onClaimed = vi.fn()
    render(<ClaimStep resuming={false} onClaimed={onClaimed} />)
    expect(screen.queryByLabelText(/password/i)).toBeNull()
    const claim = screen.getByRole("button", { name: /claim this device/i })
    expect(claim).toBeDisabled()
    type("Setup code", "7kqm-x3rt-9vhc")
    fireEvent.click(claim)
    await vi.waitFor(() => expect(onClaimed).toHaveBeenCalled())
    expect(bodyOf(fetchMock, "/api/bootstrap/claim")).toEqual({ code: "7kqm-x3rt-9vhc" })
  })

  it("on a claimed device says setup has started and continues", () => {
    render(<ClaimStep resuming onClaimed={vi.fn()} />)
    expect(screen.getByText(/setup has started/i)).toBeVisible()
    expect(screen.getByRole("button", { name: /continue/i })).toBeVisible()
  })

  it("says where the code is", () => {
    render(<ClaimStep resuming={false} onClaimed={vi.fn()} />)
    expect(screen.getByText('kubectl -n marketplace-ui logs deploy/marketplace-ui | grep "setup code"')).toBeInTheDocument()
    // reset-onboarding prints its code to the exec stream, not the log the command above reads
    expect(screen.getByText(/use the code it printed instead/)).toBeInTheDocument()
  })

  it("a wrong code shows the server's reason and stays", async () => {
    mockApi({ "/api/bootstrap/claim": jsonResponse(403, { message: "That setup code isn't right" }) })
    const onClaimed = vi.fn()
    render(<ClaimStep resuming onClaimed={onClaimed} />)
    type("Setup code", "AAAA-BBBB-CCCC")
    fireEvent.click(screen.getByRole("button", { name: /continue/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent("That setup code isn't right")
    expect(onClaimed).not.toHaveBeenCalled()
  })
})

describe("AccountStep", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("no 'keep admin for emergencies' — this is the only password", () => {
    render(<AccountStep baseDomain="libre.pod" previousAccount={null} onDone={vi.fn()} onSessionLost={vi.fn()} />)
    expect(screen.queryByText(/emergencies/i)).toBeNull()
    expect(screen.getByText(/only password you'll need/i)).toBeVisible()
  })

  it("typing the recorded name under 'create a different account' warns it re-passwords that account", () => {
    render(<AccountStep baseDomain="libre.pod" previousAccount="owner" onDone={vi.fn()} onSessionLost={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/create a different account/i))
    type("Username", "owner")
    expect(screen.getByText(/your existing account/i)).toBeVisible()
    expect(screen.getByRole("button", { name: /set new password/i })).toBeVisible()
  })

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
    for (const name of ["admin", "al ex", "al_ex", "alex.", "-alex", "a..b", ""]) {
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
