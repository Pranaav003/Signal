import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiProxyTarget = env.SIGNAL_API_PROXY || 'http://127.0.0.1:3001'

  return {
    plugins: [react()],
    server: {
      // Listen on IPv4 + IPv6 so 127.0.0.1 and localhost both work (macOS often bound ::1 only).
      host: true,
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
