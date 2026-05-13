import { useCallback, useEffect } from 'react'

const MAILTO =
  'mailto:dev@pranaaviyer.com?subject=' +
  encodeURIComponent('Signal — I need more monitors') +
  '&body=' +
  encodeURIComponent(
    "Hi, I'm using Signal and would love to add more monitors. Here's what I'm building: "
  )

/**
 * Shown when the user already has 3 monitors and tries to add another (same content as the old landing “Need more?” block).
 * @param {{ isOpen: boolean, onClose: () => void }} props
 */
export default function LimitModal({ isOpen, onClose }) {
  useEffect(() => {
    if (!isOpen) return undefined

    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, onClose])

  const handleOverlayMouseDown = useCallback(
    (e) => {
      if (e.target === e.currentTarget) onClose()
    },
    [onClose]
  )

  if (!isOpen) return null

  return (
    <div
      className="add-monitor-overlay signal-btn-focus fixed inset-0 z-[110] flex items-center justify-center p-4 sm:p-6"
      style={{
        background: 'rgba(0,0,0,0.75)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
      }}
      role="presentation"
      onMouseDown={handleOverlayMouseDown}
    >
      <div
        className="add-monitor-card signal-btn-focus relative max-h-[90vh] w-full max-w-[920px] overflow-y-auto rounded-[12px] border p-6 sm:p-8"
        style={{
          background: 'var(--surface)',
          borderColor: 'var(--border)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.55)',
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="limit-modal-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="signal-btn-focus absolute right-4 top-4 border-none bg-transparent p-1 font-mono text-[20px] leading-none sm:right-6 sm:top-6"
          style={{ color: 'var(--text-muted)' }}
          aria-label="Close"
          onClick={onClose}
        >
          ×
        </button>

        <div className="grid gap-8 pr-6 pt-2 lg:grid-cols-2 lg:gap-10 lg:pr-8">
          <div className="text-left">
            <p
              className="font-mono text-[11px]"
              style={{ letterSpacing: '0.18em', color: 'var(--accent)' }}
            >
              NEED MORE?
            </p>
            <h2
              id="limit-modal-title"
              className="mt-3 font-sans text-[26px] font-bold leading-tight sm:text-[32px]"
              style={{ color: 'var(--text)' }}
            >
              Need more than the defaults?
            </h2>
            <p
              className="mt-4 font-sans text-[15px] leading-[1.7]"
              style={{ color: 'var(--text-3)' }}
            >
              We&apos;re keeping Signal focused: three monitors per account, scans every six hours.
              If you&apos;re building something serious and need more — more monitors, custom scan
              intervals, or platforms we haven&apos;t shipped yet — reach out directly.
            </p>
            <p
              className="mt-4 font-sans text-[15px] leading-[1.7]"
              style={{ color: 'var(--text-3)' }}
            >
              No sales team. No demo call. Just a founder who&apos;ll actually respond.
            </p>
          </div>

          <div
            className="rounded-[12px] border p-6 sm:p-8"
            style={{
              background: 'var(--bg)',
              borderColor: 'var(--border)',
            }}
          >
            <p
              className="font-mono text-[10px]"
              style={{ letterSpacing: '0.12em', color: 'var(--text-3)' }}
            >
              REACH OUT
            </p>
            <a
              className="signal-btn-focus mt-5 inline-block font-mono text-[15px] transition-opacity duration-150"
              style={{ color: 'var(--accent)', textDecoration: 'none' }}
              href={MAILTO}
            >
              dev@pranaaviyer.com
            </a>
            <div className="my-5 h-px" style={{ background: 'var(--border)' }} />
            <ul className="m-0 list-none p-0 font-mono text-[13px]" style={{ color: 'var(--text-3)' }}>
              <li className="mb-2">→ Need more than 3 monitors</li>
              <li className="mb-2">→ Want priority scanning (every 1-2h)</li>
              <li className="mb-0">→ Interested in other platforms (Twitter, HN, IndieHackers)</li>
            </ul>
            <div className="my-5 h-px" style={{ background: 'var(--border)' }} />
            <p className="m-0 text-[12px] italic" style={{ color: 'var(--text-3)' }}>
              Replies within 24 hours.
            </p>
          </div>
        </div>

        <button
          type="button"
          className="signal-btn-focus mono mt-8 w-full rounded-md border py-3 text-[13px] transition-colors duration-150"
          style={{
            background: 'var(--surface-2)',
            borderColor: 'var(--border)',
            color: 'var(--text)',
            cursor: 'pointer',
          }}
          onClick={onClose}
        >
          Got it
        </button>
      </div>
    </div>
  )
}
