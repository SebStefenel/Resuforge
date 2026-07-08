import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // First compiles can take a few minutes (MiKTeX package downloads);
        // don't let the proxy time out before the backend responds.
        timeout: 600000,
        proxyTimeout: 600000,
        configure: (proxy) => {
          // If the backend is down/unreachable, return JSON so the UI can show
          // a useful message instead of an empty body.
          proxy.on('error', (err, req, res) => {
            if (res && typeof res.writeHead === 'function' && !res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({
                error: 'Backend unreachable',
                log:
                  'The compile server at http://localhost:3001 is not responding.\n' +
                  'Make sure the backend is running (start.ps1, or "node server.js" ' +
                  'in the backend folder), then Recompile.\n\nDetails: ' + err.message
              }))
            }
          })
        }
      }
    }
  }
})
