import { useCallback, useEffect, useState } from 'react'

import { api } from '../lib/api'

export function useKeywordSets(userId) {
  const [keywordSets, setKeywordSets] = useState([])
  const [loading, setLoading] = useState(Boolean(userId))

  const refresh = useCallback(async () => {
    if (!userId) return

    setLoading(true)

    try {
      const { data } = await api.get(`/api/keyword-sets/user/${userId}`)

      setKeywordSets(Array.isArray(data) ? data : [])
    } catch (e) {
      console.error('[useKeywordSets] refresh', e)
      setKeywordSets([])
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    if (!userId) {
      setKeywordSets([])
      setLoading(false)
      return
    }

    refresh()
  }, [userId, refresh])

  const createKeywordSet = useCallback(
    async (productDescription) => {
      if (!userId) throw new Error('missing userId')

      try {
        const { data: created } = await api.post('/api/keyword-sets', {
          user_id: userId,
          product_description: productDescription,
        })

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
