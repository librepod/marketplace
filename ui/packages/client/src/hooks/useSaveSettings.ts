import { useMutation } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { toast } from 'sonner'
import type { InstallRequest } from '@librepod/shared'
import { toInstallError, type InstallError } from './useInstallApp'

/** Replace an installed app's settings. Errors show inline in the dialog, so no error toast. */
export function useSaveSettings(appName: string, displayName: string) {
  return useMutation<unknown, InstallError, InstallRequest>({
    mutationFn: async (request) => {
      const res = await apiFetch(`/api/apps/${appName}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
      if (!res.ok) throw await toInstallError(res)
      return res.json()
    },
    onSuccess: () => {
      toast.success('Settings saved', { description: `${displayName} picks them up the next time it starts.` })
    },
  })
}
