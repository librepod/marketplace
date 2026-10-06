import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { toast } from 'sonner'
import type { FieldError, InstallRequest } from '@librepod/shared'

const FALLBACK_MESSAGE = 'Something went wrong. Try again.'

/** A failed install. `fieldErrors` is filled for a 400 with per-field problems. */
export class InstallError extends Error {
  readonly fieldErrors: FieldError[]

  constructor(message: string, fieldErrors: FieldError[] = []) {
    super(message)
    this.name = 'InstallError'
    this.fieldErrors = fieldErrors
  }
}

/**
 * Install an app. Call `mutate(undefined)` for a one-click install (no body), or
 * `mutate(request)` from the install dialog. The dialog shows its own errors, so only
 * one-click failures raise a toast.
 */
export function useInstallApp(appName: string, displayName: string) {
  const queryClient = useQueryClient()
  return useMutation<unknown, InstallError, InstallRequest | undefined>({
    mutationFn: async (request) => {
      const res = await apiFetch(`/api/apps/${appName}/install`, {
        method: 'POST',
        ...(request && {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: FALLBACK_MESSAGE }))
        throw new InstallError(
          body.message || FALLBACK_MESSAGE,
          Array.isArray(body.errors) ? body.errors : [],
        )
      }
      return res.json()
    },
    onSuccess: () => {
      toast.success('Install started', {
        description: `${displayName} is being deployed.`,
      })
      queryClient.invalidateQueries({ queryKey: ['apps'] })
      queryClient.invalidateQueries({ queryKey: ['apps', appName] })
      queryClient.invalidateQueries({ queryKey: ['installed'] })
    },
    onError: (error, request) => {
      if (request !== undefined) return // the install dialog shows it inline
      toast.error(`Couldn't install ${displayName}`, {
        description: error.message,
        duration: Infinity,
      })
    },
  })
}
