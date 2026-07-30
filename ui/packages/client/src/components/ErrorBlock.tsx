import { AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"

interface ErrorBlockProps {
  onRetry: () => void
}

export function ErrorBlock({ onRetry }: ErrorBlockProps) {
  return (
    <div className="flex flex-col items-center gap-3 mt-12 text-center">
      <AlertCircle className="h-5 w-5 text-destructive" />
      <h2 className="text-xl font-semibold">Failed to load apps</h2>
      <p className="text-sm text-muted-foreground">Check your connection and try again.</p>
      <Button variant="outline" size="sm" onClick={onRetry}>Retry Loading</Button>
    </div>
  )
}
