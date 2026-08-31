import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'buffer/': 'buffer',
      'buffer': 'buffer',
      'stream': 'stream-browserify',
      'util': 'util',
      'process': 'process/browser',
    },
  },
  define: {
    global: 'window',
    'process.env': {},
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/auth': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
