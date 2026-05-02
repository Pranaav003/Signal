export function formatRelativeTime(createdUtc) {
  if (createdUtc == null) return '—'

  let sec = Number(createdUtc)
  if (!Number.isFinite(sec)) return '—'

  if (sec > 1e12) sec /= 1000

  const now = Math.floor(Date.now() / 1000)
  const diff = Math.max(0, now - sec)

  if (diff < 60) return `${diff}s`

  const m = Math.floor(diff / 60)

  if (m < 60) return `${m}m`

  const h = Math.floor(m / 60)

  if (h < 48) return `${h}h`

  const d = Math.floor(h / 24)

  if (d < 14) return `${d}d`

  const w = Math.floor(d / 7)

  return `${w}w`
}
