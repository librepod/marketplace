import { Search, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

interface CatalogToolbarProps {
  query: string
  category: string // "" = All
  categories: string[]
  onQueryChange: (q: string) => void
  onCategoryChange: (c: string) => void
}

export function CatalogToolbar({
  query,
  category,
  categories,
  onQueryChange,
  onCategoryChange,
}: CatalogToolbarProps) {
  return (
    <div className="mb-6 flex flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        {/* type="text" (not "search") so we control the clear affordance and
            avoid webkit rendering a second native clear button. */}
        <Input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search apps"
          aria-label="Search apps"
          className="pl-9 pr-9"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {categories.length > 0 && (
        <div
          role="group"
          aria-label="Filter by category"
          className="flex flex-wrap gap-2"
        >
          <CategoryChip active={category === ""} onClick={() => onCategoryChange("")}>
            All
          </CategoryChip>
          {categories.map((c) => (
            <CategoryChip
              key={c}
              active={category === c}
              onClick={() => onCategoryChange(c)}
            >
              {c}
            </CategoryChip>
          ))}
        </div>
      )}
    </div>
  )
}

function CategoryChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
        active
          ? "border-transparent bg-foreground text-background"
          : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}
