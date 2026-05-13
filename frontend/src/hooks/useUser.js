import { useEffect, useState } from 'react'

import { BASE_URL } from '../lib/api'

const CACHE_KEY = 'signal_user'

function apiUrl(path) {
  const root = String(BASE_URL || '').replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return root ? `${root}${p}` : p
}

export function useUser() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const initUser = async () => {
      try {
        let anonId = localStorage.getItem('signal_anon_id')

        if (!anonId) {
          anonId =
            'anon_' +
            Math.random().toString(36).slice(2) +
            '_' +
            Date.now().toString(36)
          localStorage.setItem('signal_anon_id', anonId)
        }

        const email = `${anonId}@signal.anon`

        const cached = localStorage.getItem(CACHE_KEY)
        if (cached) {
          try {
            const parsed = JSON.parse(cached)
            if (parsed?.id && parsed?.email === email) {
              setUser(parsed)
              setLoading(false)
              return
            }
          } catch {
            localStorage.removeItem(CACHE_KEY)
          }
        }

        const res = await fetch(apiUrl('/api/users'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        })

        const data = await res.json()

        if (data?.id) {
          localStorage.setItem(CACHE_KEY, JSON.stringify(data))
          setUser(data)
        }
      } catch (err) {
        console.error('[useUser] Failed to init user:', err)
      } finally {
        setLoading(false)
      }
    }

    void initUser()
  }, [])

  return {
    user,
    loading,
    userId: user?.id ?? null,
    email: user?.email ?? '',
  }
}
