import { createBrowserRouter } from "react-router-dom"
import { AppShell } from "./components/AppShell"
import { CatalogPage } from "./pages/CatalogPage"
import { AppDetailPage } from "./pages/AppDetailPage"

export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <CatalogPage /> },
      { path: "/apps/:name", element: <AppDetailPage /> },
    ],
  },
])
