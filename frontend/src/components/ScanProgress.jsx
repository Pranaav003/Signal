import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { formatZeroLeadsDiagnostic } from '../lib/scanDiagnostics'

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
      { type: 'score', text: 'Collecting posts and comments from Reddit…' },
      { type: 'system', text: '__SCAN2__' },
      { type: 'score', text: 'Collecting more thread matches…' },
      { type: 'system', text: '__SCAN3__' },
      { type: 'score', text: 'Aggregating subreddit results…' },
      { type: 'system', text: '__SCAN4__' },
      { type: 'score', text: 'Broad search results merged' },
      { type: 'system', text: 'Deduplicating results...' },
      { type: 'found', text: 'Unique posts collected for scoring' },
    ],
  },
  {
    progress: [58, 74],
    lines: [
      { type: 'system', text: 'Running relevance scorer...' },
      { type: 'system', text: 'Checking pain language signals...' },
      { type: 'score', text: '◆ Sample match: high intent language detected' },
      { type: 'score', text: '◆ Sample match: pain-point phrasing' },
      { type: 'score', text: '◆ Sample match: tool / workflow question' },
      { type: 'system', text: 'Checking recency scores...' },
      { type: 'system', text: 'Checking keyword density...' },
    ],
  },
  {
    progress: [74, 86],
    lines: [
      { type: 'system', text: 'Backend is scoring candidates…' },
      { type: 'system', text: 'Waiting for worker relevance scores…' },
      { type: 'system', text: 'Database results will appear when the worker finishes…' },
    ],
  },
  {
    progress: [86, 95],
    lines: [
      { type: 'system', text: 'Waiting for backend worker results…' },
      { type: 'system', text: 'Live lead counts update from the database when saved' },
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

const POLL_INTERVAL_MS = 8000
const POLL_ERROR_MS = 10_000
const POLL_RATE_LIMIT_MS = 30_000

const TERMINAL_SCAN_STATUSES = new Set([
  'complete',
  'completed',
  'failed',
  'error',
  'cancelled',
])

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
      'Preparing scan preview (real Reddit scan often takes a few minutes)…'
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
  const keywordSetId = keywordSet?.id ?? null

  const [sequenceDone, setSequenceDone] = useState(false)
  const [scanSeconds, setScanSeconds] = useState(0)
  const [queriesShown, setQueriesShown] = useState(0)
  const [subsShown, setSubsShown] = useState(0)
  const [leadsFound, setLeadsFound] = useState(0)
  const [showEscape, setShowEscape] = useState(false)
  const [workerHint, setWorkerHint] = useState('')
  const [terminalResult, setTerminalResult] = useState(null)

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
  const pollTimeoutRef = useRef(null)
  const pollInFlightRef = useRef(false)
  const pollCancelledRef = useRef(false)
  const rateLimitHintShownRef = useRef(false)
  /** Wall time when the scripted preview finished (real work may still be running). */
  const sequenceDoneAtRef = useRef(0)
  const stallHintShownRef = useRef(false)
  const lastStatusRef = useRef('scanning')
  const queuedLineShownRef = useRef(false)
  const hasLastScannedRef = useRef(false)
  const workerHintRef = useRef('')
  const hardTimeoutFiredRef = useRef(false)
  const terminalResultRef = useRef(null)

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
    sequenceDoneAtRef.current = Date.now()
    setSequenceDone(true)
    startWaitingPulse()
    appendLine('system', 'Still scanning... Reddit is slow today')
    appendLine('system', 'Waiting for results...')
    appendLine('system', 'Checking for new results...')
    lastWaitingLineRef.current = Date.now()
  }

  const stopPolling = () => {
    pollCancelledRef.current = true
    if (pollTimeoutRef.current != null) {
      window.clearTimeout(pollTimeoutRef.current)
      pollTimeoutRef.current = null
    }
    pollInFlightRef.current = false
  }

  const applyTerminalResult = (result) => {
    if (terminalResultRef.current) return
    terminalResultRef.current = result
    completedRef.current = true
    stopPolling()
    clearAllTimers()

    const finalCount = Number(result.leadsFound || 0)
    leadsFoundRef.current = finalCount
    setLeadsFound(finalCount)
    setTerminalResult(result)
    setProgress(100)

    if (barRef.current) {
      barRef.current.classList.remove('bar-waiting')
      barRef.current.style.transition = 'width 800ms ease'
      barRef.current.style.width = '100%'
    }
    if (leadsCounterRef.current) {
      leadsCounterRef.current.textContent = String(finalCount)
    }

    if (result.status === 'complete') {
      appendRawLine('success', '━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      appendRawLine(
        'success',
        `${result.message || 'Scan complete'}. ${finalCount} leads found.`
      )
      appendRawLine('success', '━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    } else if (result.status === 'failed') {
      appendRawLine('warn', result.message || 'Scan failed.')
    } else {
      appendRawLine('warn', result.message || 'Scan may be stuck or still queued.')
    }
  }

  const handleNavigateToLeads = () => {
    onScanComplete?.()
    onComplete?.()
  }

  useEffect(() => {
    if (!keywordSet?.id) return undefined

    setSequenceDone(false)
    setScanSeconds(0)
    mountedRef.current = true
    startTimeRef.current = Date.now()
    sequenceDoneRef.current = false
    sequenceDoneAtRef.current = 0
    stallHintShownRef.current = false
    queuedLineShownRef.current = false
    lastStatusRef.current = 'scanning'
    hasLastScannedRef.current = false
    workerHintRef.current = ''
    hardTimeoutFiredRef.current = false
    terminalResultRef.current = null
    completedRef.current = false
    pollCancelledRef.current = false
    setTerminalResult(null)
    setShowEscape(false)
    setWorkerHint('')

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

      const st = lastStatusRef.current
      let etaText = ''
      if (st === 'queued') {
        etaText = workerHintRef.current || 'Waiting for scan worker…'
        etaRef.current.style.color = 'var(--yellow)'
        etaRef.current.classList.add('scan-eta-finishing')
      } else if (st === 'unknown') {
        etaText = workerHintRef.current || 'Checking scan status…'
        etaRef.current.style.color = 'var(--yellow)'
        etaRef.current.classList.add('scan-eta-finishing')
      } else if (sequenceDoneRef.current) {
        etaText = 'Worker running — preview finished'
        etaRef.current.style.color = 'var(--yellow)'
        etaRef.current.classList.add('scan-eta-finishing')
      } else {
        const budgetMs = ctxRef.current.estimatedTotalMs || 20000
        const remainingMs = Math.max(0, budgetMs - elapsedMs)
        if (remainingMs === 0) {
          etaText = 'Preview finishing…'
        } else if (remainingMs < 60000) {
          etaText = `Preview ~${Math.ceil(remainingMs / 1000)}s`
        } else {
          etaText = `Preview ~${Math.ceil(remainingMs / 60000)}m`
        }
        etaRef.current.style.color = 'var(--accent)'
        etaRef.current.classList.remove('scan-eta-finishing')
      }
      etaRef.current.textContent = etaText

      if (
        sequenceDoneRef.current &&
        !completedRef.current &&
        !hasLastScannedRef.current &&
        elapsed > 600
      ) {
        setShowEscape(true)
      }
      if (elapsed > 1500 && !terminalResultRef.current && !hardTimeoutFiredRef.current) {
        hardTimeoutFiredRef.current = true
        applyTerminalResult({
          status: 'stuck',
          leadsFound: Number(leadsFoundRef.current || 0),
          message:
            workerHintRef.current ||
            'This scan appears queued or stuck. Make sure the worker is running (cd backend && npm run worker).',
        })
      }
    }, 1000)
    phaseIntervalsRef.current.push(elapsedTimer)
    setProgress(4)

    let cancelled = false

    ;(async () => {
      try {
        const { data } = await api.get(`/api/keyword-sets/${keywordSetId}/scan-status`)
        if (cancelled || !mountedRef.current) return
        if (Array.isArray(data?.live_queries) && data.live_queries.length) {
          ctxRef.current.queries = data.live_queries
          setQueriesShown(data.live_queries.length)
        }
        if (Array.isArray(data?.live_subreddits) && data.live_subreddits.length) {
          ctxRef.current.subreddits = data.live_subreddits
          setSubsShown(data.live_subreddits.length)
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
  }, [keywordSetId])

  useEffect(() => {
    if (!keywordSetId) return undefined

    pollCancelledRef.current = false
    rateLimitHintShownRef.current = false

    const schedulePoll = (delayMs) => {
      if (pollCancelledRef.current || terminalResultRef.current) return
      if (pollTimeoutRef.current != null) {
        window.clearTimeout(pollTimeoutRef.current)
      }
      pollTimeoutRef.current = window.setTimeout(() => {
        void pollOnce()
      }, delayMs)
    }

    const pollOnce = async () => {
      if (pollCancelledRef.current || completedRef.current) return
      if (pollInFlightRef.current) {
        schedulePoll(POLL_INTERVAL_MS)
        return
      }

      pollInFlightRef.current = true

      try {
        const { data } = await api.get(`/api/keyword-sets/${keywordSetId}/scan-status`)
        if (!mountedRef.current || pollCancelledRef.current) return

        const status = String(data?.status || 'scanning')
        lastStatusRef.current = status
        hasLastScannedRef.current = Boolean(data?.last_scanned_at)
        if (data?.worker_hint) {
          workerHintRef.current = String(data.worker_hint)
          setWorkerHint(workerHintRef.current)
        }

        if (status === 'complete' || status === 'completed') {
          const leadsN = Number(
            data?.leads_found ?? data?.scan_progress?.leads_saved ?? data?.scan_progress?.inserted_count ?? 0
          )
          const zeroHint = leadsN === 0 ? formatZeroLeadsDiagnostic(data) : null
          applyTerminalResult({
            status: 'complete',
            leadsFound: leadsN,
            message: zeroHint || data?.scan_progress?.message || 'Scan complete',
            diagnostic: zeroHint,
          })
          return
        }

        if (status === 'failed' || status === 'error') {
          const failMsg = String(
            data.worker_hint ||
              (data.scan_progress && data.scan_progress.message) ||
              'Scan failed. Check backend logs.'
          )
          if (/429|too many requests/i.test(failMsg)) {
            if (!rateLimitHintShownRef.current) {
              rateLimitHintShownRef.current = true
              appendRawLine(
                'warn',
                'Server or Reddit rate limited this request. Waiting and retrying…'
              )
            }
            schedulePoll(POLL_RATE_LIMIT_MS)
            return
          }
          applyTerminalResult({
            status: 'failed',
            leadsFound: Number(data?.leads_found || 0),
            message: failMsg,
          })
          return
        }

        if (status === 'queued') {
          if (!queuedLineShownRef.current) {
            queuedLineShownRef.current = true
            appendRawLine(
              'system',
              data.worker_hint || 'Scan is queued. Waiting for worker…'
            )
          }
          if (Number(data?.leads_found || 0) > leadsFoundRef.current) {
            leadsFoundRef.current = Number(data?.leads_found || 0)
            setLeadsFound(leadsFoundRef.current)
            if (leadsCounterRef.current) {
              leadsCounterRef.current.textContent = String(leadsFoundRef.current)
            }
          }
          schedulePoll(8000)
          return
        }

        if (status === 'unknown') {
          if (data.worker_hint && !queuedLineShownRef.current) {
            queuedLineShownRef.current = true
            appendRawLine('warn', data.worker_hint)
          }
          schedulePoll(10000)
          return
        }

        if (Number(data?.leads_found || 0) > leadsFoundRef.current) {
          leadsFoundRef.current = Number(data?.leads_found || 0)
          setLeadsFound(leadsFoundRef.current)
          if (leadsCounterRef.current) {
            leadsCounterRef.current.textContent = String(leadsFoundRef.current)
          }
        }

        if (
          status === 'scanning' &&
          sequenceDoneRef.current &&
          sequenceDoneAtRef.current > 0 &&
          !completedRef.current &&
          Number(data?.leads_found || 0) === 0
        ) {
          const stalledMs = Date.now() - sequenceDoneAtRef.current
          if (stalledMs > 8 * 60 * 1000 && !stallHintShownRef.current) {
            stallHintShownRef.current = true
            appendRawLine(
              'warn',
              'The log above is a preview while the server runs the real scan. Lead counts below are from the database and update when the worker finishes.'
            )
          }
        }

        const now = Date.now()
        if (
          !TERMINAL_SCAN_STATUSES.has(status) &&
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

        if (!TERMINAL_SCAN_STATUSES.has(status) && !terminalResultRef.current) {
          schedulePoll(POLL_INTERVAL_MS)
        }
      } catch (e) {
        if (!mountedRef.current || pollCancelledRef.current) return

        if (e?.response?.status === 404) {
          return
        }

        const statusCode = e?.response?.status
        if (statusCode === 429) {
          if (!rateLimitHintShownRef.current) {
            rateLimitHintShownRef.current = true
            appendRawLine(
              'warn',
              'Refreshing too quickly. Waiting before trying again…'
            )
          }
          schedulePoll(POLL_RATE_LIMIT_MS)
          return
        }

        if (statusCode !== 429) {
          console.error(
            '[ScanProgress] poll error:',
            e?.response?.data?.message || e?.message || e
          )
        }
        schedulePoll(POLL_ERROR_MS)
      } finally {
        pollInFlightRef.current = false
      }
    }

    schedulePoll(0)

    return () => {
      pollCancelledRef.current = true
      if (pollTimeoutRef.current != null) {
        window.clearTimeout(pollTimeoutRef.current)
        pollTimeoutRef.current = null
      }
      pollInFlightRef.current = false
    }
  }, [keywordSetId])

  const headerStatus = terminalResult
    ? terminalResult.status === 'complete'
      ? 'COMPLETE'
      : terminalResult.status === 'failed'
        ? 'FAILED'
        : 'STUCK'
    : 'SCANNING'
  const headerDone = Boolean(terminalResult)

  if (!keywordSetId) {
    return null
  }

  return (
    <div style={{ background: 'var(--bg)', padding: 48 }}>
      <div style={{ maxWidth: 680, margin: '0 auto' }}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span
              className={headerDone ? '' : 'signal-track-dot'}
              style={
                headerDone
                  ? {
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      display: 'inline-block',
                      background:
                        terminalResult?.status === 'failed'
                          ? '#e55'
                          : terminalResult?.status === 'stuck'
                            ? 'var(--yellow)'
                            : 'var(--text-3)',
                    }
                  : undefined
              }
            />
            <span
              className="font-mono"
              style={{
                fontSize: 11,
                letterSpacing: '0.15em',
                color: headerDone
                  ? terminalResult?.status === 'complete'
                    ? 'var(--text-3)'
                    : 'var(--yellow)'
                  : 'var(--green)',
              }}
            >
              {headerStatus}
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

        {showEscape && !terminalResult && (
          <div className="mt-4 rounded-lg border px-4 py-3" style={{ borderColor: 'var(--border)' }}>
            <p className="m-0 font-mono text-[11px]" style={{ color: 'var(--yellow)' }}>
              {workerHint ||
                'This scan appears queued or stuck. Make sure the worker is running (cd backend && npm run worker).'}
            </p>
            <button
              type="button"
              className="signal-btn-focus mt-3 rounded-md border px-4 py-2 font-mono text-[11px]"
              style={{
                borderColor: 'var(--border)',
                color: 'var(--text)',
                background: 'transparent',
                cursor: 'pointer',
              }}
              onClick={handleNavigateToLeads}
            >
              Return to leads
            </button>
          </div>
        )}

        {terminalResult && (
          <div
            className="mt-6 rounded-lg border px-5 py-4"
            style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
          >
            {terminalResult.status === 'complete' && (
              <>
                <p className="m-0 font-mono text-[13px]" style={{ color: 'var(--green)' }}>
                  Scan complete
                </p>
                <p className="mt-2 mb-0 font-mono text-[12px]" style={{ color: 'var(--text-2)' }}>
                  {terminalResult.leadsFound} leads found
                </p>
                {terminalResult.diagnostic ? (
                  <p className="mt-2 mb-0 font-mono text-[11px]" style={{ color: 'var(--yellow)' }}>
                    {terminalResult.diagnostic}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="signal-btn-focus mt-4 rounded-md border px-4 py-2 font-mono text-[11px]"
                  style={{
                    borderColor: 'var(--accent)',
                    color: 'var(--accent)',
                    background: 'rgba(124,106,247,0.12)',
                    cursor: 'pointer',
                  }}
                  onClick={handleNavigateToLeads}
                >
                  View leads
                </button>
              </>
            )}
            {terminalResult.status === 'failed' && (
              <>
                <p className="m-0 font-mono text-[13px]" style={{ color: '#e55' }}>
                  Scan failed
                </p>
                <p className="mt-2 mb-0 font-mono text-[11px]" style={{ color: 'var(--text-3)' }}>
                  {terminalResult.message}
                </p>
                <button
                  type="button"
                  className="signal-btn-focus mt-4 rounded-md border px-4 py-2 font-mono text-[11px]"
                  style={{
                    borderColor: 'var(--border)',
                    color: 'var(--text)',
                    background: 'transparent',
                    cursor: 'pointer',
                  }}
                  onClick={handleNavigateToLeads}
                >
                  Return to leads
                </button>
              </>
            )}
            {terminalResult.status === 'stuck' && (
              <>
                <p className="m-0 font-mono text-[13px]" style={{ color: 'var(--yellow)' }}>
                  Scan may be stuck
                </p>
                <p className="mt-2 mb-0 font-mono text-[11px]" style={{ color: 'var(--text-3)' }}>
                  {terminalResult.message}
                </p>
                <button
                  type="button"
                  className="signal-btn-focus mt-4 rounded-md border px-4 py-2 font-mono text-[11px]"
                  style={{
                    borderColor: 'var(--border)',
                    color: 'var(--text)',
                    background: 'transparent',
                    cursor: 'pointer',
                  }}
                  onClick={handleNavigateToLeads}
                >
                  Return to leads
                </button>
              </>
            )}
          </div>
        )}

        {!terminalResult && sequenceDone && scanSeconds >= 120 && (
          <button
            type="button"
            onClick={async () => {
              try {
                const { data } = await api.get(
                  `/api/keyword-sets/${keywordSetId}/scan-status`
                )
                if (data.status === 'complete' || data.status === 'completed') {
                  applyTerminalResult({
                    status: 'complete',
                    leadsFound: Number(
                      data.leads_found ?? data.scan_progress?.leads_saved ?? 0
                    ),
                    message: data.scan_progress?.message || 'Scan complete',
                  })
                } else if (data.status === 'failed' || data.status === 'error') {
                  applyTerminalResult({
                    status: 'failed',
                    leadsFound: Number(data.leads_found || 0),
                    message:
                      data.worker_hint ||
                      data.scan_progress?.message ||
                      'Scan failed.',
                  })
                } else {
                  window.alert(
                    `Status: ${data.status}, Job: ${data.job_state || 'n/a'}, Leads: ${data.leads_found}\n${data.worker_hint || ''}`
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

