import React from "react"

interface AppIconProps {
  src: string
  name: string
  size: 48 | 80
}

export function AppIcon({ src, name, size }: AppIconProps) {
  const [failed, setFailed] = React.useState(false)
  const initial = name.charAt(0).toUpperCase()

  if (failed) {
    return (
      <div
        className="flex items-center justify-center rounded-md bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 font-semibold text-xl"
        style={{ width: size, height: size }}
      >
        {initial}
      </div>
    )
  }

  return (
    <img
      src={src}
      alt={name}
      width={size}
      height={size}
      className="rounded-md object-contain"
      onError={() => setFailed(true)}
    />
  )
}
