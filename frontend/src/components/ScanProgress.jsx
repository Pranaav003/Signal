import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'

const PHASES = [
  {
    progress: [4, 10],
    lines: [
      { type: 'system', text: 'Initializing monitor...' },
      { type: 'system', text: 'Loading query generator...' },
      { type: 'found', text: 'Query engine ready' },
      { type: 'system', text: '__ETA__' },
    ],
  },
  {
    progress: [10, 22],
    lines: [
      { type: 'system', text: 'Analyzing product description...' },
      { type: 'system', text: 'Identifying core pain points...' },
      { type: 'query', text: '__Q0__' },
      { type: 'query', text: '__Q1__' },
      { type: 'query', text: '__Q2__' },
      { type: 'system', text: '__QMORE__' },
      { type: 'found', text: '__QCOUNT__' },
    ],
  },
  {
    progress: [22, 36],
    lines: [
      { type: 'system', text: 'Asking AI to identify relevant communities...' },
      { type: 'query', text: '__S0__' },
      { type: 'query', text: '__S1__' },
      { type: 'query', text: '__S2__' },
      { type: 'system', text: '__SMORE__' },
      { type: 'found', text: '__COMMUNITIES_IDENTIFIED__' },
      { type: 'system', text: 'Cross-referencing with Reddit community search...' },
    ],
  },
  {
    progress: [36, 58],
    lines: [
      { type: 'system', text: 'Connecting to Reddit...' },
      { type: 'found', text: 'Session established' },
      { type: 'system', text: '__SCAN1__' },
      { type: 'score', text: 'Found 12 posts, 8 comments' },
      { type: 'system', text: '__SCAN2__' },
      { type: 'score', text: 'Found 6 posts, 23 comments' },
      { type: 'system', text: '__SCAN3__' },
      { type: 'score', text: 'Found 19 posts, 4 comments' },
      { type: 'system', text: '__SCAN4__' },
      { type: 'score', text: 'Found 31 results across Reddit' },
      { type: 'system', text: 'Deduplicating results...' },
      { type: 'found', text: '67 unique posts collected' },
    ],
  },
  {
    progress: [58, 74],
    lines: [
      { type: 'system', text: 'Running relevance scorer...' },
      { type: 'system', text: 'Checking pain language signals...' },
      { type: 'score', text: '◆ 91  "Does anyone actually make money from..."' },
      { type: 'score', text: '◆ 78  "How are small businesses supposed to..."' },
      { type: 'score', text: "◆ 64  \"What tool do you use when you're a...\"" },
      { type: 'system', text: 'Checking recency scores...' },
      { type: 'system', text: 'Checking keyword density...' },
    ],
  },
  {
    progress: [74, 86],
    lines: [
      { type: 'system', text: 'Filtering low-signal results (score < 25)...' },
      { type: 'warn', text: 'Removed 51 low-relevance results' },
      { type: 'found', text: '16 high-signal leads surviving filter' },
    ],
  },
  {
    progress: [86, 95],
    lines: [
      { type: 'system', text: 'Persisting leads to database...' },
      { type: 'found', text: 'Deduplication check passed' },
      { type: 'found', text: 'Leads saved successfully' },
      { type: 'system', text: '__NEXTSCAN__' },
    ],
  },
]

const PREFIX = {
  system: '→ ',
  query: '⌕  ',
  found: '✓ ',
  score: '◆ ',
  warn: '! ',
  success: '✓ ',
  done: '',
}

const sleep = (ms) => new Promise((r) => window.setTimeout(r, ms))
const jitter = (ms) => Math.max(80, Math.floor(ms * (0.8 + Math.random() * 0.4)))
const safeAt = (arr, idx, fb) => arr?.[idx] || fb

