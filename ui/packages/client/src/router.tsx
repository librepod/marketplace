import { createBrowserRouter, Navigate } from "react-router-dom"
import { AppShell } from "./components/AppShell"
import { AuthGate } from "./components/AuthGate"
import { CatalogPage } from "./pages/CatalogPage"
import { AppDetailPage } from "./pages/AppDetailPage"
import { MyAppsPage } from "./pages/MyAppsPage"
import { NotFoundPage } from "./pages/NotFoundPage"

export const router = createBrowserRouter([
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
])
