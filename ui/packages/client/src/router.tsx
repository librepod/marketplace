import { createBrowserRouter } from "react-router-dom"
import { AppShell } from "./components/AppShell"
import { CatalogPage } from "./pages/CatalogPage"
import { AppDetailPage } from "./pages/AppDetailPage"
import { MyAppsPage } from "./pages/MyAppsPage"
import { NotFoundPage } from "./pages/NotFoundPage"

export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <CatalogPage /> },
      { path: "/apps/:name", element: <AppDetailPage /> },
      { path: "/my-apps", element: <MyAppsPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
])
