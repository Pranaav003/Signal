import { useEffect, useMemo, useState } from 'react'

import AddKeywordSetModal from '../components/AddKeywordSetModal'
import KeywordSetItem from '../components/KeywordSetItem'
import LeadFeed from '../components/LeadFeed'
import { useKeywordSets } from '../hooks/useKeywordSets'
import { useLeads } from '../hooks/useLeads'
import { useUser } from '../hooks/useUser'

export default function Dashboard() {
  const { userId, loading: userLoading, email } = useUser()

  const {
    keywordSets,
    loading: setsLoading,
    createKeywordSet,
  } = useKeywordSets(userId)

  const { leads, loading: leadsLoading, markSeen, dismissLead, generateDraft } =
    useLeads(userId)

  const [modalOpen, setModalOpen] = useState(false)
  const [selectedKeywordSetId, setSelectedKeywordSetId] = useState(null)
  const [tab, setTab] = useState('unread')

  useEffect(() => {
    if (!keywordSets.length) {
      setSelectedKeywordSetId(null)
      return
    }

    if (
      selectedKeywordSetId &&
      keywordSets.some((k) => k.id === selectedKeywordSetId)
    ) {
      return
    }

    setSelectedKeywordSetId(keywordSets[0].id)

  }, [keywordSets, selectedKeywordSetId])

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



  async function handleCreateMonitor(description) {


    const created = await createKeywordSet(description)



    if (created?.id) {

      setSelectedKeywordSetId(created.id)


    }



    setModalOpen(false)


  }


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
        <p
          className="font-mono text-[13px]"
          style={{ color: 'var(--accent)', letterSpacing: '0.3em' }}

        >
          SIGNAL
        </p>

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


            setModalOpen(true)


          }}

        >
          New Monitor
        </button>

        <p
          className="mb-2 mt-8 font-mono text-[11px]"
          style={{ color: 'var(--muted)', letterSpacing: '0.24em' }}

        >
          MONITORS
        </p>

        <div className="flex-1 space-y-1 overflow-y-auto pr-2">

          {keywordSets.map((ks) => (

              <KeywordSetItem

              key={ks.id}

              keywordSet={ks}

              isActive={ks.id === selectedKeywordSetId}

              unseenCount={unseenBySet.get(ks.id) ?? 0}

              onClick={setSelectedKeywordSetId}


            />

          ))}


          {!setsLoading && !keywordSets.length && (


              <p className="px-3 text-[12px]" style={{ color: 'var(--muted)' }}>

              Add a monitor to start listening.

            </p>

          )}

        </div>

        <p className="pt-8 text-[12px]" style={{ color: 'var(--muted)' }}>
          {email}
        </p>

      </aside>

      <main className="ml-[260px] flex-1" style={{ minHeight: '100vh' }}>

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

          <div className="mt-6 inline-flex rounded-md border" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>



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


                    background: active ? 'rgba(110,231,183,0.15)' : 'transparent',



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
            <p style={{ color: 'var(--muted)' }}>
              Bringing your workstation online...
            </p>

          )

          :

          (
            <LeadFeed
              leads={visibleLeads}
              loading={leadsLoading}
              markSeen={markSeen}

              dismissLead={dismissLead}

              generateDraft={generateDraft}
            />

          )}

        </div>

      </main>

      <AddKeywordSetModal

        isOpen={modalOpen}



        onClose={() => {


          setModalOpen(false)



        }}

        onSubmit={(description) => handleCreateMonitor(description)}

      />


    </div>

  )
}
