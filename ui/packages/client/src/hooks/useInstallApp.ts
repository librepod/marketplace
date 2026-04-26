import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

export function useInstallApp(appName: string, displayName: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/apps/${appName}/install`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: 'Something went wrong. Try again.' }))
        throw new Error(body.message || 'Something went wrong. Try again.')
      }
      return res.json()
    },
    onSuccess: () => {
      toast.success('Installed', {
        description: `${displayName} is being deployed`,
      })
      queryClient.invalidateQueries({ queryKey: ['apps'] })
      queryClient.invalidateQueries({ queryKey: ['apps', appName] })
      queryClient.invalidateQueries({ queryKey: ['installed'] })
    },
    onError: (error: Error) => {
      toast.error('Error', {
        description: error.message,
        duration: Infinity,
      })
    },
  })
}
