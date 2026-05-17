import axios from 'axios'

export const BASE_URL = import.meta.env.VITE_API_URL || ''

export const api = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json' },
})

/** Normalize axios errors so callers can read message/error without parsing response bodies. */
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const data = error?.response?.data
    if (data && typeof data === 'object') {
      if (!error.message && typeof data.message === 'string') {
        error.message = data.message
      }
      if (!error.message && typeof data.error === 'string') {
        error.message = data.error
      }
    }
    return Promise.reject(error)
  }
)
