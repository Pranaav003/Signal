import { useCallback, useEffect, useState } from 'react'

import { api } from '../lib/api'

export function useKeywordSets(userId) {
  const [keywordSets, setKeywordSets] = useState([])
  const [loading, setLoading] = useState(Boolean(userId))

  /** Refetch without toggling `loading` — avoids sidebar / page “reload” flashes after creates or manual refresh. */
  const refresh = useCallback(async () => {
    if (!userId) return

    try {
      const { data } = await api.get(`/api/keyword-sets/user/${userId}`)

      setKeywordSets(Array.isArray(data) ? data : [])
    } catch (e) {
      console.error('[useKeywordSets] refresh', e)
      setKeywordSets([])
    }
  }, [userId])

  useEffect(() => {
    if (!userId) {
      setKeywordSets([])
      setLoading(false)
      return undefined
    }

    let cancelled = false

    ;(async () => {
      setLoading(true)

      try {
        const { data } = await api.get(`/api/keyword-sets/user/${userId}`)

        if (!cancelled) setKeywordSets(Array.isArray(data) ? data : [])
      } catch (e) {
        console.error('[useKeywordSets] initial load', e)
        if (!cancelled) setKeywordSets([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [userId])

  const createKeywordSet = useCallback(
    async (productDescription, scanIntervalHours = 6, pitchLine = null) => {
      if (!userId) throw new Error('missing userId')

      const hours = Number(scanIntervalHours)
      const scan_interval_hours = [6, 12, 24].includes(hours) ? hours : 6

      const body = {
        user_id: userId,
        product_description: productDescription,
        scan_interval_hours,
      }

      if (typeof pitchLine === 'string' && pitchLine.trim()) {
        body.pitch_line = pitchLine.trim()
      }

      try {
        const { data: created } = await api.post('/api/keyword-sets', body)

        await refresh()

        return created
      } catch (err) {
        const msg =
          err?.response?.data?.error ||
          err?.response?.data ||
          err?.message ||
          'create failed'

        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
      }
    },
    [userId, refresh]
  )

  const deleteKeywordSet = useCallback(
    async (id) => {
      await api.delete(`/api/keyword-sets/${id}`)
      await refresh()
    },
    [refresh]
  )

  return { keywordSets, loading, createKeywordSet, deleteKeywordSet, refresh }
}
