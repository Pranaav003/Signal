import { useEffect, useState } from 'react'

import { api } from '../lib/api'

const STORAGE_KEY = 'signal_user_id'
const DEMO_EMAIL = 'demo@signal.app'

export function useUser() {
  const [userId, setUserId] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function ensureUser() {
      try {
        const existing = localStorage.getItem(STORAGE_KEY)

        if (existing) {
          if (!cancelled) setUserId(existing)
          return
        }

        const { data: user } = await api.post('/api/users', {
          email: DEMO_EMAIL,
        })

        localStorage.setItem(STORAGE_KEY, user.id)

        if (!cancelled) setUserId(user.id)
      } catch (e) {
        console.error('[useUser]', e)
        if (!cancelled) setUserId(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    ensureUser()

    return () => {
      cancelled = true
    }
  }, [])

  return { userId, loading, email: DEMO_EMAIL }
}
