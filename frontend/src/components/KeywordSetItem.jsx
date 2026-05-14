import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

function IconPencil({ className }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  )
}

function IconTrash({ className }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  )
}

export default function KeywordSetItem({
  keywordSet,
  isActive,
  onClick,
  unseenCount,
  onDelete,
  onEditMonitor,
}) {
  const text = keywordSet.product_description ?? ''
  const truncated = text.length > 35 ? `${text.slice(0, 35)}…` : text
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })
  const menuRef = useRef(null)
  const triggerRef = useRef(null)

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (!trigger) return

    const r = trigger.getBoundingClientRect()
    const gap = 8
    const mw = menu?.offsetWidth ?? 200
    const mh = menu?.offsetHeight ?? 96

    let left = r.right + gap
    let top = r.top

    if (left + mw > window.innerWidth - 8) {
      left = r.left - mw - gap
    }
    left = Math.max(8, Math.min(left, window.innerWidth - mw - 8))

    if (top + mh > window.innerHeight - 8) {
      top = window.innerHeight - mh - 8
    }
    if (top < 8) top = 8

    setMenuPos({ top, left })
  }, [])

  useLayoutEffect(() => {
    if (!menuOpen) return undefined

    updateMenuPosition()
    const id = window.requestAnimationFrame(() => updateMenuPosition())

    return () => window.cancelAnimationFrame(id)
  }, [menuOpen, updateMenuPosition])

  useEffect(() => {
    if (!menuOpen) return undefined

    window.addEventListener('resize', updateMenuPosition)
    window.addEventListener('scroll', updateMenuPosition, true)

    return () => {
      window.removeEventListener('resize', updateMenuPosition)
      window.removeEventListener('scroll', updateMenuPosition, true)
    }
  }, [menuOpen, updateMenuPosition])

  useEffect(() => {
    if (!menuOpen) return undefined

    function onKeyDown(e) {
      if (e.key === 'Escape') setMenuOpen(false)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) return undefined

    function onDocMouseDown(e) {
      const t = e.target
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setMenuOpen(false)
    }

    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [menuOpen])

  async function handleDelete(e) {
    e.preventDefault()
    e.stopPropagation()
    if (!onDelete || deleting) return
    setDeleting(true)
    try {
      await onDelete(keywordSet.id)
      setMenuOpen(false)
    } finally {
      setDeleting(false)
    }
  }

  function handleEditMonitor(e) {
    e.preventDefault()
    e.stopPropagation()
    if (!onEditMonitor) return
    setMenuOpen(false)
    onEditMonitor(keywordSet.id)
  }

  const menu =
    menuOpen && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Monitor actions"
            className="signal-btn-focus fixed z-[300] min-w-[200px] overflow-hidden rounded-lg border py-1 shadow-2xl"
            style={{
              top: menuPos.top,
              left: menuPos.left,
              background: 'var(--surface-2)',
              borderColor: 'var(--border)',
              boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
            }}
          >
            {onEditMonitor ? (
              <button
                type="button"
                role="menuitem"
                className="signal-btn-focus flex w-full items-center gap-3 border-none bg-transparent px-3 py-2.5 text-left font-mono text-[13px] transition-colors"
                style={{ color: 'var(--text)' }}
                onClick={handleEditMonitor}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--surface)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <IconPencil className="shrink-0 opacity-80" />
                Edit monitor
              </button>
            ) : null}

            {onEditMonitor && onDelete ? (
              <div className="mx-2 h-px" style={{ background: 'var(--border)' }} />
            ) : null}

            {onDelete ? (
              <button
                type="button"
                role="menuitem"
                className="signal-btn-focus flex w-full items-center gap-3 border-none bg-transparent px-3 py-2.5 text-left font-mono text-[13px] transition-colors"
                style={{ color: 'var(--red)' }}
                onClick={handleDelete}
                disabled={deleting}
                onMouseEnter={(e) => {
                  if (!deleting) e.currentTarget.style.background = 'rgba(248,113,113,0.08)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <IconTrash className="shrink-0 opacity-90" />
                {deleting ? 'Deleting…' : 'Delete monitor'}
              </button>
            ) : null}
          </div>,
          document.body
        )
      : null

  return (
    <div
      className="relative w-full"
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--surface-2)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
      style={{
        borderLeft: '2px solid ' + (isActive ? 'var(--accent)' : 'transparent'),
        borderRadius: 6,
      }}
    >
      <button
        type="button"
        onClick={() => onClick(keywordSet.id)}
        className="signal-btn-focus w-full cursor-pointer rounded-md border-none bg-transparent p-3 pr-10 text-left transition-colors"
        style={{ paddingLeft: 14 }}
      >
        <div className="flex items-start gap-2">
          <span
            className="font-mono"
            aria-hidden="true"
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              marginTop: 7,
              background:
                keywordSet.active === false ? 'var(--muted)' : 'var(--accent)',
            }}
          />
          <div className="flex-1 overflow-hidden">
            <p className="font-mono text-[13px] leading-snug" style={{ color: 'var(--text)' }}>
              {truncated || 'Untitled'}
            </p>

            {(unseenCount ?? 0) > 0 && (
              <span
                className="mt-1 inline-flex items-center rounded px-2 py-0.5 font-mono text-[11px]"
                style={{
                  background: 'var(--accent)',
                  color: '#07070b',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {String(unseenCount)}
              </span>
            )}
          </div>
        </div>
      </button>

      <button
        ref={triggerRef}
        type="button"
        className="signal-btn-focus absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded border-none bg-transparent text-[16px]"
        style={{ color: 'var(--text-3)' }}
        aria-label="Monitor actions"
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setMenuOpen((v) => !v)
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--text)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--text-3)'
        }}
      >
        ⋯
      </button>

      {menu}
    </div>
  )
}
