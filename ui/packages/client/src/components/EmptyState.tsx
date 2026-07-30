import { Button } from "@/components/ui/button"

export function EmptyState({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 mt-12 text-center">
      <h2 className="text-xl font-semibold">No apps available</h2>
      <p className="text-sm text-muted-foreground">
        We couldn't find any apps to install. If this is unexpected, your device may be offline.
      </p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>
      )}
    </div>
  )
}
