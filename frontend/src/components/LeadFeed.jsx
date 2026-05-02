import LeadCard from './LeadCard'

function SkeletonCard() {
  return (
    <div

      className="signal-skeleton mb-2 rounded-lg border p-4"


      style={{
        background: 'var(--surface)',
        borderColor: 'var(--border)',
      }}

    >
      <div className="flex gap-4">

        <div className="w-[60px] shrink-0">

          <div className="mx-auto h-8 w-14 rounded" style={{ background: 'var(--surface-2)' }} />

          <div className="mx-auto mt-2 h-2 w-10 rounded" style={{ background: 'var(--surface-2)' }} />

        </div>

        <div className="flex-1">

          <div className="flex justify-between">

            <div className="h-4 w-28 rounded" style={{ background: 'var(--surface-2)' }} />

            <div className="h-3 w-24 rounded" style={{ background: 'var(--surface-2)' }} />

          </div>

          <div
            className="mt-3 h-3 rounded"
            style={{ width: '88%', background: 'var(--surface-2)' }}
          />

          <div
            className="mt-2 h-3 rounded"
            style={{ width: '68%', background: 'var(--surface-2)' }}
          />

          <div className="mt-4 flex gap-3">

            <div className="h-3 w-20 rounded" style={{ background: 'var(--surface-2)' }} />

            <div className="h-6 w-24 rounded" style={{ background: 'var(--surface-2)' }} />

          </div>

        </div>

      </div>

    </div>

  )
}


export default function LeadFeed({ leads, loading, markSeen, dismissLead, generateDraft }) {
  if (loading) {
    return (

      <div className="mt-8 space-y-2">

        <SkeletonCard />

        <SkeletonCard />

        <SkeletonCard />

      </div>

    )


  }



  if (!leads.length) {
    return (

      <div className="mt-24 grid place-items-center">

        <p className="flex items-center text-[14px]" style={{ color: 'var(--muted)' }}>

          No signals yet. Monitoring Reddit

          <span className="signal-cursor" aria-hidden />

        </p>


      </div>

    )


  }



  return (

    <div className="mt-6">

      {leads.map((lead) => (

          <LeadCard

          key={lead.id}

          lead={lead}

          onMarkSeen={markSeen}

          onDismiss={dismissLead}

          onGenerateDraft={generateDraft}

        />

      ))}


    </div>

  )


}
