// The "Soon" pill for roadmap items (device controls, Users nav). A quiet
// muted chip in the Workbench's label register — it marks intent without
// competing with anything that actually works.
export function SoonTag() {
  return (
    <span className="inline-flex h-[1.125rem] items-center rounded-full bg-muted px-1.5 text-xs font-medium leading-none text-muted-foreground">
      Soon
    </span>
  )
}
