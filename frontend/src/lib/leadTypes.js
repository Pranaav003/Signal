export const LEAD_TYPE_LABELS = {
  direct_demand: 'Direct demand',
  adjacent_demand: 'Adjacent',
  market_research: 'Market research',
  supplier_side: 'Supplier',
  competitor_signal: 'Competitor',
  not_a_lead: 'Not a lead',
}

export function leadTypeFromLead(lead) {
  const q = lead?.qualification
  return (
    lead?.lead_type ||
    (typeof q === 'object' && q?.lead_type) ||
    'direct_demand'
  )
}

export function leadTypeLabel(lead) {
  const t = leadTypeFromLead(lead)
  return LEAD_TYPE_LABELS[t] || t
}

export function leadTypeBadgeStyle(type) {
  switch (type) {
    case 'direct_demand':
      return { background: 'rgba(52,211,153,0.15)', color: 'var(--green)' }
    case 'adjacent_demand':
      return { background: 'rgba(124,106,247,0.2)', color: 'var(--accent)' }
    case 'market_research':
      return { background: 'rgba(96,165,250,0.15)', color: '#93c5fd' }
    case 'supplier_side':
      return { background: 'rgba(251,191,36,0.15)', color: 'var(--yellow)' }
    case 'competitor_signal':
      return { background: 'rgba(248,113,113,0.12)', color: '#f87171' }
    default:
      return { background: 'var(--surface-2)', color: 'var(--text-3)' }
  }
}

export const INCLUDE_PRESETS = {
  inbox: '',
  all: 'all',
  market_research: 'market_research',
  supplier_side: 'supplier_side',
  competitor_signal: 'competitor_signal',
  hidden: 'market_research,supplier_side,competitor_signal',
}
