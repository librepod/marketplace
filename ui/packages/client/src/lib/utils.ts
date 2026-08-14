import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { CatalogApp } from "@librepod/shared"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * The public URL an installed app is reachable at. `baseDomain` is the same
 * value substituted into the app's templates at install time, so this matches
 * the Traefik IngressRoute host the app runs under (see AppDetailPage / the
 * installer's BASE_DOMAIN). Returns undefined until config has loaded.
 */
export function appUrl(name: string, baseDomain?: string): string | undefined {
  return baseDomain ? `https://${name}.${baseDomain}` : undefined
}

/**
 * The URL to open for an app, or `undefined` when it should not launch. Server
 * enrichment stamps `launchUrl` (Axis A override) and `launchable` (Axis B —
 * `false` only on a confident "no IngressRoute" read); we prefer the override,
 * fall back to the computed `https://<name>.<baseDomain>`, and suppress only on
 * an explicit `launchable === false`. Centralised so LaunchTile and
 * AppDetailPage stay in lockstep on the tri-state guard.
 */
export function launchUrlFor(app: CatalogApp, baseDomain?: string): string | undefined {
  if (app.launchable === false) return undefined
  return app.launchUrl ?? appUrl(app.name, baseDomain)
}
