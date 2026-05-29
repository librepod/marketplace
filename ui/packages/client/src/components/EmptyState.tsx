export function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 mt-12 text-center">
      <h2 className="text-xl font-semibold">No apps available</h2>
      <p className="text-sm text-muted-foreground">The app catalog is empty. Check back later.</p>
    </div>
  )
}
