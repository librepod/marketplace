/** Decimal GB/TB, one decimal under 100. */
export function formatBytes(n: number): string {
  const [v, unit] = n >= 1e12 ? [n / 1e12, "TB"] : n >= 1e9 ? [n / 1e9, "GB"] : [n / 1e6, "MB"]
  return `${v < 100 ? v.toFixed(1) : Math.round(v)} ${unit}`
}

/** A time in the browser's future (clock skew) reads "just now", never "-2 min ago". */
export function formatAgo(iso: string, now: number): string {
  const min = Math.floor((now - Date.parse(iso)) / 60_000)
  if (!(min >= 1)) return "just now"
  return min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ago`
}

export function keyLabel(key: string): { type: string; name: string } {
  const [type, b64 = "", ...comment] = key.split(" ")
  const name = comment.join(" ") || (b64.length > 13 ? `${b64.slice(0, 8)}…${b64.slice(-5)}` : b64)
  return { type, name }
}
