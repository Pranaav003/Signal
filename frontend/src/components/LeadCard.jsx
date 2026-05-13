import { useEffect, useRef, useState } from 'react'

import TrackedReplyStats from './TrackedReplyStats'
import { api } from '../lib/api'
import { formatRelativeTime } from '../lib/time'

function scoreClass(score) {
  if (score >= 80) return 'signal-lead-score--high'
  if (score >= 60) return 'signal-lead-score--mid'
  return 'signal-lead-score--low'
}

function formatRedditAuthor(author) {
  if (
    author == null ||
    author === '' ||
    author === '[deleted]' ||
    author === 'anonymous'
  ) {
    return 'u/…'
  }
  const s = String(author)
  if (s.startsWith('u/')) return s
  return `u/${s}`
}

function isHNLead(lead) {
  return String(lead?.platform || '').toLowerCase() === 'hackernews'
}

async function safeCopy(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      return true
    } catch {
      return false
    }
  }
}

export default function LeadCard({
  lead,
  extraClassName,
  userId,
  trackedReply,
  onMarkSeen,
  onMarkUnread,
  onDismiss,
  onSuppress,
  onGenerateDraft,
  onTrackedRefresh,
}) {
  const scoreNum = Number(lead?.relevance_score ?? 0)
  const scoreTone = Number.isFinite(scoreNum) ? scoreClass(scoreNum) : 'signal-lead-score--low'

  const title = String(lead?.title ?? '').trim()
  const body = String(lead?.body_snippet ?? '').trim()
  const hasTitle = Boolean(title)
  const displayTitle = hasTitle
    ? title
    : body
      ? `${body.slice(0, 110)}${body.length > 110 ? '…' : ''}`
      : 'Untitled post'
  const showSnippet = hasTitle && Boolean(body)

  const draftText =
    typeof lead?.ai_draft === 'string' && lead.ai_draft.length > 0 ? lead.ai_draft : ''

  const [draftBusy, setDraftBusy] = useState(false)
  const [copiedFlash, setCopiedFlash] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [showTrackForm, setShowTrackForm] = useState(false)
  const [trackUrl, setTrackUrl] = useState('')
  const [trackError, setTrackError] = useState('')
  const [trackBusy, setTrackBusy] = useState(false)
  const [whyOpen, setWhyOpen] = useState(false)
  const [whyLines, setWhyLines] = useState(null)
  const [whyLoading, setWhyLoading] = useState(false)

  const menuRef = useRef(null)
  const triggerRef = useRef(null)

  const hasDraftContent = draftBusy || Boolean(draftText)
  const draftOpen = hasDraftContent || Boolean(trackedReply) || showTrackForm

  useEffect(() => {
    if (!menuOpen) return undefined

    function onDocMouseDown(e) {
      const t = e.target
      if (
        menuRef.current?.contains(t) ||
        triggerRef.current?.contains(t)
      ) {
        return
      }
      setMenuOpen(false)
      setDeleteConfirm(false)
    }

    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [menuOpen])

  async function runDraft(options = {}) {
    const { force = false } = options
    setDraftBusy(true)
    try {
      await onGenerateDraft(lead.id, { force })
    } finally {
      setDraftBusy(false)
    }
  }

  async function handleCopy() {
    if (!draftText) return
    await safeCopy(draftText)
    setCopiedFlash(true)
    window.setTimeout(() => setCopiedFlash(false), 2000)
  }

  async function handleTrackSubmit(e) {
    e.preventDefault()
    setTrackError('')
    const url = trackUrl.trim()
    if (!url) {
      setTrackError('Paste a comment URL')
      return
    }
    if (!userId) {
      setTrackError('Not signed in')
      return
    }
    setTrackBusy(true)
    try {
      await api.post('/api/tracked-replies', {
        user_id: userId,
        lead_id: lead.id,
        comment_url: url,
      })
      setShowTrackForm(false)
      setTrackUrl('')
      if (onTrackedRefresh) await onTrackedRefresh()
    } catch (err) {
      const msg =
        err?.response?.data?.error ||
        err?.message ||
        'Could not start tracking'
      setTrackError(msg)
    } finally {
      setTrackBusy(false)
    }
  }

  const buttonsDisabled = draftBusy
  const showSpinner = draftBusy && !draftText

  const seen = Boolean(lead.seen)

  async function handleDeleteConfirmed() {
    setRemoving(true)
    setMenuOpen(false)
    setDeleteConfirm(false)
    await new Promise((r) => setTimeout(r, 200))
    try {
      await onDismiss(lead.id)
    } catch {
      setRemoving(false)
    }
  }

  async function toggleWhyScore() {
    if (whyOpen) {
      setWhyOpen(false)
      return
    }
    const fromRow = lead.score_reasons
    if (Array.isArray(fromRow) && fromRow.length > 0) {
      setWhyLines(fromRow)
      setWhyOpen(true)
      return
    }
    if (!userId) return
    setWhyLoading(true)
    try {
      const { data } = await api.get(`/api/leads/${lead.id}/why`, {
        params: { user_id: userId },
      })
      setWhyLines(Array.isArray(data?.reasons) ? data.reasons : [])
      setWhyOpen(true)
    } catch {
      setWhyLines(['Could not load score breakdown.'])
      setWhyOpen(true)
    } finally {
      setWhyLoading(false)
    }
  }

  const scoreDisplay = Number.isFinite(scoreNum) ? String(scoreNum) : '–'
  const rel = formatRelativeTime(lead.created_utc ?? lead.created_at)
  const timeLine = rel === '—' ? '—' : `${rel} ago`
  const hnLead = isHNLead(lead)
  const authorDisplay = hnLead ? (lead.author || 'anonymous') : formatRedditAuthor(lead.author)

  return (
    <article
      className={`signal-btn-focus signal-lead-card ${extraClassName || ''}`}
      style={{ opacity: removing ? 0 : 1 }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="signal-btn-focus signal-lead-menu-btn"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="More actions"
        onClick={() => {
          setMenuOpen((o) => !o)
          setDeleteConfirm(false)
        }}
      >
        ⋯
      </button>

      {menuOpen && (
        <div
          ref={menuRef}
          className="signal-lead-menu signal-btn-focus absolute right-3 top-[44px] z-50 min-w-[140px] rounded-md border p-1"
          style={{
            background: 'var(--surface-2)',
            borderColor: 'var(--border)',
            borderRadius: '6px',
          }}
          role="menu"
        >
          {!deleteConfirm ? (
            <>
              <button
                type="button"
                className="signal-btn-focus w-full rounded border-none bg-transparent px-3 py-2 text-left font-sans text-[13px] transition-colors duration-150"
                style={{ color: 'var(--text)' }}
                role="menuitem"
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--surface)'
                  e.currentTarget.style.borderRadius = '4px'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
                onClick={() => {
                  if (seen) {
                    void onMarkUnread(lead.id)
                  } else {
                    void onMarkSeen(lead.id)
                  }
                  setMenuOpen(false)
                }}
              >
                {seen ? 'Mark as Unread' : 'Mark as Read'}
              </button>
              {onSuppress ? (
                <>
                  <button
                    type="button"
                    className="signal-btn-focus w-full rounded border-none bg-transparent px-3 py-2 text-left font-sans text-[13px] transition-colors duration-150"
                    style={{ color: 'var(--text)' }}
                    role="menuitem"
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--surface)'
                      e.currentTarget.style.borderRadius = '4px'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
                    onClick={() => {
                      setMenuOpen(false)
                      void onSuppress(lead.id, { mode: 'snooze', snooze_hours: 24 })
                    }}
                  >
                    Snooze thread 24h
                  </button>
                  <button
                    type="button"
                    className="signal-btn-focus w-full rounded border-none bg-transparent px-3 py-2 text-left font-sans text-[13px] transition-colors duration-150"
                    style={{ color: 'var(--text)' }}
                    role="menuitem"
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--surface)'
                      e.currentTarget.style.borderRadius = '4px'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
                    onClick={() => {
                      setMenuOpen(false)
                      void onSuppress(lead.id, { mode: 'snooze', snooze_hours: 168 })
                    }}
                  >
                    Snooze thread 7d
                  </button>
                  <button
                    type="button"
                    className="signal-btn-focus w-full rounded border-none bg-transparent px-3 py-2 text-left font-sans text-[13px] transition-colors duration-150"
                    style={{ color: 'var(--yellow)' }}
                    role="menuitem"
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--surface)'
                      e.currentTarget.style.borderRadius = '4px'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
                    onClick={() => {
                      setMenuOpen(false)
                      void onSuppress(lead.id, { mode: 'mute' })
                    }}
                  >
                    Mute thread (never resurface)
                  </button>
                </>
              ) : null}
              <div
                className="my-1 h-px"
                style={{ background: 'var(--border)', margin: '4px 0' }}
              />
              <button
                type="button"
                className="signal-btn-focus w-full rounded border-none bg-transparent px-3 py-2 text-left font-sans text-[13px] transition-colors duration-150"
                style={{ color: 'var(--red)' }}
                role="menuitem"
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(248,113,113,0.08)'
                  e.currentTarget.style.borderRadius = '4px'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
                onClick={() => setDeleteConfirm(true)}
              >
                Delete Lead
              </button>
            </>
          ) : (
            <div className="px-2 py-2">
              <p className="mb-3 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                Delete this lead?
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="signal-btn-focus rounded border-none px-2 py-1 font-sans text-[12px]"
                  style={{ color: 'var(--text-muted)' }}
                  onClick={() => setDeleteConfirm(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="signal-btn-focus rounded border-none px-2 py-1 font-sans text-[12px] font-semibold"
                  style={{ color: 'var(--red)' }}
                  onClick={() => {
                    void handleDeleteConfirmed()
                  }}
                >
                  Yes, delete
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="signal-lead-top">
        <div className="signal-lead-top-left">
          <span className="signal-lead-score-wrap">
            <span className={`signal-lead-score ${scoreTone}`}>{scoreDisplay}</span>
            <span className="signal-lead-score-label">SCORE</span>
          </span>
          {hnLead ? (
            <span
              className="inline-block rounded px-2 py-0.5 font-mono text-[11px]"
              style={{
                background: 'rgba(255,102,0,0.15)',
                color: '#ff6600',
                borderRadius: 4,
              }}
            >
              HN
            </span>
          ) : null}
          <span className="signal-lead-subpill">
            {hnLead ? (
              lead.subreddit || 'HackerNews'
            ) : (
              <>
                <span style={{ color: '#ff6600' }}>r/</span>
                {lead.subreddit || 'unknown'}
              </>
            )}
          </span>
          {lead.monitor_name ? (
            <span
              style={{
                fontSize: '10px',
                fontFamily: 'IBM Plex Mono',
                color: 'var(--accent)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                borderRadius: '4px',
                padding: '2px 8px',
                background: 'var(--accent-dim)',
                marginLeft: '6px',
              }}
            >
              {String(lead.monitor_name).trim().split(/\s+/).slice(0, 4).join(' ')}
            </span>
          ) : null}
          <span className="signal-lead-author">{authorDisplay}</span>
          {!hnLead && lead.upvotes > 0 ? (
            <span
              style={{
                fontSize: '11px',
                color: 'var(--text-3)',
                fontFamily: 'IBM Plex Mono',
              }}
            >
              ▲ {lead.upvotes}
            </span>
          ) : null}
          {!hnLead && lead.comment_count > 0 ? (
            <span
              style={{
                fontSize: '11px',
                color: 'var(--text-3)',
                fontFamily: 'IBM Plex Mono',
              }}
            >
              💬 {lead.comment_count}
            </span>
          ) : null}
        </div>
        <span className="signal-lead-time">{timeLine}</span>
      </div>

      <div className="mb-2 mt-1">
        <button
          type="button"
          className="signal-btn-focus font-mono text-[10px]"
          style={{
            color: 'var(--text-3)',
            border: 'none',
            background: 'none',
            cursor: whyLoading ? 'wait' : 'pointer',
            textDecoration: 'underline',
            letterSpacing: '0.04em',
          }}
          onClick={() => {
            void toggleWhyScore()
          }}
        >
          {whyLoading ? 'Loading…' : whyOpen ? 'Hide score breakdown' : 'Why this score?'}
        </button>
        {whyOpen && Array.isArray(whyLines) && whyLines.length > 0 ? (
          <ul
            className="mt-2 space-y-1.5 pl-0 font-mono text-[11px]"
            style={{ color: 'var(--text-2)', listStyle: 'none', marginBottom: 0, lineHeight: 1.45 }}
          >
            {whyLines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <p className="signal-lead-title">{displayTitle}</p>

      {showSnippet ? <p className="signal-lead-snippet">{body}</p> : null}

      <div className="signal-lead-actions">
        {lead.url ? (
          <a
            href={lead.url}
            target="_blank"
            rel="noreferrer"
            className="signal-lead-view"
          >
            View Post →
          </a>
        ) : (
          <span className="signal-lead-view signal-lead-view--disabled">View Post →</span>
        )}

        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="signal-lead-draft-btn"
            disabled={buttonsDisabled}
            onClick={() => {
              void runDraft()
            }}
          >
            {draftBusy ? (
              <span className="inline-flex items-center gap-2">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{
                    background: 'var(--accent)',
                    animation: 'signal-pulse 1.05s ease-in-out infinite',
                  }}
                />
                Drafting...
              </span>
            ) : (
              'Draft Reply'
            )}
          </button>
          {!hnLead && (Boolean(lead.ai_draft) || Boolean(draftText)) && !trackedReply ? (
            <button
              type="button"
              className="signal-btn-focus w-fit font-mono text-[12px]"
              style={{
                color: 'var(--accent)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
              onClick={() => {
                setShowTrackForm((v) => !v)
                setTrackError('')
              }}
            >
              I posted this reply
            </button>
          ) : null}
        </div>
      </div>

      {!hnLead && (Boolean(lead.ai_draft) || Boolean(draftText)) && !trackedReply && showTrackForm ? (
        <form className="mt-3" onSubmit={handleTrackSubmit}>
          <label
            className="mb-2 block font-mono"
            style={{ fontSize: 11, color: 'var(--text-3)' }}
            htmlFor={`track-url-${lead.id}`}
          >
            Paste your Reddit comment URL to track performance
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id={`track-url-${lead.id}`}
              type="text"
              inputMode="url"
              value={trackUrl}
              onChange={(ev) => setTrackUrl(ev.target.value)}
              placeholder="https://reddit.com/r/freelance/comments/abc123/.../xyz789/"
              className="signal-btn-focus min-w-0 flex-1"
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                color: 'var(--text)',
                borderRadius: 6,
                padding: '8px 12px',
                fontSize: 13,
                fontFamily: '"Space Grotesk", system-ui, sans-serif',
                outline: 'none',
              }}
              onFocus={(e) => {
                e.target.style.borderColor = 'var(--accent)'
              }}
              onBlur={(e) => {
                e.target.style.borderColor = 'var(--border)'
              }}
            />
            <button
              type="submit"
              className="signal-btn-focus font-mono shrink-0 border-none font-bold"
              style={{
                background: 'var(--accent)',
                color: '#fff',
                padding: '8px 14px',
                borderRadius: 6,
                fontSize: 12,
                whiteSpace: 'nowrap',
                cursor: trackBusy ? 'wait' : 'pointer',
                opacity: trackBusy ? 0.75 : 1,
              }}
              disabled={trackBusy}
            >
              Track It
            </button>
          </div>
          {trackError ? (
            <p className="mt-2 text-[12px]" style={{ color: 'var(--red)' }}>
              {trackError}
            </p>
          ) : null}
        </form>
      ) : null}

      {draftOpen ? (
        <div className="signal-lead-draft-block">
          {hasDraftContent ? (
            <>
              <p className="signal-lead-draft-label">AI DRAFT</p>

              {showSpinner ? (
                <div className="mt-2 flex items-center gap-2">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{
                      background: 'var(--accent)',
                      animation: 'signal-pulse 1.05s ease-in-out infinite',
                    }}
                  />
                  <p className="text-[13px]" style={{ color: 'var(--text-2)', margin: 0 }}>
                    Drafting...
                  </p>
                </div>
              ) : draftText ? (
                <p className="signal-lead-draft-body">{draftText}</p>
              ) : null}

              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
                <button
                  type="button"
                  className="signal-lead-copy-btn"
                  disabled={buttonsDisabled || !draftText}
                  onClick={handleCopy}
                >
                  {copiedFlash ? 'Copied ✓' : 'Copy'}
                </button>
                <button
                  type="button"
                  className="signal-lead-regen-btn"
                  disabled={buttonsDisabled}
                  title="Runs the generator again"
                  onClick={() => {
                    void runDraft({ force: true })
                  }}
                >
                  Regenerate
                </button>
              </div>
            </>
          ) : null}

          {trackedReply ? <TrackedReplyStats tracked={trackedReply} /> : null}
        </div>
      ) : null}
    </article>
  )
}
