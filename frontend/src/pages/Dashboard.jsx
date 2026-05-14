import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import AddMonitorModal from '../components/AddMonitorModal'
import LimitModal from '../components/LimitModal'
import KeywordSetItem from '../components/KeywordSetItem'
import LeadFeed from '../components/LeadFeed'
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

  const {
    leads,
    loading: leadsLoading,
    markSeen,
    markUnread,
    dismissLead,
    generateDraft,
    refreshLeads,
  } = useLeads(userId)

  const { rows: trackedRows, refresh: refreshTracked } = useTrackedReplies(userId)

  const [showMonitorModal, setShowMonitorModal] = useState(false)
  const [showLimitModal, setShowLimitModal] = useState(false)
  const [monitorToEdit, setMonitorToEdit] = useState(null)
  const [mainView, setMainView] = useState('leads')

  const closeMonitorModal = () => {
    setShowMonitorModal(false)
    setMonitorToEdit(null)
  }

  const activeKeywordSets = useMemo(
    () => keywordSets.filter((k) => k.active !== false),
    [keywordSets]
  )
  const [selectedKeywordSetId, setSelectedKeywordSetId] = useState(null)
  const [tab, setTab] = useState('unread')

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

    setSelectedKeywordSetId(activeKeywordSets[0].id)
  }, [activeKeywordSets, selectedKeywordSetId])

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
          onClick={() => {
            if (activeKeywordSets.length >= 3) {
              setShowLimitModal(true)
            } else {
              setMonitorToEdit(null)
              setShowMonitorModal(true)
            }
          }}
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
              }}
              onEditMonitor={(id) => {
                const row = activeKeywordSets.find((k) => k.id === id)
                if (row) {
                  setMonitorToEdit(row)
                  setShowMonitorModal(true)
                }
              }}
              onDelete={deleteKeywordSet}
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

        <p className="pt-8 text-[12px]" style={{ color: 'var(--muted)' }}>
          {email}
        </p>
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
                  {visibleLeads.length}
                </span>
              </div>

              <div
                className="mt-6 inline-flex rounded-md border"
                style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
              >
                {[
                  { id: 'all', label: 'All' },
                  { id: 'unread', label: 'Unread' },
                ].map(({ id, label }) => {
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
        onSuccess={async (result) => {
          await refetchKeywordSets()
          await refreshLeads()
          if (result?.id) setSelectedKeywordSetId(result.id)
          closeMonitorModal()
        }}
      />

      <LimitModal isOpen={showLimitModal} onClose={() => setShowLimitModal(false)} />
    </div>
  )
}
