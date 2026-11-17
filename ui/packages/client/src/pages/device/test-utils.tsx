import { vi } from "vitest"
import { render } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { DeviceView } from "@librepod/shared"
import { deviceView } from "./fixtures"

/** Renders a card with a query client; every write answers with `device`. */
export function renderCard(ui: (d: DeviceView) => React.ReactElement, device: DeviceView = deviceView()) {
  const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue({
    ok: true, status: 200, json: async () => ({ os: "present", device }),
  } as Response)
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
  const wrap = (d: DeviceView) => <QueryClientProvider client={client}>{ui(d)}</QueryClientProvider>
  const view = render(wrap(device))
  return { fetchMock, rerender: (d: DeviceView) => view.rerender(wrap(d)) }
}
export const sentBody = (m: { mock: { calls: unknown[][] } }, n = 0) =>
  JSON.parse((m.mock.calls[n][1] as RequestInit).body as string)
