import { createBrowserRouter, Navigate } from "react-router-dom"
import { AppShell } from "./components/AppShell"
import { AuthGate } from "./components/AuthGate"
import { RootGate } from "./components/RootGate"
import { OnboardingPage } from "./pages/onboarding/OnboardingPage"
import { CatalogPage } from "./pages/CatalogPage"
import { AppDetailPage } from "./pages/AppDetailPage"
import { MyAppsPage } from "./pages/MyAppsPage"
import { NotFoundPage } from "./pages/NotFoundPage"

export const router = createBrowserRouter([
  {
    element: <RootGate />,
    children: [
      // Deep-linkable wizard (the UseDomainScreen "show my keys" affordance
      // and mid-tour reloads land here). Self-guards: outside onboarding it
      // redirects to /, where RootGate picks the right screen again.
      { path: "/onboarding", element: <OnboardingPage /> },
      {
        element: (
          <AuthGate>
            <AppShell />
          </AuthGate>
        ),
        children: [
          // The control plane is home: the daily action is opening an installed app.
          { path: "/", element: <MyAppsPage /> },
          { path: "/catalog", element: <CatalogPage /> },
          { path: "/apps/:name", element: <AppDetailPage /> },
          // Legacy alias — the installed grid used to live here.
          { path: "/my-apps", element: <Navigate to="/" replace /> },
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
])
