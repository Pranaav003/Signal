import { useCallback, useEffect, useRef, useState } from 'react'

import { api } from '../lib/api'

const MAX_CHARS = 240

/**
 * @param {{
 *   isOpen: boolean,
 *   onClose: () => void,
 *   onSuccess: (row?: { id: string }, meta?: { mode: 'create' | 'edit' }) => void | Promise<void>,
 *   onMonitorLimitReached?: () => void,
 *   onDraftDeactivated?: () => void,
 *   userId: string | null,
 *   editKeywordSet?: { id: string; product_description?: string; pitch_line?: string | null; scan_interval_hours?: number } | null,
 *   onSyncList?: () => void | Promise<void>,
 * }} props
 */
export default function AddMonitorModal({
  isOpen,
  onClose,
  onSuccess,
  onMonitorLimitReached,
  onDraftDeactivated,
  userId,
  editKeywordSet = null,
  onSyncList,
}) {
  const [description, setDescription] = useState('')
  const [pitchLine, setPitchLine] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [preview, setPreview] = useState(null)
  const [scanIntervalHours, setScanIntervalHours] = useState(6)
  const [submitLoading, setSubmitLoading] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [previewError, setPreviewError] = useState('')
  const editBaselineRef = useRef(null)

  const isEditMode = Boolean(editKeywordSet?.id)

  useEffect(() => {
    if (!isOpen) {
      editBaselineRef.current = null
      setDescription('')
      setPitchLine('')
      setPreview(null)
      setPreviewLoading(false)
      setScanIntervalHours(6)
      setSubmitLoading(false)
      setSubmitError('')
      setPreviewError('')
      return
    }

    if (editKeywordSet?.id) {
      const hours = Number(editKeywordSet.scan_interval_hours)
      const scanH = [6, 12, 24].includes(hours) ? hours : 6
      const pitch =
        editKeywordSet.pitch_line == null || editKeywordSet.pitch_line === ''
          ? null
          : String(editKeywordSet.pitch_line).trim()

      editBaselineRef.current = {
        product_description: String(editKeywordSet.product_description || '').trim(),
        scan_interval_hours: scanH,
        pitch_line: pitch,
      }

      setDescription(String(editKeywordSet.product_description || '').slice(0, MAX_CHARS))
      setPitchLine(pitch ? String(editKeywordSet.pitch_line) : '')
      setScanIntervalHours(scanH)
      setPreview(null)
      setPreviewLoading(false)
      setSubmitError('')
      setPreviewError('')
      return
    }

    editBaselineRef.current = null
    setDescription('')
    setPitchLine('')
    setPreview(null)
    setPreviewLoading(false)
    setScanIntervalHours(6)
    setSubmitError('')
    setPreviewError('')
  }, [isOpen, editKeywordSet])

  useEffect(() => {
    if (!isOpen) return undefined

    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, onClose])

  const trimmed = description.slice(0, MAX_CHARS).trim()
  const len = description.length
  const showAdvanced = isEditMode || trimmed.length >= 20

  const handleOverlayMouseDown = useCallback(
    (e) => {
      if (e.target === e.currentTarget) onClose()
    },
    [onClose]
  )

  async function handleGeneratePreview() {
    if (!trimmed) return

    setPreviewLoading(true)
    setPreviewError('')

    try {
      const { data } = await api.post('/api/keyword-sets/preview-example', {
        description: trimmed,
      })

      if (data?.title && data?.body) {
        setPreview({ title: data.title, body: data.body })
      } else {
        setPreview(null)
        setPreviewError('No preview returned. Try again.')
      }
    } catch (err) {
      setPreview(null)
      const msg =
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        err?.message ||
        'Could not generate preview.'
      setPreviewError(typeof msg === 'string' ? msg : 'Could not generate preview.')
    } finally {
      setPreviewLoading(false)
    }
  }

  async function revertEditBaseline() {
    const id = editKeywordSet?.id
    const b = editBaselineRef.current
    if (!id || !b) return

    await api.patch(`/api/keyword-sets/${id}`, {
      product_description: b.product_description,
      scan_interval_hours: b.scan_interval_hours,
      pitch_line: b.pitch_line,
    })

    setDescription(String(b.product_description || '').slice(0, MAX_CHARS))
    setPitchLine(b.pitch_line ? String(b.pitch_line) : '')
    setScanIntervalHours(b.scan_interval_hours)
  }

  async function handleSaveEdit() {
    if (!editKeywordSet?.id || !trimmed) {
      setSubmitError(!trimmed ? 'Describe your product first.' : 'Missing monitor.')
      return
    }

    setSubmitLoading(true)
    setSubmitError('')

    try {
      const body = {
        product_description: trimmed,
        scan_interval_hours: scanIntervalHours,
        pitch_line: pitchLine.trim() ? pitchLine.trim() : null,
      }

      const { data: updated } = await api.patch(`/api/keyword-sets/${editKeywordSet.id}`, body)

      if (updated?.fit_warning) {
        const suggestionText = updated.fit_suggestion || updated.suggestion || ''
        const suggestionBlock = suggestionText ? `Suggestion: ${suggestionText}\n\n` : ''
        const proceed = window.confirm(
          `⚠️ Reddit fit warning: ${updated.fit_warning}\n\n` +
            suggestionBlock +
            'Keep these changes anyway?'
        )
        if (!proceed) {
          await revertEditBaseline()
          await onSyncList?.()
          return
        }
      }

      await Promise.resolve(onSuccess?.(updated, { mode: 'edit' }))
    } catch (err) {
      const msg =
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        err?.message ||
        'Something went wrong.'
      setSubmitError(typeof msg === 'string' ? msg : 'Something went wrong.')
    } finally {
      setSubmitLoading(false)
    }
  }

  async function handleStartMonitoring() {
    if (!userId || !trimmed) {
      setSubmitError(!userId ? 'Not signed in.' : 'Describe your product first.')
      return
    }

    setSubmitLoading(true)
    setSubmitError('')

    try {
      const body = {
        user_id: userId,
        product_description: trimmed,
        scan_interval_hours: scanIntervalHours,
      }

      const pitch = pitchLine.trim()
      if (pitch) body.pitch_line = pitch

      const { data: created } = await api.post('/api/keyword-sets', body)

      if (created?.fit_warning) {
        const suggestionText = created.fit_suggestion || created.suggestion || ''
        const suggestionBlock = suggestionText ? `Suggestion: ${suggestionText}\n\n` : ''
        const proceed = window.confirm(
          `⚠️ Reddit fit warning: ${created.fit_warning}\n\n` +
            suggestionBlock +
            'Continue anyway?'
        )
        if (proceed) {
          await Promise.resolve(onSuccess?.(created, { mode: 'create' }))
        } else {
          try {
            await api.delete(`/api/keyword-sets/${created.id}`)
            onDraftDeactivated?.()
          } catch (_e) {
            // still let user edit
          }
          setDescription(String(created.product_description || '').slice(0, MAX_CHARS))
        }
      } else {
        await Promise.resolve(onSuccess?.(created, { mode: 'create' }))
      }
    } catch (err) {
      if (
        err?.response?.status === 403 &&
        err?.response?.data?.error === 'monitor_limit_reached'
      ) {
        onClose()
        onMonitorLimitReached?.()
        return
      }

      const msg =
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        err?.message ||
        'Something went wrong.'
      setSubmitError(typeof msg === 'string' ? msg : 'Something went wrong.')
    } finally {
      setSubmitLoading(false)
    }
  }

  async function handlePrimaryAction() {
    if (isEditMode) {
      await handleSaveEdit()
    } else {
      await handleStartMonitoring()
    }
  }

  if (!isOpen) return null

  const titleId = isEditMode ? 'edit-monitor-title' : 'add-monitor-title'

  return (
    <div
      className="add-monitor-overlay signal-btn-focus fixed inset-0 z-[100] flex items-center justify-center p-6"
      style={{
        background: 'rgba(0,0,0,0.75)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
      }}
      role="presentation"
      onMouseDown={handleOverlayMouseDown}
    >
      <div
        className="add-monitor-card signal-btn-focus relative w-full max-w-[520px] rounded-[12px] border p-8"
        style={{
          background: 'var(--surface)',
          borderColor: 'var(--border)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.55)',
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="signal-btn-focus absolute right-6 top-6 border-none bg-transparent p-1 font-mono text-[18px] leading-none transition-colors duration-150"
          style={{ color: 'var(--text-muted)' }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--text)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--text-muted)'
          }}
          aria-label="Close"
          onClick={onClose}
        >
          ×
        </button>

        <header className="pr-10">
          <h2 id={titleId} className="font-mono" style={{ fontSize: '18px', color: 'var(--text)' }}>
            {isEditMode ? 'Edit monitor' : 'New Monitor'}
          </h2>
          <p className="mt-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            {isEditMode
              ? 'Update the description, how often Signal scans, and how you’d naturally mention your product in a thread.'
              : 'Describe what you sell. Signal finds people who need it.'}
          </p>
        </header>

        <div className="mt-8">
          <label
            className="mb-2 block font-mono"
            style={{
              fontSize: '10px',
              letterSpacing: '0.1em',
              color: 'var(--text-muted)',
            }}
          >
            YOUR PRODUCT OR SERVICE
          </label>
          <textarea
            rows={3}
            maxLength={MAX_CHARS}
            value={description}
            placeholder="e.g. invoicing software for freelancers who hate chasing payments"
            className="signal-btn-focus w-full resize-none rounded-[6px] border px-3 py-3 font-sans text-[14px] outline-none transition-[border-color] duration-150"
            style={{
              background: 'var(--surface-2)',
              borderColor: 'var(--border)',
              color: 'var(--text)',
              fontFamily: '"IBM Plex Sans", system-ui, sans-serif',
            }}
            onChange={(e) => setDescription(e.target.value.slice(0, MAX_CHARS))}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--accent)'
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'var(--border)'
            }}
          />
          <p className="mt-1 text-right font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {len} / {MAX_CHARS}
          </p>
        </div>

        <div className="mt-6">
          <label
            className="mb-1 block font-mono"
            style={{
              fontSize: '10px',
              letterSpacing: '0.1em',
              color: 'var(--text-muted)',
            }}
          >
            HOW WOULD YOU MENTION IT IN A COMMENT?{' '}
            <span className="font-normal not-italic">(optional)</span>
          </label>
          <p className="mb-2 text-[11px] italic" style={{ color: 'var(--text-muted)' }}>
            Write it how you&apos;d say it naturally on Reddit
          </p>
          <input
            type="text"
            value={pitchLine}
            placeholder='e.g. "I use HoneyBook for this — handles contracts + invoices, honeybook.com"'
            className="signal-btn-focus w-full rounded-[6px] border px-3 py-2.5 font-sans text-[14px] outline-none transition-[border-color] duration-150"
            style={{
              background: 'var(--surface-2)',
              borderColor: 'var(--border)',
              color: 'var(--text)',
              fontFamily: '"IBM Plex Sans", system-ui, sans-serif',
            }}
            onChange={(e) => setPitchLine(e.target.value)}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--accent)'
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'var(--border)'
            }}
          />
        </div>

        {showAdvanced && (
          <div className="add-monitor-preview-reveal mt-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span
                className="font-mono"
                style={{
                  fontSize: '10px',
                  letterSpacing: '0.08em',
                  color: 'var(--text-muted)',
                }}
              >
                SIGNAL WILL FIND POSTS LIKE THIS
              </span>
              <button
                type="button"
                className="signal-btn-focus border-none bg-transparent p-0 font-mono text-[11px] transition-opacity duration-150"
                style={{
                  color: 'var(--accent)',
                  cursor: previewLoading ? 'wait' : 'pointer',
                  opacity: previewLoading ? 0.75 : 1,
                }}
                disabled={previewLoading}
                onClick={() => {
                  void handleGeneratePreview()
                }}
              >
                {previewLoading ? (
                  <span className="inline-flex items-center gap-2">
                    <span
                      className="inline-block h-1.5 w-1.5 rounded-full"
                      style={{
                        background: 'var(--accent)',
                        animation: 'signal-pulse 1.05s ease-in-out infinite',
                      }}
                    />
                    Generating...
                  </span>
                ) : (
                  'Generate Preview'
                )}
              </button>
            </div>

            {previewError ? (
              <p className="mt-2 text-[12px]" style={{ color: 'var(--red)' }}>
                {previewError}
              </p>
            ) : null}

            {preview && (
              <>
                <div
                  className="mt-[10px] rounded-lg border p-4"
                  style={{
                    background: 'var(--bg)',
                    borderColor: 'var(--border)',
                    borderRadius: '8px',
                  }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px]" aria-hidden>
                      👽
                    </span>
                    <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                      r/smallbusiness
                    </span>
                    <span
                      className="rounded px-1.5 py-0.5 font-mono"
                      style={{
                        fontSize: '9px',
                        background: 'var(--accent-dim)',
                        color: 'var(--accent)',
                        borderRadius: '4px',
                        padding: '2px 6px',
                      }}
                    >
                      example post
                    </span>
                  </div>
                  <p
                    className="mt-2 text-[14px] font-semibold leading-snug"
                    style={{ color: 'var(--text)', marginTop: '8px' }}
                  >
                    {preview.title}
                  </p>
                  <p
                    className="mt-1.5 text-[13px] leading-[1.6]"
                    style={{
                      color: 'var(--text-muted)',
                      marginTop: '6px',
                      display: '-webkit-box',
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    {preview.body}
                  </p>
                </div>
                <p
                  className="mt-3 text-[11px] italic"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Signal scans Reddit on your schedule ({scanIntervalHours}h) and surfaces real posts
                  like this one.
                </p>
              </>
            )}

            <div className="mt-6">
              <label
                className="mb-2 block font-mono"
                style={{
                  fontSize: '10px',
                  letterSpacing: '0.1em',
                  color: 'var(--text-muted)',
                }}
              >
                SCAN FREQUENCY
              </label>
              <div className="flex flex-wrap gap-2">
                {[
                  { label: 'Every 6h', hours: 6 },
                  { label: 'Every 12h', hours: 12 },
                  { label: 'Every 24h', hours: 24 },
                ].map(({ label, hours }) => {
                  const selected = scanIntervalHours === hours
                  return (
                    <button
                      key={hours}
                      type="button"
                      className="signal-btn-focus rounded-[6px] border px-4 py-2 font-sans text-[12px] transition-colors duration-150"
                      style={{
                        background: selected ? 'var(--accent)' : 'var(--surface-2)',
                        borderColor: selected ? 'var(--accent)' : 'var(--border)',
                        borderWidth: '1px',
                        color: selected ? '#000' : 'var(--text-muted)',
                        fontWeight: selected ? 600 : 400,
                        cursor: 'pointer',
                      }}
                      onClick={() => setScanIntervalHours(hours)}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        <div className="mt-8 flex gap-3">
          <button
            type="button"
            className="signal-btn-focus min-w-0 flex-1 rounded-[6px] border py-3 font-mono text-[13px]"
            style={{
              background: 'transparent',
              borderColor: 'var(--border)',
              color: 'var(--text-muted)',
              cursor: 'pointer',
            }}
            disabled={submitLoading}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`signal-btn-focus min-w-0 flex-[2] rounded-[6px] border-none py-3 font-mono text-[13px] font-bold ${
              submitLoading ? 'add-monitor-submit-loading' : ''
            }`}
            style={{
              background: 'var(--accent)',
              color: '#000',
              cursor: submitLoading || (!isEditMode && !userId) ? 'not-allowed' : 'pointer',
              opacity: !isEditMode && !userId ? 0.55 : 1,
            }}
            disabled={submitLoading || !trimmed || (!isEditMode && !userId)}
            onClick={() => {
              void handlePrimaryAction()
            }}
          >
            {submitLoading
              ? isEditMode
                ? 'Saving…'
                : 'Setting up...'
              : isEditMode
                ? 'Save changes'
                : 'Start Monitoring'}
          </button>
        </div>

        {submitError ? (
          <p className="mt-3 text-center text-[12px]" style={{ color: 'var(--red)' }}>
            {submitError}
          </p>
        ) : null}
      </div>
    </div>
  )
}
