import LeadCard from './LeadCard'

function SkeletonCard() {
  return (
    <div className="signal-lead-skeleton signal-skeleton">
      <div className="signal-lead-skel-top">
        <div className="signal-lead-skel-meta">
          <div className="signal-lead-skel-line h-7 w-12" />
          <div className="signal-lead-skel-line h-5 w-24" />
          <div className="signal-lead-skel-line h-3 w-28" />
        </div>
        <div className="signal-lead-skel-line h-3 w-10 shrink-0" />
      </div>
      <div className="signal-lead-skel-line mt-3 h-3 w-[92%]" />
      <div className="signal-lead-skel-line mt-2 h-3 w-[78%]" />
      <div className="signal-lead-skel-line mt-2 h-3 w-[64%]" />
      <div className="mt-4 flex gap-3">
        <div className="signal-lead-skel-line h-3 w-20" />
        <div className="signal-lead-skel-line h-7 w-[88px]" />
      </div>
    </div>
  )
}

function trackedForLead(trackedReplies, leadId) {
  if (!Array.isArray(trackedReplies) || !leadId) return null
  const matches = trackedReplies.filter((t) => t.lead_id === leadId)
  if (!matches.length) return null
  matches.sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at))
  return matches[0]
}

export default function LeadFeed({
  leads,
  loading,
  markSeen,
  markUnread,
  dismissLead,
  generateDraft,
  userId,
  trackedReplies,
  onTrackedRefresh,
}) {
  if (loading) {
    return (
      <div className="mt-8 space-y-0">
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
          userId={userId}
          trackedReply={trackedForLead(trackedReplies, lead.id)}
          onMarkSeen={markSeen}
          onMarkUnread={markUnread}
          onDismiss={dismissLead}
          onGenerateDraft={generateDraft}
          onTrackedRefresh={onTrackedRefresh}
        />
      ))}
    </div>
  )
}
