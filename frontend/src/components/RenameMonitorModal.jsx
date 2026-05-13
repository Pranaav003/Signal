import { useEffect, useState } from 'react'

const MAX_CHARS = 240

/**
 * @param {{
 *   isOpen: boolean,
 *   onClose: () => void,
 *   keywordSet: { id: string; product_description?: string } | null,
 *   onSave: (id: string, description: string) => Promise<void>,
 * }} props
 */
export default function RenameMonitorModal({ isOpen, onClose, keywordSet, onSave }) {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isOpen) return undefined

    setText(keywordSet?.product_description ?? '')
    setError('')
    setLoading(false)

    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, keywordSet?.id, keywordSet?.product_description, onClose])

  if (!isOpen || !keywordSet) return null

  async function handleSubmit(e) {
    e.preventDefault()

    const trimmed = text.trim()

    if (!trimmed) {
      setError('Describe what you sell so Signal can find leads.')
      return
    }

    if (trimmed.length > MAX_CHARS) {
      setError(`Keep it under ${MAX_CHARS} characters.`)
      return
    }

    setLoading(true)
    setError('')

    try {
      await onSave(keywordSet.id, trimmed)
      onClose()
    } catch (err) {
      const msg =
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        err?.message ||
        'Could not save'

      setError(typeof msg === 'string' ? msg : 'Could not save')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center px-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rename-monitor-title"
    >
      <button
        type="button"
        className="signal-btn-focus absolute inset-0 cursor-default border-none bg-black/55"
        aria-label="Close dialog"
        onClick={onClose}
      />

      <div
        className="relative z-[1] w-full max-w-[480px] rounded-xl border p-8 shadow-2xl"
        style={{
          borderColor: 'var(--border)',
          background: 'var(--surface)',
          color: 'var(--text)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <p
          id="rename-monitor-title"
          className="font-mono text-[11px]"
          style={{ color: 'var(--text-3)', letterSpacing: '0.18em' }}
        >
          RENAME MONITOR
        </p>

        <h2 className="mt-2 text-xl font-semibold tracking-tight">
          Update how this monitor is described
        </h2>

        <p className="mt-2 text-[13px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Queries and subreddit targets are regenerated from this text (may take a moment).
        </p>

        <form className="mt-6" onSubmit={handleSubmit}>
          <label className="sr-only" htmlFor="rename-monitor-desc">
            Monitor description
          </label>
          <textarea
            id="rename-monitor-desc"
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, MAX_CHARS))}
            rows={6}
            maxLength={MAX_CHARS}
            className="signal-btn-focus w-full resize-y rounded-[6px] border px-3 py-3 font-mono text-[13px] leading-relaxed outline-none transition-[border-color] duration-150"
            style={{
              borderColor: 'var(--border)',
              background: 'var(--surface-2)',
              color: 'var(--text)',
            }}
            placeholder="e.g. CRM for solo founders frustrated with HubSpot…"
            disabled={loading}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--accent)'
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'var(--border)'
            }}
          />

          <div
            className="mt-1 flex justify-between font-mono text-[11px]"
            style={{ color: 'var(--text-muted)' }}
          >
            <span>{error ? <span style={{ color: 'var(--danger, #f87171)' }}>{error}</span> : ' '}</span>
            <span aria-live="polite">{text.length}/{MAX_CHARS}</span>
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              className="signal-btn-focus rounded-md border px-4 py-2 font-mono text-[13px]"
              style={{
                borderColor: 'var(--border)',
                background: 'transparent',
                color: 'var(--text-muted)',
              }}
              onClick={onClose}
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="signal-btn-focus rounded-md border-none px-5 py-2 font-mono text-[13px] font-semibold"
              style={{
                background: 'var(--accent)',
                color: '#09090f',
              }}
              disabled={loading}
            >
              {loading ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
