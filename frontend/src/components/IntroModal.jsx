import { useCallback, useEffect } from 'react'

export const INTRO_STORAGE_KEY = 'signal_intro_seen_v1'

const SECTIONS = [
  {
    title: 'Create a monitor',
    body: 'Describe what you are building or selling in plain English.',
  },
  {
    title: 'Signal searches Reddit',
    body: 'Signal turns your description into search queries, scans relevant communities, and looks for real posts that may show demand.',
  },
  {
    title: 'Review the leads',
    body: 'Open the leads, read why they matched, and draft a helpful reply if the post is relevant.',
  },
  {
    title: 'Timing',
    body: 'A new scan usually takes about 3–5 minutes. Larger scans or slow Reddit responses can take longer.',
  },
]

/**
 * First-time onboarding — shown when signal_intro_seen_v1 is unset, or via Help (forceOpen).
 * @param {{
 *   isOpen: boolean,
 *   onClose: () => void,
 *   onStart: () => void,
 *   onCreateFirstMonitor?: () => void,
 *   persistSeen?: boolean,
 * }} props
 */
export default function IntroModal({
  isOpen,
  onClose,
  onStart,
  onCreateFirstMonitor,
  persistSeen = true,
}) {
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

  const finish = useCallback(() => {
    if (persistSeen) {
      try {
        localStorage.setItem(INTRO_STORAGE_KEY, 'true')
      } catch {
        /* ignore */
      }
    }
    onStart()
  }, [persistSeen, onStart])

  if (!isOpen) return null

  return (
    <div
      className="add-monitor-overlay signal-btn-focus fixed inset-0 z-[105] flex items-center justify-center p-6"
      style={{
        background: 'rgba(0,0,0,0.75)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
      }}
      role="presentation"
      onMouseDown={handleOverlayMouseDown}
    >
      <div
        className="add-monitor-card signal-btn-focus relative max-h-[90vh] w-full max-w-[540px] overflow-y-auto rounded-[12px] border p-8"
        style={{
          background: 'var(--surface)',
          borderColor: 'var(--border)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.55)',
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="intro-modal-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="signal-btn-focus absolute right-6 top-6 border-none bg-transparent p-1 font-mono text-[18px] leading-none"
          style={{ color: 'var(--text-muted)' }}
          aria-label="Close"
          onClick={onClose}
        >
          ×
        </button>

        <header className="pr-8">
          <p
            className="m-0 font-mono text-[11px]"
            style={{ letterSpacing: '0.2em', color: 'var(--accent)' }}
          >
            GETTING STARTED
          </p>
          <h2
            id="intro-modal-title"
            className="mt-2 font-mono text-[20px]"
            style={{ color: 'var(--text)' }}
          >
            Welcome to Signal
          </h2>
          <p className="mt-3 text-[14px] leading-relaxed" style={{ color: 'var(--text-2)' }}>
            Signal helps you find people online who are already talking about a problem your
            product could solve.
          </p>
        </header>

        <ol className="mt-6 list-none space-y-4 p-0">
          {SECTIONS.map((section, i) => (
            <li
              key={section.title}
              className="rounded-lg border px-4 py-3"
              style={{
                borderColor: 'var(--border)',
                background: 'rgba(124,106,247,0.06)',
              }}
            >
              <p className="m-0 font-mono text-[11px]" style={{ color: 'var(--accent)' }}>
                {i + 1}. {section.title}
              </p>
              <p className="mt-2 mb-0 text-[13px] leading-relaxed" style={{ color: 'var(--text-2)' }}>
                {section.body}
              </p>
            </li>
          ))}
        </ol>

        <p
          className="mt-6 rounded-md border px-4 py-3 text-[12px] italic leading-relaxed"
          style={{
            borderColor: 'var(--border)',
            color: 'var(--text-muted)',
            background: 'var(--bg)',
          }}
        >
          Tip: The better you describe the customer and problem, the better the leads.
        </p>

        <div className="mt-8 flex flex-col gap-3">
          <button
            type="button"
            className="signal-btn-focus w-full rounded-[6px] border-none py-3 font-mono text-[13px] font-bold"
            style={{ background: 'var(--accent)', color: '#09090f' }}
            onClick={finish}
          >
            Start using Signal
          </button>
          {onCreateFirstMonitor ? (
            <button
              type="button"
              className="signal-btn-focus w-full rounded-[6px] border bg-transparent py-2.5 font-mono text-[12px]"
              style={{ borderColor: 'var(--border)', color: 'var(--accent)' }}
              onClick={() => {
                finish()
                onCreateFirstMonitor()
              }}
            >
              Create my first monitor
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
