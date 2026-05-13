import { useCallback, useEffect, useRef, useState } from 'react'

import { api, BASE_URL } from '../lib/api'

const DEFAULT_FETCH_LIMIT = 200
const POLL_SLOW_MS = 30_000
const POLL_FAST_MS = 8000

function apiUrl(path) {
  const root = String(BASE_URL || '').replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return root ? `${root}${p}` : p
}

function normalizeLeadsResponse(data) {
  if (Array.isArray(data)) return data
  if (data?.leads && Array.isArray(data.leads)) return data.leads
  return []
}

/**
 * Stable polling: `fetchLeads` depends only on `userId` and `sort` (primitives).
 * @param {string | null} userId
 * @param {{ isScanning?: boolean, sort?: string, seen?: boolean | string, limit?: number }} [options]
 */
export function useLeads(userId, { isScanning = false, sort = 'score', seen, limit } = {}) {
  const [leads, setLeads] = useState([])
  const [loading, setLoading] = useState(true)
  const [newLeadIds, setNewLeadIds] = useState([])
  const [newLeadCount, setNewLeadCount] = useState(0)

  const isMountedRef = useRef(true)
  const prevLeadsRef = useRef([])
  const prevCountRef = useRef(0)
  const toastTimerRef = useRef(null)
  const animTimerRef = useRef(null)

  const seenRef = useRef(seen)
  seenRef.current = seen

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const fetchLeads = useCallback(async () => {
    if (!userId) {
      setLoading(false)
      return []
    }

    try {
      const fetchLimit =
        limit != null && Number(limit) > 0 ? Number(limit) : DEFAULT_FETCH_LIMIT
      const params = new URLSearchParams({
        sort: sort || 'score',
        limit: String(fetchLimit),
      })
      const sv = seenRef.current
      if (sv !== undefined && sv !== null && sv !== '') {
        params.set('seen', sv === true || sv === 'true' ? 'true' : 'false')
      }

      const url = `${apiUrl(`/api/leads/user/${userId}`)}?${params}`
      const res = await fetch(url)
      const data = await res.json()
      const arr = normalizeLeadsResponse(data)

      if (!isMountedRef.current) return arr

      const prev = prevLeadsRef.current
      const prevCount = prevCountRef.current
      if (prevCount > 0 && arr.length > prevCount) {
        setNewLeadCount(arr.length - prevCount)
        if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
        toastTimerRef.current = window.setTimeout(() => setNewLeadCount(0), 3000)
      }
      prevCountRef.current = arr.length

      const fresh = arr.filter((l) => !prev.find((p) => p.id === l.id))
      if (fresh.length > 0 && prev.length > 0) {
        const ids = fresh.map((l) => l.id)
        setNewLeadIds(ids)
        if (animTimerRef.current) window.clearTimeout(animTimerRef.current)
        animTimerRef.current = window.setTimeout(() => setNewLeadIds([]), 1400)
      }

      setLeads(arr)
      prevLeadsRef.current = arr
      return arr
    } catch (err) {
      console.error('[useLeads] fetch failed:', err)
      return []
    } finally {
      if (isMountedRef.current) setLoading(false)
    }
  }, [userId, sort, limit])

  useEffect(() => {
    if (!userId) {
      setLeads([])
      prevLeadsRef.current = []
      prevCountRef.current = 0
      setNewLeadIds([])
      setNewLeadCount(0)
      setLoading(false)
      return undefined
    }

    setLoading(true)
    void fetchLeads()
    return undefined
  }, [userId, fetchLeads])

  useEffect(() => {
    if (!userId) return undefined

    const ms = isScanning ? POLL_FAST_MS : POLL_SLOW_MS
    const id = window.setInterval(() => {
      void fetchLeads()
    }, ms)

    return () => {
      window.clearInterval(id)
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
      if (animTimerRef.current) window.clearTimeout(animTimerRef.current)
    }
  }, [userId, isScanning, fetchLeads])

  const markSeen = useCallback(async (id) => {
    const { data } = await api.patch(`/api/leads/${id}/seen`)
    setLeads((prev) =>
      prev.map((l) => (l.id === id ? { ...l, ...data, seen: true } : l))
    )
    prevLeadsRef.current = prevLeadsRef.current.map((l) =>
      l.id === id ? { ...l, ...data, seen: true } : l
    )
  }, [])

  const markUnread = useCallback(async (id) => {
    const { data } = await api.patch(`/api/leads/${id}/unseen`)
    setLeads((prev) =>
      prev.map((l) => (l.id === id ? { ...l, ...data, seen: false } : l))
    )
    prevLeadsRef.current = prevLeadsRef.current.map((l) =>
      l.id === id ? { ...l, ...data, seen: false } : l
    )
  }, [])

  const dismissLead = useCallback(async (id) => {
    await api.delete(`/api/leads/${id}`)
    setLeads((prev) => prev.filter((l) => l.id !== id))
    prevLeadsRef.current = prevLeadsRef.current.filter((l) => l.id !== id)
    prevCountRef.current = prevLeadsRef.current.length
  }, [])

  const suppressLead = useCallback(
    async (id, { mode, snooze_hours } = {}) => {
      if (!userId) return
      await api.post(`/api/leads/${id}/suppress`, {
        user_id: userId,
        mode,
        snooze_hours,
      })
      setLeads((prev) => prev.filter((l) => l.id !== id))
      prevLeadsRef.current = prevLeadsRef.current.filter((l) => l.id !== id)
      prevCountRef.current = prevLeadsRef.current.length
    },
    [userId]
  )

  const generateDraft = useCallback(async (id, options = {}) => {
    const { force = false } = options
    const { data } = await api.post(`/api/leads/${id}/draft`, { force })
    const draft = typeof data?.draft === 'string' ? data.draft : ''

    setLeads((prev) =>
      prev.map((l) => (l.id === id ? { ...l, ai_draft: draft } : l))
    )
    prevLeadsRef.current = prevLeadsRef.current.map((l) =>
      l.id === id ? { ...l, ai_draft: draft } : l
    )

    return { draft }
  }, [])

  const refreshLeads = useCallback(() => fetchLeads(), [fetchLeads])

  return {
    leads,
    loading,
    newLeadIds,
    newLeadCount,
    markSeen,
    markUnread,
    dismissLead,
    suppressLead,
    generateDraft,
    refreshLeads,
  }
}
