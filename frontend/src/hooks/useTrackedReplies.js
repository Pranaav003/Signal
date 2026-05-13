import { useCallback, useEffect, useState } from 'react'

import { api } from '../lib/api'

export function useTrackedReplies(userId) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!userId) {
      setRows([])
      return
    }

    setLoading(true)
    try {
      const { data } = await api.get(`/api/tracked-replies/user/${userId}`)
      setRows(Array.isArray(data) ? data : [])
    } catch (e) {
      console.error('[useTrackedReplies]', e)
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { rows, loading, refresh }
}
