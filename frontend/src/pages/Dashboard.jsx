import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import AddMonitorModal from '../components/AddMonitorModal'
import IntroModal, { INTRO_STORAGE_KEY } from '../components/IntroModal'
import LimitModal from '../components/LimitModal'
import KeywordSetItem from '../components/KeywordSetItem'
import LeadFeed from '../components/LeadFeed'
import ScanProgress from '../components/ScanProgress'
import { useKeywordSets } from '../hooks/useKeywordSets'
import { useLeads } from '../hooks/useLeads'
import { useTrackedReplies } from '../hooks/useTrackedReplies'
import { useUser } from '../hooks/useUser'
import PerformancePage from './PerformancePage'

export default function Dashboard() {
  const { userId, loading: userLoading, email } = useUser()

  const {
    keywordSets,
    loading: setsLoading,
    refresh: refetchKeywordSets,
    deleteKeywordSet,
  } = useKeywordSets(userId)

  const [scanningKeywordSet, setScanningKeywordSet] = useState(null)
  const [showMonitorModal, setShowMonitorModal] = useState(false)
  const [showLimitModal, setShowLimitModal] = useState(false)
  const [showIntro, setShowIntro] = useState(false)
  const [showIntroHelp, setShowIntroHelp] = useState(false)
  const [monitorToEdit, setMonitorToEdit] = useState(null)
  const [mainView, setMainView] = useState('leads')
  const [selectedKeywordSetId, setSelectedKeywordSetId] = useState(null)
  const [tab, setTab] = useState('unread')

  const {
    leads,
    loading: leadsLoading,
    markSeen,
    markUnread,
    dismissLead,
    generateDraft,
    refreshLeads,
  } = useLeads(userId, { isScanning: Boolean(scanningKeywordSet) })

  const { rows: trackedRows, refresh: refreshTracked } = useTrackedReplies(userId)

  const closeMonitorModal = () => {
    setShowMonitorModal(false)
    setMonitorToEdit(null)
  }

  useEffect(() => {
    try {
      if (!localStorage.getItem(INTRO_STORAGE_KEY)) {
        setShowIntro(true)
      }
    } catch {
      /* ignore */
    }
  }, [])

  const dismissIntro = () => {
    try {
      localStorage.setItem(INTRO_STORAGE_KEY, 'true')
    } catch {
      /* ignore */
    }
    setShowIntro(false)
    setShowIntroHelp(false)
  }

  const activeKeywordSets = useMemo(
    () => keywordSets.filter((k) => k.active !== false),
    [keywordSets]
  )

  const openNewMonitor = () => {
    if (activeKeywordSets.length >= 3) {
      setShowLimitModal(true)
    } else {
      setMonitorToEdit(null)
      setShowMonitorModal(true)
    }
  }

  const [scanUiPhase, setScanUiPhase] = useState('scanning')

  const leadTabs = useMemo(() => {
    const base = [
      { id: 'all', label: 'All' },
      { id: 'unread', label: 'Unread' },
    ]
    if (scanningKeywordSet) {
      base.push({
        id: 'scanning',
        label: scanUiPhase === 'complete' ? 'Scan complete' : 'Scanning',
      })
    }
    return base
  }, [scanningKeywordSet, scanUiPhase])

  // Switch away from the Scanning tab when viewing another monitor, but keep the scan
  // running in the background (do not clear scanningKeywordSet — that unmounts ScanProgress).
  useEffect(() => {
    if (!scanningKeywordSet || !selectedKeywordSetId) return
    if (scanningKeywordSet.id !== selectedKeywordSetId && tab === 'scanning') {
      setTab('all')
    }
  }, [selectedKeywordSetId, scanningKeywordSet, tab])

  useEffect(() => {
    if (tab === 'scanning' && !scanningKeywordSet) {
      setTab('all')
    }
  }, [tab, scanningKeywordSet])

  useEffect(() => {
    if (!activeKeywordSets.length) {
      setSelectedKeywordSetId(null)
      return
    }

    if (
      selectedKeywordSetId &&
      activeKeywordSets.some((k) => k.id === selectedKeywordSetId)
    ) {
      return
    }

    // Keep selection stable while the new monitor row may not yet appear in the
    // refetched list (or is filtered differently) so we do not clear scanning.
    if (
      scanningKeywordSet?.id &&
      selectedKeywordSetId === scanningKeywordSet.id
    ) {
      return
    }

    setSelectedKeywordSetId(activeKeywordSets[0].id)
  }, [activeKeywordSets, selectedKeywordSetId, scanningKeywordSet])

  const unseenBySet = useMemo(() => {
    const m = new Map()

    for (const lead of leads) {
      if (lead.seen) continue

      const key = lead.keyword_set_id

      m.set(key, (m.get(key) || 0) + 1)
    }

    return m
  }, [leads])

  const scopedLeads = useMemo(() => {
    if (!selectedKeywordSetId) return leads

    return leads.filter((l) => l.keyword_set_id === selectedKeywordSetId)
  }, [leads, selectedKeywordSetId])

  const visibleLeads = useMemo(() => {
    if (tab === 'unread') {
      return scopedLeads.filter((l) => !l.seen)
    }

    return scopedLeads
  }, [scopedLeads, tab])

  const headerLeadCount = useMemo(() => {
    if (tab === 'scanning') {
      return scopedLeads.length
    }
    return visibleLeads.length
  }, [tab, scopedLeads, visibleLeads])

  const pageLoading =
    Boolean(userLoading) || (Boolean(userId) && Boolean(setsLoading))

  return (
    <div
      className="flex min-h-screen"
      style={{ background: 'var(--bg)', color: 'var(--text)' }}
    >
      <aside
        className="fixed inset-y-0 left-0 z-50 flex flex-col border-r"
        style={{
          width: 260,
          background: 'var(--surface)',
          borderColor: 'var(--border)',
          paddingTop: '32px',
          paddingLeft: '20px',
          paddingRight: '18px',
          paddingBottom: '24px',
        }}
      >
        <Link
          to="/"
          className="signal-btn-focus inline-block font-mono text-[13px] no-underline"
          style={{ color: 'var(--accent)', letterSpacing: '0.3em' }}
        >
          SIGNAL
        </Link>

        <div
          className="my-6 h-[1px]"
          style={{ background: `linear-gradient(to right, var(--accent), transparent)` }}
        />

        <button
          type="button"
          className="signal-btn-focus w-full rounded-md border-none py-3 font-mono text-[13px] font-semibold tracking-wide"
          style={{ background: 'var(--accent)', color: '#09090f' }}
          disabled={pageLoading}
          onClick={openNewMonitor}
        >
          New Monitor
        </button>

        <div className="mb-2 mt-8 flex items-baseline justify-between gap-2 pr-1">
          <p
            className="m-0 font-mono text-[11px]"
            style={{ color: 'var(--muted)', letterSpacing: '0.24em' }}
          >
            MONITORS
          </p>
          <span
            className="font-mono text-[11px] tabular-nums tracking-wide"
            style={{
              color:
                activeKeywordSets.length >= 3 ? 'var(--accent)' : 'var(--text-3)',
            }}
            aria-label={`${activeKeywordSets.length} of 3 monitors in use`}
          >
            {activeKeywordSets.length}/3
          </span>
        </div>

        <div className="flex-1 space-y-1 overflow-y-auto pr-2">
          {activeKeywordSets.map((ks) => (
            <KeywordSetItem
              key={ks.id}
              keywordSet={ks}
              isActive={ks.id === selectedKeywordSetId && mainView === 'leads'}
              unseenCount={unseenBySet.get(ks.id) ?? 0}
              onClick={(id) => {
                setSelectedKeywordSetId(id)
                setMainView('leads')
                if (scanningKeywordSet?.id === id) {
                  setTab('scanning')
                }
              }}
              isScanning={scanningKeywordSet?.id === ks.id}
              onEditMonitor={(id) => {
                const row = activeKeywordSets.find((k) => k.id === id)
                if (row) {
                  setMonitorToEdit(row)
                  setShowMonitorModal(true)
                }
              }}
              onDelete={async (id) => {
                await deleteKeywordSet(id)
                if (scanningKeywordSet?.id === id) {
                  setScanningKeywordSet(null)
                  setScanUiPhase('scanning')
                  setTab('all')
                }
                if (selectedKeywordSetId === id) {
                  setSelectedKeywordSetId(null)
                }
                await refreshLeads()
              }}
            />
          ))}

          {!setsLoading && !activeKeywordSets.length && (
            <p className="px-3 text-[12px]" style={{ color: 'var(--muted)' }}>
              Add a monitor to start listening.
            </p>
          )}
        </div>

        <button
          type="button"
          className="signal-btn-focus mt-6 w-full rounded-md border-none py-2 text-left font-mono text-[11px]"
          style={{
            color: mainView === 'performance' ? 'var(--accent)' : 'var(--text-3)',
            letterSpacing: '0.18em',
            background:
              mainView === 'performance' ? 'rgba(124,106,247,0.12)' : 'transparent',
          }}
          onClick={() => setMainView('performance')}
        >
          PERFORMANCE
        </button>

        <div className="pt-8">
          <button
            type="button"
            className="signal-btn-focus mb-2 border-none bg-transparent p-0 font-mono text-[11px]"
            style={{ color: 'var(--text-3)', letterSpacing: '0.12em' }}
            onClick={() => setShowIntroHelp(true)}
          >
            Help
          </button>
          <p className="m-0 text-[12px]" style={{ color: 'var(--muted)' }}>
            {email}
          </p>
        </div>
      </aside>

      <main className="ml-[260px] flex-1" style={{ minHeight: '100vh' }}>
        {mainView === 'leads' ? (
          <>
            <div className="border-b px-10 py-10" style={{ borderColor: 'var(--border)' }}>
              <div className="flex flex-wrap items-center gap-4">
                <h1 className="font-mono text-[20px]" style={{ letterSpacing: '0.08em' }}>
                  Live Leads
                </h1>

                <span
                  className="rounded-full px-3 py-1 font-mono text-[13px]"
                  style={{
                    background: 'var(--accent-dim)',
                    color: 'var(--accent)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {headerLeadCount}
                </span>
              </div>

              <div
                className="mt-6 inline-flex rounded-md border"
                style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
              >
                {leadTabs.map(({ id, label }) => {
                  const active = tab === id

                  return (
                    <button
                      key={id}
                      type="button"
                      className="signal-btn-focus border-none px-5 py-2 font-mono text-[12px]"
                      style={{
                        color: active ? 'var(--accent)' : 'var(--muted)',
                        background: active ? 'rgba(124,106,247,0.15)' : 'transparent',
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                      }}
                      onClick={() => setTab(id)}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="px-10 pb-16 pt-10">
              {pageLoading ? (
                <p style={{ color: 'var(--muted)' }}>Bringing your workstation online...</p>
              ) : (
                <>
                  {scanningKeywordSet &&
                  selectedKeywordSetId &&
                  scanningKeywordSet.id !== selectedKeywordSetId &&
                  tab !== 'scanning' ? (
                    <div
                      className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3"
                      style={{
                        borderColor: 'var(--border)',
                        background: 'rgba(124,106,247,0.08)',
                      }}
                    >
                      <p className="m-0 font-mono text-[12px]" style={{ color: 'var(--text-2)' }}>
                        Another monitor is still scanning. You can browse leads here; progress
                        continues in the background.
                      </p>
                      <button
                        type="button"
                        className="signal-btn-focus shrink-0 rounded-md border px-3 py-1.5 font-mono text-[11px]"
                        style={{
                          borderColor: 'var(--accent)',
                          color: 'var(--accent)',
                          background: 'transparent',
                        }}
                        onClick={() => {
                          setSelectedKeywordSetId(scanningKeywordSet.id)
                          setTab('scanning')
                        }}
                      >
                        View scan progress
                      </button>
                    </div>
                  ) : null}
                  {scanningKeywordSet ? (
                    <div className={tab === 'scanning' ? '' : 'hidden'} aria-hidden={tab !== 'scanning'}>
                      <ScanProgress
                        keywordSet={scanningKeywordSet}
                        onScanComplete={refreshLeads}
                        onScanReady={async ({ status, leadsFound }) => {
                          if (status !== 'complete' && status !== 'failed') return
                          setScanUiPhase('complete')
                          const kid = scanningKeywordSet?.id
                          if (kid) setSelectedKeywordSetId(kid)

                          let rows = await refreshLeads()
                          if (status === 'complete' && leadsFound > 0 && kid) {
                            let visible = (rows || []).filter(
                              (l) => l.keyword_set_id === kid
                            )
                            if (!visible.length) {
                              await new Promise((r) => window.setTimeout(r, 600))
                              rows = await refreshLeads()
                              visible = (rows || []).filter((l) => l.keyword_set_id === kid)
                            }
                            if (visible.length > 0 || leadsFound > 0) {
                              setTab('all')
                            }
                          }
                        }}
                        onComplete={() => {
                          void refreshLeads().finally(() => {
                            setScanningKeywordSet(null)
                            setScanUiPhase('scanning')
                            setTab('all')
                          })
                        }}
                      />
                    </div>
                  ) : null}
                  {tab !== 'scanning' ? (
                    <LeadFeed
                      leads={visibleLeads}
                      loading={leadsLoading}
                      markSeen={markSeen}
                      markUnread={markUnread}
                      dismissLead={dismissLead}
                      generateDraft={generateDraft}
                      userId={userId}
                      trackedReplies={trackedRows}
                      onTrackedRefresh={refreshTracked}
                    />
                  ) : null}
                </>
              )}
            </div>
          </>
        ) : (
          <div className="px-10 pb-16 pt-10">
            {pageLoading ? (
              <p style={{ color: 'var(--muted)' }}>Bringing your workstation online...</p>
            ) : (
              <PerformancePage
                userId={userId}
                rows={trackedRows}
                onRefresh={refreshTracked}
              />
            )}
          </div>
        )}
      </main>

      <AddMonitorModal
        isOpen={showMonitorModal}
        onClose={closeMonitorModal}
        userId={userId}
        editKeywordSet={monitorToEdit}
        onSyncList={refetchKeywordSets}
        onMonitorLimitReached={() => setShowLimitModal(true)}
        onSuccess={async (result, meta) => {
          await refetchKeywordSets()
          await refreshLeads()
          if (result?.id) setSelectedKeywordSetId(result.id)
          if (meta?.mode === 'create' && result?.id) {
            setScanningKeywordSet(result)
            setScanUiPhase('scanning')
            setTab('scanning')
          }
          closeMonitorModal()
        }}
      />

      <LimitModal isOpen={showLimitModal} onClose={() => setShowLimitModal(false)} />

      <IntroModal
        isOpen={showIntro || showIntroHelp}
        persistSeen={!showIntroHelp}
        onClose={() => {
          if (showIntroHelp) {
            setShowIntroHelp(false)
          } else {
            dismissIntro()
          }
        }}
        onStart={() => {
          if (showIntroHelp) {
            setShowIntroHelp(false)
          } else {
            dismissIntro()
          }
        }}
        onCreateFirstMonitor={() => {
          if (showIntroHelp) setShowIntroHelp(false)
          openNewMonitor()
        }}
      />
    </div>
  )
}
