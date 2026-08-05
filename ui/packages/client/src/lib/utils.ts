import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

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
