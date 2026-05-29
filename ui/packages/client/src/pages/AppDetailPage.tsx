import { useParams, Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import type { CatalogApp } from "@librepod/shared"
import { AppIcon } from "@/components/AppIcon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import { ErrorBlock } from "@/components/ErrorBlock"
import { StatusBadge } from "@/components/StatusBadge"
import { Loader2 } from "lucide-react"
import { useInstallApp } from "@/hooks/useInstallApp"
import { useUninstallApp } from "@/hooks/useUninstallApp"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"

function DetailSkeleton() {
  return (
    <div className="mx-auto max-w-2xl">
      <Skeleton className="h-4 w-32 mb-6" />
      <Skeleton className="h-20 w-20 rounded-md mb-4" />
      <Skeleton className="h-8 w-1/2 mb-2" />
      <Skeleton className="h-4 w-1/4 mb-6" />
      <Skeleton className="h-24 w-full" />
    </div>
  )
}

function NotFoundBlock() {
  return (
    <div className="mx-auto max-w-2xl text-center mt-12">
      <h2 className="text-xl font-semibold">App not found</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        This app doesn&apos;t exist in the catalog.
      </p>
      <Link to="/" className="mt-4 inline-block text-sm text-muted-foreground hover:underline">
        ← Back to catalog
      </Link>
    </div>
  )
}

export function AppDetailPage() {
  const { name } = useParams<{ name: string }>()

  const { isPending, isError, error, data, refetch } = useQuery<CatalogApp>({
    queryKey: ["apps", name],
    queryFn: async () => {
      const res = await fetch(`/api/apps/${name}`)
      if (res.status === 404) throw new Error("NOT_FOUND")
      if (!res.ok) throw new Error("Failed to fetch app")
      return res.json()
    },
    retry: 0,
    enabled: !!name,
  })

  const installMutation = useInstallApp(name ?? '', data?.displayName ?? '')
  const uninstallMutation = useUninstallApp(name ?? '', data?.displayName ?? '')

  if (!name) return <NotFoundBlock />
  if (isPending) return <DetailSkeleton />
  if (isError && (error as Error)?.message === "NOT_FOUND") return <NotFoundBlock />
  if (isError) return <ErrorBlock onRetry={() => void refetch()} />
  if (!data) return <NotFoundBlock />

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        to="/"
        className="text-sm text-muted-foreground hover:underline"
      >
        ← Back to catalog
      </Link>

      <div className="mt-4 rounded-lg border border-border bg-card p-8">
        <AppIcon src={data.icon} name={data.displayName} size={80} />

        <h1 className="mt-4 text-[28px] font-semibold leading-[1.2]">
          {data.displayName}
        </h1>

        <div className="mt-2 flex items-center gap-3">
          <Badge variant="secondary">{data.category}</Badge>
          <span className="text-sm text-muted-foreground">
            {data.version}
          </span>
        </div>

        {data.installedStatus && data.installedStatus !== 'not_installed' && (
          <div className="mt-3">
            <StatusBadge status={data.installedStatus} />
          </div>
        )}

        <Separator className="my-6" />

        <p className="text-sm leading-relaxed">{data.description}</p>

        <div className="mt-4">
          {/^(?:https?|oci|git):\/\//.test(data.sourceUrl) && (
            <a
              href={data.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline text-muted-foreground hover:text-foreground"
            >
              View source
            </a>
          )}
        </div>

        <div className="mt-8">
          {(!data.installedStatus || data.installedStatus === 'not_installed') && (
            <Button
              onClick={() => installMutation.mutate()}
              disabled={installMutation.isPending}
            >
              {installMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {installMutation.isPending ? 'Installing...' : 'Install App'}
            </Button>
          )}

          {data.installedStatus === 'installing' && (
            <Button disabled>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Installing...
            </Button>
          )}

          {(data.installedStatus === 'running' || data.installedStatus === 'error') && (
            <AlertDialog>
              <AlertDialogTrigger
                className="inline-flex"
              >
                <Button
                  variant="destructive"
                  disabled={uninstallMutation.isPending}
                >
                  {uninstallMutation.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {uninstallMutation.isPending ? 'Uninstalling...' : 'Uninstall App'}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Uninstall {data.displayName}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will remove {data.displayName} and all its data from your server.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep App</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => uninstallMutation.mutate()}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Uninstall App
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>
    </div>
  )
}
