import { useMemo, useState } from 'react'

import { formatRelativeTime } from '../lib/time'
import { api } from '../lib/api'

function upvoteColor(n) {
  if (n > 0) return 'var(--green)'
  if (n < 0) return 'var(--red)'
  return 'var(--text-3)'
}

function relPosted(iso) {
  if (!iso) return '—'
  const sec = Math.floor(new Date(iso).getTime() / 1000)
  const r = formatRelativeTime(sec)
  return r === '—' ? '—' : `${r} ago`
}

function truncate(s, n) {
  const t = String(s ?? '')
  if (t.length <= n) return t
  return `${t.slice(0, n)}…`
}

export default function PerformancePage({ userId, rows, onRefresh }) {
  const [sort, setSort] = useState('upvotes')

  const sorted = useMemo(() => {
    const copy = [...(rows || [])]
    if (sort === 'recent') {
      copy.sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at))
    } else if (sort === 'replies') {
      copy.sort((a, b) => Number(b.reply_count ?? 0) - Number(a.reply_count ?? 0))
    } else {
      copy.sort((a, b) => Number(b.upvotes ?? 0) - Number(a.upvotes ?? 0))
    }
    return copy
  }, [rows, sort])

  const summary = useMemo(() => {
    const list = rows || []
    const n = list.length
    const totalUv = list.reduce((s, r) => s + Number(r.upvotes ?? 0), 0)
    const avg = n ? (totalUv / n).toFixed(1) : '0'
    let best = '—'
    if (n) {
      const top = [...list].sort(
        (a, b) => Number(b.upvotes ?? 0) - Number(a.upvotes ?? 0)
      )[0]
      const sub = top?.lead_subreddit || top?.subreddit
      best = sub ? `r/${String(sub).replace(/^r\//, '')}` : '—'
    }
    return { n, totalUv, avg, best }
  }, [rows])

  async function remove(id) {
    try {
      await api.delete(`/api/tracked-replies/${id}`, { params: { user_id: userId } })
      await onRefresh()
    } catch (e) {
      console.error('[PerformancePage] remove', e)
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="font-mono text-[20px]" style={{ letterSpacing: '0.08em' }}>
          Reply Performance
        </h1>
        <span
          className="rounded-full px-3 py-1 font-mono text-[13px]"
          style={{
            background: 'var(--accent-dim)',
            color: 'var(--accent)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {summary.n}
        </span>
      </div>

      <div
        className="mt-6 flex flex-wrap gap-4 rounded-lg border p-4"
        style={{
          background: 'var(--surface)',
          borderColor: 'var(--border)',
          borderRadius: 8,
          padding: '16px 20px',
        }}
      >
        {[
          { label: 'Total replies tracked', value: String(summary.n) },
          { label: 'Total upvotes', value: String(summary.totalUv) },
          { label: 'Avg upvotes/reply', value: summary.avg },
          { label: 'Best performing', value: summary.best },
        ].map((c) => (
          <div key={c.label} className="min-w-[120px] flex-1">
            <p className="font-mono text-[11px]" style={{ color: 'var(--text-3)' }}>
              {c.label}
            </p>
            <p className="mt-1 font-mono text-[15px] font-semibold" style={{ color: 'var(--text)' }}>
              {c.value}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        {[
          { id: 'upvotes', label: 'Upvotes' },
          { id: 'recent', label: 'Recent' },
          { id: 'replies', label: 'Replies' },
        ].map(({ id, label }) => {
          const active = sort === id
          return (
            <button
              key={id}
              type="button"
              className="signal-btn-focus rounded-md border px-3 py-1 font-mono text-[11px]"
              style={{
                borderColor: 'var(--border)',
                background: active ? 'var(--surface-2)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--muted)',
              }}
              onClick={() => setSort(id)}
            >
              {label}
            </button>
          )
        })}
      </div>

      <div className="mt-6">
        {!sorted.length ? (
          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            No replies tracked yet. Draft a reply and click &apos;I posted this reply&apos; to start
            tracking.
          </p>
        ) : (
          <div className="overflow-x-auto">
            {sorted.map((r) => (
            <div
              key={r.id}
              className="grid min-w-[720px] gap-3 border-b py-4"
              style={{
                borderColor: 'var(--border)',
                padding: '16px 0',
                gridTemplateColumns: 'minmax(0,2fr) auto auto auto auto auto',
                alignItems: 'center',
              }}
            >
              <div className="min-w-0">
                <p className="text-[13px]" style={{ color: 'var(--text)' }}>
                  {truncate(r.lead_title, 50)}
                </p>
                <p className="mt-1 font-mono text-[11px]" style={{ color: 'var(--text-3)' }}>
                  r/{String(r.lead_subreddit ?? '').replace(/^r\//, '')}
                </p>
              </div>
              <span
                className="font-mono text-[18px] font-bold tabular-nums"
                style={{ color: upvoteColor(Number(r.upvotes ?? 0)) }}
              >
                {r.upvotes ?? 0}
              </span>
              <span className="font-mono text-[13px] tabular-nums" style={{ color: 'var(--text)' }}>
                {r.reply_count ?? 0}
              </span>
              <span className="font-mono text-[11px]" style={{ color: 'var(--text-3)' }}>
                {relPosted(r.posted_at)}
              </span>
              <a
                href={r.comment_url}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[12px] no-underline"
                style={{ color: 'var(--accent)' }}
              >
                View →
              </a>
              <button
                type="button"
                className="signal-btn-focus font-mono text-[12px]"
                style={{ color: 'var(--text-3)' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = 'var(--red)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'var(--text-3)'
                }}
                onClick={() => void remove(r.id)}
              >
                Remove
              </button>
            </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
