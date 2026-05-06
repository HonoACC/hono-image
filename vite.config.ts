import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  optimizeDeps: {
    entries: ['index.html'],
  },
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5188,
    proxy: {
      '/api/image-assets': {
        changeOrigin: true,
        target: 'http://127.0.0.1:5190',
      },
      '/api/image-tasks': {
        changeOrigin: true,
        target: 'http://127.0.0.1:5190',
      },
    },
    strictPort: true,
    watch: {
      ignored: ['**/lobehub-canary/**', '**/.hono-image-cache/**'],
    },
  },
})
