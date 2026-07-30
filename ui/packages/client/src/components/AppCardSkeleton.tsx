import { Skeleton } from "@/components/ui/skeleton"

export function AppCardSkeleton() {
  return (
    <div
      className="rounded-xl bg-card p-4 ring-1 ring-foreground/10"
      style={{ height: 200 }}
      data-testid="app-card-skeleton"
    >
      <Skeleton className="h-12 w-12 rounded-md mb-4" />
      <Skeleton className="h-5 w-3/4 rounded mb-2" />
      <Skeleton className="h-10 w-full rounded" />
    </div>
  )
}
