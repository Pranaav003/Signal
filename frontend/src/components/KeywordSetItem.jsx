import { useEffect, useRef, useState } from 'react'

export default function KeywordSetItem({
  keywordSet,
  isActive,
  onClick,
  unseenCount,
  onDelete,
}) {
  const text = keywordSet.product_description ?? ''
  const truncated = text.length > 35 ? `${text.slice(0, 35)}…` : text
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const menuRef = useRef(null)
  const triggerRef = useRef(null)

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

      {menuOpen ? (
        <div
          ref={menuRef}
          className="absolute right-2 top-10 z-20 min-w-[120px] rounded-md border p-1"
          style={{ background: 'var(--surface-2)', borderColor: 'var(--border)' }}
        >
          <button
            type="button"
            className="signal-btn-focus w-full rounded border-none bg-transparent px-3 py-2 text-left font-mono text-[12px]"
            style={{ color: 'var(--red)' }}
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? 'Deleting…' : 'Delete monitor'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
