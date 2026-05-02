import { useMemo, useState } from 'react'

import { formatRelativeTime } from '../lib/time'

function scorePalette(score) {
  if (score >= 70) return { accent: 'var(--accent)', text: 'var(--accent)' }

  if (score >= 40) return { accent: 'var(--warn)', text: 'var(--warn)' }

  return { accent: 'var(--muted)', text: 'var(--muted)' }

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

export default function LeadCard({ lead, onMarkSeen, onDismiss, onGenerateDraft }) {
  const scoreNum = Number(lead?.relevance_score ?? 0)
  const palette = useMemo(() => scorePalette(scoreNum), [scoreNum])

  const title = String(lead?.title ?? '')
  const body = String(lead?.body_snippet ?? '')
  const subtitle = title || body.slice(0, 100)

  const draftText =
    typeof lead?.ai_draft === 'string' && lead.ai_draft.length > 0
      ? lead.ai_draft
      : ''

  const [draftBusy, setDraftBusy] = useState(false)
  const [copiedFlash, setCopiedFlash] = useState(false)

  const draftOpen = draftBusy || Boolean(draftText)

  async function runDraft() {


    setDraftBusy(true)



    try {
      await onGenerateDraft(lead.id)

    }

    finally {
      setDraftBusy(false)

    }


  }


  async function handleCopy() {


    if (!draftText) return



    await safeCopy(draftText)



    setCopiedFlash(true)



    window.setTimeout(() => setCopiedFlash(false), 2000)


  }


  const buttonsDisabled = draftBusy



  const showSpinner = draftBusy && !draftText



  return (

    <article

      className="signal-btn-focus mb-2 rounded-lg border transition-shadow"

      style={{
        background: 'var(--surface)',
        borderColor: 'var(--border)',
        borderLeftWidth: '3px',

        borderLeftStyle: 'solid',
        borderLeftColor: palette.accent,
      }}

      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = `inset 0 0 0 1px var(--accent-glow)`

      }}

      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = `none`


      }}

    >

      <div className="flex gap-4 p-4">

        <aside className="w-[60px] shrink-0 text-center">

          <p
            className="font-mono text-[36px] leading-none"
            style={{ color: palette.text, fontVariantNumeric: 'tabular-nums' }}

          >
            {Number.isFinite(scoreNum) ? String(scoreNum) : '–'}
          </p>

          <p
            className="mt-1 font-mono text-[9px] tracking-[0.18em]"
            style={{ color: 'var(--muted)', textTransform: 'uppercase' }}

          >
            Score

          </p>

        </aside>

        <div className="min-w-0 flex-1">

          <div className="mb-2 flex items-start gap-4">

            <div className="min-w-0 flex-1">

              <span
                className="inline-flex items-center rounded px-2 py-0.5 font-mono text-[11px]"
                style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}

              >
                r/{lead.subreddit || 'unknown'}
              </span>

            </div>

            <div className="text-right">

              <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
                {lead.author ?? 'anonymous'}
              </p>

              <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
                {formatRelativeTime(lead.created_utc)} ago

              </p>

            </div>

          </div>

          <p className="text-[14px] leading-snug" style={{ color: 'var(--text)' }}>
            {subtitle}

          </p>

          {title && body && (
            <p
              className="mt-3 line-clamp-2 text-[13px]"
              style={{ color: 'var(--muted)' }}

            >
              {body}

            </p>

          )}



          <div className="mt-4 flex flex-wrap items-center gap-4">

            <a

              href={lead.url ?? '#'}

              target="_blank"
              rel="noreferrer"

              className="font-mono text-[12px] no-underline"
              style={{ color: 'var(--accent)', opacity: lead.url ? 1 : 0.35 }}

            >
              View Post →


            </a>

            <button
              type="button"
              className="rounded-md border px-3 py-1 font-mono text-[11px]"
              style={{
                borderColor: 'var(--accent)',
                color: 'var(--accent)',
                background: 'transparent',
                opacity: buttonsDisabled ? 0.65 : 1,

              }}

              disabled={buttonsDisabled}



              onClick={runDraft}
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

              )


              :

              'Draft Reply'}

            </button>

            <button
              type="button"

              className="rounded-md border px-3 py-1 font-mono text-[11px]"

              style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}

              disabled={buttonsDisabled}




              onClick={() => onMarkSeen(lead.id)}

            >
              Mark Read

            </button>

            <button
              type="button"
              className="bg-transparent px-2 py-1 font-mono text-[11px]"
              style={{ color: 'var(--muted)' }}

              disabled={buttonsDisabled}

              onClick={() => onDismiss(lead.id)}

            >
              Dismiss

            </button>

          </div>

        </div>

      </div>

      {draftOpen && (

        <div

          className="signal-draft-panel border-t"

          style={{ borderTop: '1px dashed var(--border)', background: 'var(--surface-2)' }}

        >

          <div className="px-4 pb-4 pt-3" style={{ maxHeight: 200, overflow: 'auto' }}>

            <p
              className="mb-2 font-mono text-[10px] tracking-[0.24em]"
              style={{ color: 'var(--muted)', textTransform: 'uppercase' }}

            >
              AI DRAFT

            </p>

            {showSpinner ? (

              <div className="flex items-center gap-2">

                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{
                    background: 'var(--accent)',
                    animation: 'signal-pulse 1.05s ease-in-out infinite',
                  }}

                />

                <p style={{ color: 'var(--muted)' }}>Drafting...</p>

              </div>

            )

            :

            (

              <p className="whitespace-pre-wrap text-[13px]" style={{ color: 'var(--text)' }}>
                {draftText}

              </p>

            )}



            <div className="mt-4 flex flex-wrap gap-4">

              <button
                type="button"
                className="rounded-md border px-3 py-1 font-mono text-[11px]"
                style={{
                  borderColor: 'var(--border)',
                  color: copiedFlash ? 'var(--accent)' : 'var(--muted)',
                }}

                disabled={buttonsDisabled || !draftText}

                onClick={handleCopy}

              >
                {copiedFlash ? 'Copied ✓' : 'Copy'}

              </button>

              <button
                type="button"
                className="rounded-md border px-3 py-1 font-mono text-[11px]"
                style={{
                  borderColor: 'var(--border)',
                  color: 'var(--muted)',
                  opacity: draftBusy ? 0.55 : 1,

                }}

                disabled={buttonsDisabled}



                title="Runs the generator again"

                onClick={() => {


                  void runDraft()

                }}

              >
                Regenerate

              </button>

            </div>

          </div>

        </div>

      )}


    </article>

  )
}
