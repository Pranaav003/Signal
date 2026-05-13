import { formatRelativeTime } from '../lib/time'

function lastCheckedLabel(iso) {
  if (!iso) return 'never'
  const sec = Math.floor(new Date(iso).getTime() / 1000)
  const r = formatRelativeTime(sec)
  return r === '—' ? '—' : `${r} ago`
}

function upvoteColor(n) {
  if (n > 0) return 'var(--green)'
  if (n < 0) return 'var(--red)'
  return 'var(--text-3)'
}

function StatPill({ value, label, valueColor }) {
  return (
    <div className="flex flex-col items-center" style={{ minWidth: 56 }}>
      <span
        className="font-mono font-bold"
        style={{ fontSize: 18, color: valueColor ?? 'var(--text)' }}
      >
        {value}
      </span>
      <span
        className="mt-0.5 text-center"
        style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}
      >
        {label}
      </span>
    </div>
  )
}

export default function TrackedReplyStats({ tracked }) {
  if (!tracked) return null

  const st = String(tracked.status ?? 'active')
  const warn = st === 'removed' || st === 'deleted'

  return (
    <div
      className="mt-3 border-t pt-3"
      style={{ borderColor: 'var(--border)', marginTop: 12, paddingTop: 12 }}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className="font-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.1em',
              color: 'var(--green)',
            }}
          >
            TRACKING
          </span>
          <span className="signal-track-dot" aria-hidden />
        </div>
        <span className="font-mono" style={{ fontSize: 10, color: 'var(--text-3)' }}>
          last checked {lastCheckedLabel(tracked.last_checked_at)}
        </span>
      </div>

      <div className="flex flex-wrap justify-between gap-6" style={{ gap: 24 }}>
        <StatPill
          value={tracked.upvotes ?? 0}
          label="upvotes"
          valueColor={upvoteColor(Number(tracked.upvotes ?? 0))}
        />
        <StatPill value={tracked.reply_count ?? 0} label="replies" />
        <StatPill value={tracked.thread_upvotes ?? 0} label="post score" />
        <StatPill value={tracked.thread_reply_count ?? 0} label="post replies" />
      </div>

      {warn ? (
        <p className="mt-2 font-mono" style={{ fontSize: 11, color: 'var(--warn)' }}>
          ⚠ This comment was removed
        </p>
      ) : null}

      {tracked.comment_url ? (
        <a
          href={tracked.comment_url}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block font-mono no-underline"
          style={{ fontSize: 11, color: 'var(--accent)' }}
        >
          View on Reddit →
        </a>
      ) : null}
    </div>
  )
}