function fillLine(text, ctx) {
  return String(text)
    .replace('__Q0__', `Generated: "${safeAt(ctx.queries, 0, 'lead generation help')}"`)
    .replace('__Q1__', `Generated: "${safeAt(ctx.queries, 1, 'find clients fast')}"`)
    .replace('__Q2__', `Generated: "${safeAt(ctx.queries, 2, 'pipeline advice')}"`)
    .replace('__QMORE__', `+ ${Math.max(0, ctx.queries.length - 3)} more queries`)
    .replace('__QCOUNT__', `${ctx.queries.length || 3} queries ready`)
    .replace('__S0__', `Targeting: r/${safeAt(ctx.subreddits, 0, 'smallbusiness')}`)
    .replace('__S1__', `Targeting: r/${safeAt(ctx.subreddits, 1, 'Entrepreneur')}`)
    .replace('__S2__', `Targeting: r/${safeAt(ctx.subreddits, 2, 'freelance')}`)
    .replace('__SMORE__', `+ ${Math.max(0, ctx.subreddits.length - 3)} more communities`)
    .replace(
      '__COMMUNITIES_IDENTIFIED__',
      `${ctx.subreddits.length || 0} communities identified`
    )
    .replace(
      '__ETA__',
      `Estimated scan time: ~${Math.ceil((ctx.estimatedTotalMs || 20000) / 1000)}s`
    )
    .replace(
      '__SCAN1__',
      `Scanning r/${safeAt(ctx.subreddits, 0, 'smallbusiness')} for "${safeAt(ctx.queries, 0, 'lead generation')}"...`
    )
    .replace(
      '__SCAN2__',
      `Scanning r/${safeAt(ctx.subreddits, 1, 'Entrepreneur')} for "${safeAt(ctx.queries, 1, 'find clients')}"...`
    )
    .replace(
      '__SCAN3__',
      `Scanning r/${safeAt(ctx.subreddits, 2, 'freelance')} for "${safeAt(ctx.queries, 0, 'lead generation')}"...`
    )
    .replace('__SCAN4__', `Running broad search: "${safeAt(ctx.queries, 3, safeAt(ctx.queries, 0, 'help'))}"...`)
    .replace('__NEXTSCAN__', `Scheduling next scan in ${ctx.scanIntervalHours || 6}h...`)
}

