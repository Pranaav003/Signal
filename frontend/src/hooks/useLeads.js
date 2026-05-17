import { useCallback, useEffect, useRef, useState } from 'react'

import { api } from '../lib/api'

const DEFAULT_FETCH_LIMIT = 200
const POLL_SLOW_MS = 30_000
const POLL_SCAN_MS = 20_000
const RATE_LIMIT_BACKOFF_MS = 30_000

function normalizeLeadsResponse(data) {
  if (Array.isArray(data)) return data
  if (data?.leads && Array.isArray(data.leads)) return data.leads
  return []
}

/**
 * @param {string | null} userId
 * @param {{ isScanning?: boolean, sort?: string, seen?: boolean | string, limit?: number }} [options]
 */
export function useLeads(userId, options = {}) {
  const {
    isScanning = false,
    sort = 'score',
    seen,
    limit = DEFAULT_FETCH_LIMIT,
  } = options

  const [leads, setLeads] = useState([])
  const [loading, setLoading] = useState(Boolean(userId))
  const [newLeadIds, setNewLeadIds] = useState([])
  const [newLeadCount, setNewLeadCount] = useState(0)
  const [pollingMessage, setPollingMessage] = useState('')

  const mountedRef = useRef(false)
  const inFlightRef = useRef(false)
  const pollTimeoutRef = useRef(null)
  const backoffUntilRef = useRef(0)
  const seenRef = useRef(seen)
  const prevLeadsRef = useRef([])
  const prevCountRef = useRef(0)
  const toastTimerRef = useRef(null)
  const animTimerRef = useRef(null)

  seenRef.current = seen

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (pollTimeoutRef.current != null) {
        window.clearTimeout(pollTimeoutRef.current)
        pollTimeoutRef.current = null
      }
      if (toastTimerRef.current != null) {
        window.clearTimeout(toastTimerRef.current)
        toastTimerRef.current = null
      }
      if (animTimerRef.current != null) {
        window.clearTimeout(animTimerRef.current)
        animTimerRef.current = null
      }
    }
  }, [])

  const fetchLeads = useCallback(async () => {
    if (!userId) {
      if (mountedRef.current) {
        setLeads([])
        setLoading(false)
      }
      return []
    }

    if (inFlightRef.current) {
      return prevLeadsRef.current
    }

    if (Date.now() < backoffUntilRef.current) {
      return prevLeadsRef.current
    }

    inFlightRef.current = true

    try {
      const fetchLimit =
        limit != null && Number(limit) > 0 ? Number(limit) : DEFAULT_FETCH_LIMIT
      const params = {
        sort: sort || 'score',
        limit: fetchLimit,
      }
      const sv = seenRef.current
      if (sv !== undefined && sv !== null && sv !== '') {
        params.seen = sv === true || sv === 'true' ? 'true' : 'false'
      }

      const { data } = await api.get(`/api/leads/user/${userId}`, { params })
      const arr = normalizeLeadsResponse(data)

      if (!mountedRef.current) return arr

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
      setPollingMessage('')
      return arr
    } catch (err) {
      if (err?.response?.status === 429) {
        backoffUntilRef.current = Date.now() + RATE_LIMIT_BACKOFF_MS
        if (mountedRef.current) {
          setPollingMessage('Refreshing too quickly. Waiting before retrying...')
        }
        return prevLeadsRef.current
      }

      console.error('[useLeads] fetch failed:', err?.message || err)
      return prevLeadsRef.current
    } finally {
      inFlightRef.current = false
      if (mountedRef.current) setLoading(false)
    }
  }, [userId, sort, limit])

  useEffect(() => {
    if (!userId) {
      setLeads([])
      prevLeadsRef.current = []
      prevCountRef.current = 0
      setNewLeadIds([])
      setNewLeadCount(0)
      setPollingMessage('')
      setLoading(false)
      return undefined
    }

    let cancelled = false

    const schedule = (delayMs) => {
      if (cancelled) return
      if (pollTimeoutRef.current != null) {
        window.clearTimeout(pollTimeoutRef.current)
      }
      pollTimeoutRef.current = window.setTimeout(() => {
        void tick()
      }, delayMs)
    }

    const tick = async () => {
      if (cancelled) return

      const now = Date.now()
      if (backoffUntilRef.current > now) {
        schedule(backoffUntilRef.current - now)
        return
      }

      await fetchLeads()

      if (cancelled) return
      const nextDelay = isScanning ? POLL_SCAN_MS : POLL_SLOW_MS
      schedule(nextDelay)
    }

    setLoading(true)
    void tick()

    return () => {
      cancelled = true
      if (pollTimeoutRef.current != null) {
        window.clearTimeout(pollTimeoutRef.current)
        pollTimeoutRef.current = null
      }
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

  const generateDraft = useCallback(async (id, draftOptions = {}) => {
    const { force = false } = draftOptions
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
    pollingMessage,
    markSeen,
    markUnread,
    dismissLead,
    suppressLead,
    generateDraft,
    refreshLeads,
  }
}
