import { useCallback, useEffect, useRef, useState } from 'react'

import { api } from '../lib/api'

const POLL_MS = 30_000
const LIMIT = 100

/**
 * Polls `/api/leads/user/:id?sort=score&limit=100` — no `seen` filter so the UI + sidebar badges stay consistent.
 */
export function useLeads(userId) {
  const [leads, setLeads] = useState([])
  const [loading, setLoading] = useState(Boolean(userId))
  const timerRef = useRef(null)

  const load = useCallback(async () => {
    if (!userId) return

    const { data } = await api.get(`/api/leads/user/${userId}`, {
      params: { sort: 'score', limit: LIMIT },
    })

    setLeads(Array.isArray(data) ? data : [])
  }, [userId])

  useEffect(() => {
    if (!userId) {
      setLeads([])
      setLoading(false)
      return undefined
    }

    let cancelled = false

    async function tick() {
      setLoading(true)

      try {
        await load()
      } catch (e) {
        console.error('[useLeads]', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    tick()

    timerRef.current = window.setInterval(tick, POLL_MS)

    return () => {
      cancelled = true

      if (timerRef.current) window.clearInterval(timerRef.current)
    }
  }, [userId, load])

  const markSeen = useCallback(async (id) => {
    await api.patch(`/api/leads/${id}/seen`)

    setLeads((prev) => prev.filter((l) => l.id !== id))
  }, [])

  const dismissLead = useCallback(async (id) => {
    await api.delete(`/api/leads/${id}`)

    setLeads((prev) => prev.filter((l) => l.id !== id))
  }, [])

  const generateDraft = useCallback(async (id) => {
    const { data } = await api.post(`/api/leads/${id}/draft`)

    const draft = typeof data?.draft === 'string' ? data.draft : ''

    setLeads((prev) =>
      prev.map((l) => (l.id === id ? { ...l, ai_draft: draft } : l))
    )

    return { draft }
  }, [])

  return { leads, loading, markSeen, dismissLead, generateDraft }
}