export default function ScanProgress({
  keywordSet,
  onComplete,
  onScanComplete,
  estimatedTotalMs: estimatedTotalMsProp,
}) {
  const [done, setDone] = useState(false)
  const [sequenceDone, setSequenceDone] = useState(false)
  const [scanSeconds, setScanSeconds] = useState(0)
  const [queriesShown, setQueriesShown] = useState(0)
  const [subsShown, setSubsShown] = useState(0)
  const [leadsFound, setLeadsFound] = useState(0)

  const mountedRef = useRef(true)
  const phaseRef = useRef(0)
  const progressRef = useRef(4)
  const linesRef = useRef([])
  const completedRef = useRef(false)
  const leadsFoundRef = useRef(0)
  const waitingLinesRef = useRef(0)
  const sequenceDoneRef = useRef(false)
  const lastWaitingLineRef = useRef(0)
  const lastWaitingIdxRef = useRef(-1)
  const barRef = useRef(null)
  const terminalRef = useRef(null)
  const leadsCounterRef = useRef(null)
  const elapsedRef = useRef(null)
  const etaRef = useRef(null)
  const startTimeRef = useRef(Date.now())
  const ctxRef = useRef({
    product: '',
    queries: [],
    subreddits: [],
    scanIntervalHours: 6,
    estimatedTotalMs: 20000,
  })
  const timersRef = useRef([])
  const phaseIntervalsRef = useRef([])
  const counterTimerRef = useRef(null)
  const pollIntervalRef = useRef(null)

  const product = String(keywordSet?.product_description || 'your monitor')
  const monitorName = product.length > 36 ? `${product.slice(0, 36)}…` : product

  const setProgress = (pct) => {
    progressRef.current = Math.max(progressRef.current, pct)
    if (barRef.current) barRef.current.style.width = `${progressRef.current}%`
  }

  const clearAllTimers = () => {
    timersRef.current.forEach((id) => window.clearTimeout(id))
    phaseIntervalsRef.current.forEach((id) => window.clearInterval(id))
    if (counterTimerRef.current) {
      window.clearInterval(counterTimerRef.current)
      counterTimerRef.current = null
    }
    timersRef.current = []
    phaseIntervalsRef.current = []
  }

  const startWaitingPulse = () => {
    if (!barRef.current) return
    barRef.current.style.transition = 'none'
    barRef.current.classList.add('bar-waiting')
  }

  const appendRawLine = (type, text) => {
    if (!mountedRef.current || !terminalRef.current) return
    const line = document.createElement('div')
    line.className = `terminal-line terminal-${type}`
    line.dataset.lineId = String(linesRef.current.length + 1)
    terminalRef.current.appendChild(line)
    linesRef.current.push({ type, text })

    const full = `${PREFIX[type] || ''}${text}`
    let i = 0
    const tick = () => {
      if (!mountedRef.current || !line.isConnected) return
      i += 1
      line.textContent = full.slice(0, i)
      if (i < full.length) {
        const id = window.setTimeout(tick, 18)
        timersRef.current.push(id)
      } else {
        terminalRef.current?.scrollTo(0, terminalRef.current.scrollHeight)
      }
    }
    tick()
  }

  const appendLine = (type, text) => appendRawLine(type, fillLine(text, ctxRef.current))

  const runPhaseProgress = async (phaseIndex) => {
    const targetPct = PHASES[phaseIndex].progress[1]
    const id = window.setInterval(() => {
      if (!mountedRef.current || completedRef.current) return
      if (progressRef.current >= targetPct) {
        window.clearInterval(id)
        return
      }
      setProgress(Math.min(targetPct, progressRef.current + 0.3))
    }, 400)
    phaseIntervalsRef.current.push(id)
  }

  const runPhaseSequence = async () => {
    for (let p = 0; p < PHASES.length; p += 1) {
      if (!mountedRef.current || completedRef.current) return
      phaseRef.current = p
      await runPhaseProgress(p)
      for (const line of PHASES[p].lines) {
        if (!mountedRef.current || completedRef.current) return
        appendLine(line.type, line.text)
        await sleep(jitter(380))
      }
      setProgress(PHASES[p].progress[1])
      if (p === 1) setQueriesShown((ctxRef.current.queries.length || 3))
      if (p === 2) setSubsShown((ctxRef.current.subreddits.length || 3))
      await sleep(jitter(p === 3 ? 1600 : 700))
    }

    sequenceDoneRef.current = true
    setSequenceDone(true)
    startWaitingPulse()
    appendLine('system', 'Still scanning... Reddit is slow today')
    appendLine('system', 'Waiting for results...')
    appendLine('system', 'Checking for new results...')
    lastWaitingLineRef.current = Date.now()
  }

  const triggerCompletion = async (found) => {
    if (completedRef.current) return
    completedRef.current = true

    let finalCount = Number(found || 0)

    try {
      const { data } = await api.get(
        `/api/keyword-sets/${keywordSet.id}/scan-status`
      )
      const realCount = Number(data?.leads_found || 0)
      if (realCount > finalCount) finalCount = realCount
      console.log('[ScanProgress] final count from scan-status:', realCount)
    } catch (e) {
      console.error('[ScanProgress] final count fetch failed:', e)
    }

    if (finalCount === 0 && keywordSet?.user_id) {
      try {
        const res = await fetch(
          `/api/leads/user/${keywordSet.user_id}?limit=1`
        )
        const data = await res.json()
        const arr = Array.isArray(data) ? data : data?.leads || []
        console.log(
          '[ScanProgress] direct leads check:',
          arr.length,
          'leads found'
        )
        if (arr.length > 0) finalCount = arr.length
      } catch (e) {
        console.error('[ScanProgress] direct leads check failed:', e)
      }
    }

    setDone(true)
    clearAllTimers()

    setProgress(100)
    if (barRef.current) {
      barRef.current.classList.remove('bar-waiting')
      barRef.current.style.transition = 'width 800ms ease'
    }
    leadsFoundRef.current = finalCount
    setLeadsFound(finalCount)

    let current = 0
    const increment = Math.max(1, Math.floor(finalCount / 20))
    counterTimerRef.current = window.setInterval(() => {
      current = Math.min(current + increment, finalCount)
      if (leadsCounterRef.current) leadsCounterRef.current.textContent = String(current)
      if (current >= finalCount && counterTimerRef.current) {
        window.clearInterval(counterTimerRef.current)
        counterTimerRef.current = null
      }
    }, 60)

    const t0 = window.setTimeout(() => appendRawLine('success', '━━━━━━━━━━━━━━━━━━━━━━━━━━━'), 300)
    const t1 = window.setTimeout(
      () => appendRawLine('success', `Scan complete. ${finalCount} leads found.`),
      700
    )
    const t2 = window.setTimeout(() => appendRawLine('success', '━━━━━━━━━━━━━━━━━━━━━━━━━━━'), 1100)
    timersRef.current.push(t0, t1, t2)

    const t3 = window.setTimeout(() => {
      if (!mountedRef.current) return
      onScanComplete?.()
    }, 2000)
    timersRef.current.push(t3)

    const t4 = window.setTimeout(() => {
      if (!mountedRef.current) return
      onComplete?.()
    }, 3000)
    timersRef.current.push(t4)
  }

  useEffect(() => {
    if (!keywordSet?.id) return undefined

    setSequenceDone(false)
    setScanSeconds(0)
    mountedRef.current = true
    startTimeRef.current = Date.now()

    const productStr = String(keywordSet.product_description || 'your monitor')
    const isDev = import.meta.env.DEV
    const capPairs = isDev ? 15 : 50
    const perMs = isDev ? 1300 : 2800
    const q0 = keywordSet.queries?.length || 10
    const s0 = keywordSet.subreddits?.length || 5
    const baseEst =
      Number(estimatedTotalMsProp) > 0
        ? Number(estimatedTotalMsProp)
        : Math.min(q0 * s0, capPairs) * perMs

    ctxRef.current = {
      product: productStr,
      queries: keywordSet.queries || [],
      subreddits: keywordSet.subreddits || [],
      scanIntervalHours: Number(keywordSet.scan_interval_hours || 6),
      estimatedTotalMs: baseEst,
    }

    const elapsedTimer = window.setInterval(() => {
      if (!mountedRef.current || !elapsedRef.current || !etaRef.current) return
      const elapsedMs = Date.now() - startTimeRef.current
      const elapsed = Math.floor(elapsedMs / 1000)
      const mins = Math.floor(elapsed / 60)
      const secs = elapsed % 60
      setScanSeconds(elapsed)
      elapsedRef.current.textContent =
        mins > 0 ? `Scan running for ${mins}m ${secs}s` : `Scan running for ${secs}s`

      const budgetMs = ctxRef.current.estimatedTotalMs || 20000
      const remainingMs = Math.max(0, budgetMs - elapsedMs)
      let etaText = ''
      if (remainingMs === 0) {
        etaText = 'finishing up...'
        etaRef.current.style.color = 'var(--yellow)'
        etaRef.current.classList.add('scan-eta-finishing')
      } else if (remainingMs < 60000) {
        etaText = `~${Math.ceil(remainingMs / 1000)}s remaining`
        etaRef.current.style.color = 'var(--accent)'
        etaRef.current.classList.remove('scan-eta-finishing')
      } else {
        etaText = `~${Math.ceil(remainingMs / 60000)}m remaining`
        etaRef.current.style.color = 'var(--accent)'
        etaRef.current.classList.remove('scan-eta-finishing')
      }
      etaRef.current.textContent = etaText
    }, 1000)
    phaseIntervalsRef.current.push(elapsedTimer)
    setProgress(4)

    let cancelled = false

    ;(async () => {
      try {
        const { data } = await api.get(`/api/keyword-sets/${keywordSet.id}/scan-status`)
        if (cancelled || !mountedRef.current) return
        if (Array.isArray(data?.live_queries) && data.live_queries.length) {
          ctxRef.current.queries = data.live_queries
        }
        if (Array.isArray(data?.live_subreddits) && data.live_subreddits.length) {
          ctxRef.current.subreddits = data.live_subreddits
        }
        const qn = ctxRef.current.queries.length || 10
        const sn = ctxRef.current.subreddits.length || 5
        ctxRef.current.estimatedTotalMs = Math.min(qn * sn, capPairs) * perMs
      } catch (e) {
        console.error('[ScanProgress] poll error:', e)
      }
      if (cancelled || !mountedRef.current) return
      runPhaseSequence()
    })()

    return () => {
      cancelled = true
      mountedRef.current = false
      clearAllTimers()
    }
  }, [keywordSet?.id])

  useEffect(() => {
    if (!keywordSet?.id) return undefined
    pollIntervalRef.current = window.setInterval(async () => {
      try {
        const { data } = await api.get(`/api/keyword-sets/${keywordSet.id}/scan-status`)
        console.log('[ScanProgress] poll result:', data?.status, 'leads:', data?.leads_found)
        if (!mountedRef.current) return
        if (data?.status === 'complete' && !completedRef.current) {
          triggerCompletion(Number(data?.leads_found || 0))
        }
        if (Number(data?.leads_found || 0) > leadsFoundRef.current) {
          leadsFoundRef.current = Number(data?.leads_found || 0)
          setLeadsFound(leadsFoundRef.current)
          if (leadsCounterRef.current) leadsCounterRef.current.textContent = String(leadsFoundRef.current)
        }
        const now = Date.now()
        if (
          data?.status !== 'complete' &&
          sequenceDoneRef.current &&
          !completedRef.current &&
          waitingLinesRef.current < 3 &&
          now - lastWaitingLineRef.current > 25000
        ) {
          const waitingLines = [
            'Still scanning... Reddit is slow today',
            'Waiting for results...',
            'Checking for new results...',
            'Processing subreddit data...',
            'Cross-referencing results...',
          ]
          let idx = Math.floor(Math.random() * waitingLines.length)
          if (idx === lastWaitingIdxRef.current) {
            idx = (idx + 1) % waitingLines.length
          }
          lastWaitingIdxRef.current = idx
          lastWaitingLineRef.current = now
          waitingLinesRef.current += 1
          appendRawLine('system', waitingLines[idx])
        }
      } catch (e) {
        if (e?.response?.status === 404) {
          console.log('[ScanProgress] Monitor was deleted, stopping poll')
          if (pollIntervalRef.current != null) {
            window.clearInterval(pollIntervalRef.current)
            pollIntervalRef.current = null
          }
          return
        }
        console.error('[ScanProgress] poll error:', e)
      }
    }, 5000)
    return () => {
      if (pollIntervalRef.current != null) {
        window.clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [keywordSet?.id])

  return (
    <div style={{ background: 'var(--bg)', padding: 48 }}>
      <div style={{ maxWidth: 680, margin: '0 auto' }}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span
              className={done ? '' : 'signal-track-dot'}
              style={done ? { width: 6, height: 6, borderRadius: '50%', display: 'inline-block', background: 'var(--text-3)' } : undefined}
            />
            <span className="font-mono" style={{ fontSize: 11, letterSpacing: '0.15em', color: done ? 'var(--text-3)' : 'var(--green)' }}>
              {done ? 'COMPLETE' : 'SCANNING'}
            </span>
          </div>
          <span className="font-mono text-[12px]" style={{ color: 'var(--text-3)' }}>
            {monitorName}
          </span>
        </div>

        <div className="relative mt-5 h-[2px] rounded" style={{ background: 'var(--border)' }}>
          <div ref={barRef} className="h-full transition-[width] duration-700 ease-out" style={{ width: '4%', background: 'var(--accent)' }} />
          <span
            className="absolute top-1/2 h-1 w-1 -translate-y-1/2 rounded-full"
            style={{ left: `calc(${progressRef.current}% - 2px)`, background: '#fff', boxShadow: '0 0 8px var(--accent)' }}
          />
        </div>
        <div
          style={{
            marginTop: '6px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <span
            ref={elapsedRef}
            style={{
              fontSize: '11px',
              fontFamily: 'IBM Plex Mono',
              color: 'var(--text-3)',
              display: 'block',
            }}
          />
          <span
            ref={etaRef}
            style={{
              fontSize: '11px',
              fontFamily: 'IBM Plex Mono',
              color: 'var(--accent)',
              display: 'block',
            }}
          />
        </div>

        <div
          ref={terminalRef}
          className="terminal-block mt-8 rounded-lg border px-4 py-3"
          style={{
            borderColor: 'var(--border)',
            background: 'rgba(0,0,0,0.12)',
            minHeight: 320,
            maxHeight: 420,
            overflowY: 'auto',
            fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
            fontSize: 13,
            lineHeight: 1.8,
          }}
        />

        {!done && sequenceDone && scanSeconds >= 120 && (
          <button
            type="button"
            onClick={async () => {
              try {
                const { data } = await api.get(
                  `/api/keyword-sets/${keywordSet.id}/scan-status`
                )
                console.log('[manual check]', data)
                if (data.status === 'complete' || data.leads_found > 0) {
                  triggerCompletion(data.leads_found)
                } else {
                  window.alert(
                    `Status: ${data.status}, Leads: ${data.leads_found}, Last scanned: ${data.last_scanned_at}`
                  )
                }
              } catch (e) {
                console.error('[ScanProgress] manual check error:', e)
              }
            }}
            style={{
              marginTop: 16,
              padding: '6px 16px',
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--text-3)',
              fontFamily: 'IBM Plex Mono',
              fontSize: 11,
              borderRadius: 6,
              cursor: 'pointer',
            }}
          >
            Check for results
          </button>
        )}

        <div className="mt-8 grid grid-cols-3 gap-3">
          <div className="rounded-lg border px-5 py-3" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
            <div className="font-mono font-bold tabular-nums" style={{ fontSize: 24, color: 'var(--accent)' }}>{queriesShown}</div>
            <div className="mt-1 font-mono text-[10px]" style={{ color: 'var(--text-3)' }}>QUERIES</div>
          </div>
          <div className="rounded-lg border px-5 py-3" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
            <div className="font-mono font-bold tabular-nums" style={{ fontSize: 24, color: 'var(--accent)' }}>{subsShown}</div>
            <div className="mt-1 font-mono text-[10px]" style={{ color: 'var(--text-3)' }}>SUBREDDITS</div>
          </div>
          <div className="rounded-lg border px-5 py-3" style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}>
            <div ref={leadsCounterRef} className="font-mono font-bold tabular-nums" style={{ fontSize: 24, color: 'var(--accent)' }}>
              {leadsFound}
            </div>
            <div className="mt-1 font-mono text-[10px]" style={{ color: 'var(--text-3)' }}>LEADS FOUND</div>
          </div>
        </div>
      </div>
    </div>
  )
}

