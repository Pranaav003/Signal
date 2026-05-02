import { useEffect, useState } from 'react'

export default function AddKeywordSetModal({
  isOpen,
  onClose,
  onSubmit,
}) {
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isOpen) {
      setValue('')
      setSubmitting(false)
      setError('')
    }
  }, [isOpen])

  if (!isOpen) return null

  async function handleSubmit(e) {
    e.preventDefault()

    const text = value.trim()

    if (!text) {
      setError('Describe what you monitor.')
      return
    }

    setSubmitting(true)
    setError('')

    try {
      await onSubmit(text)

      setValue('')
      onClose()

    } catch (err) {
      setError(err?.message ?? 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="signal-btn-focus fixed inset-0 z-[100] grid place-items-center p-6"
      style={{ background: 'rgba(0,0,0,0.72)' }}
      role="presentation"
      onMouseDown={(e) => {

        if (e.target === e.currentTarget) onClose()

      }}
    >
      <div
        className="signal-modal-overlay rounded-lg border shadow-lg"
        style={{
          background: 'var(--surface)',
          borderColor: 'var(--border)',
          padding: '32px',
          width: '100%',
          maxWidth: '480px',
          boxShadow: '0 0 0 1px rgba(110,231,183,0.08), 0 18px 50px rgba(0,0,0,0.55)',
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-monitor-heading"
      >
        <div className="mb-6">
          <p
            id="new-monitor-heading"
            className="font-mono text-[22px]"
            style={{ color: 'var(--text)', letterSpacing: '0.04em' }}
          >
            New Monitor
          </p>
          <p className="mt-2 text-[13px]" style={{ color: 'var(--muted)' }}>
            Signal will scan Reddit every 6 hours for leads
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <label
            className="mb-3 block font-mono text-[11px]"
            style={{
              color: 'var(--muted)',
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
            }}
          >
            DESCRIBE YOUR PRODUCT
          </label>
          <textarea
            rows={4}
            value={value}
            disabled={submitting}
            placeholder="e.g. accounting software for freelancers who hate spreadsheets"
            className="signal-btn-focus mb-4 w-full rounded-md border px-3 py-2 text-[14px] outline-none ring-0"
            style={{
              background: 'var(--surface-2)',
              borderColor: 'var(--border)',
              color: 'var(--text)',
              fontFamily: `"IBM Plex Sans", system-ui, sans-serif`,
            }}
            onFocus={(e) => {
              e.currentTarget.style.boxShadow = `0 0 0 2px ${'var(--accent-glow)'}`

              e.currentTarget.style.borderColor = 'var(--accent)'
            }}

            onBlur={(e) => {
              e.currentTarget.style.boxShadow = 'none'
              e.currentTarget.style.borderColor = 'var(--border)'
            }}

            onChange={(e) => setValue(e.target.value)}
          />

          <p className="mb-6 text-[11px]" style={{ color: 'var(--muted)' }}>
            Signal will generate search queries automatically
          </p>

          {error && (
            <p className="mb-4 text-[13px]" style={{ color: 'var(--danger)' }}>
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-6">
            <button
              type="button"
              className="signal-btn-focus rounded-md border-none bg-transparent text-[13px]"
              style={{ color: 'var(--muted)', letterSpacing: '0.06em', textTransform: 'uppercase', fontVariantNumeric: 'tabular-nums' }}
              disabled={submitting}
              onClick={onClose}
            >
              Cancel
            </button>

            <button
              type="submit"
              className="signal-btn-focus rounded-md border-none px-5 py-2 font-mono text-[13px] font-semibold"
              style={{
                background: 'var(--accent)',
                color: '#07070b',
                opacity: submitting ? 0.75 : 1,
              }}

              disabled={submitting}

            >
              {submitting ? 'Setting up...' : 'Start Monitoring'}

            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
