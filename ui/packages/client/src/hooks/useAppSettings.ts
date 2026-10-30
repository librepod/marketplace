import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import type { AppSettingsValues } from '@librepod/shared'

/**
 * An app's stored install answers (generated secrets excluded), to prefill the settings
 * dialog. Read fresh on every open (gcTime 0): a stale copy would save over newer values.
 */
export function useAppSettings(appName: string, enabled = true) {
  return useQuery<AppSettingsValues>({
    queryKey: ['apps', appName, 'settings'],
    queryFn: async () => {
      const res = await apiFetch(`/api/apps/${appName}/settings`)
      if (!res.ok) throw new Error(`Failed to load settings (${res.status})`)
      return res.json()
    },
    enabled,
    gcTime: 0,
    retry: 0,
  })
}
