
// Load local environment variables first.
import './env-bootstrap.mjs'

// Configure outbound HTTP proxy before network-dependent routes.
import './proxy-bootstrap.mjs'

// Load credentials after environment bootstrap.
// Supports credential rotation through the credentials store.
import './credentials-store.mjs'

import express from 'express'
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'http'
import { createServer as createViteServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'
import path from 'path'
import tatumRoutes from './routes/tatum.mjs'
import recallguardRoutes from './routes/recallguard.mjs'
import { credentialGuard } from './credential-guard.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

// Ensure development tools resolve paths from the project root.
process.chdir(root)

const app = express()
app.use(express.json())

// Redact the Tatum API key from every response.
app.use(credentialGuard)

// Mount API routes.
app.use('/api/tatum', tatumRoutes)
app.use('/api/recallguard', recallguardRoutes)

const server = createHttpServer(app)

// Start Vite in middleware mode.
const vite = await createViteServer({
  root,
  configFile: false,
  cacheDir: '/tmp/vite',
  plugins: [react()],
  server: {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true,
  },
  appType: 'spa',
})

// History-API app route: serve the transformed index.html for /dashboard
// (and only there) so direct navigation and refresh work. API routes above
// take precedence; everything else falls through to Vite as before.
app.get('/dashboard', async (req, res, next) => {
  try {
    const template = readFileSync(path.join(root, 'index.html'), 'utf8')
    const html = await vite.transformIndexHtml(req.originalUrl, template)
    res.type('html').send(html)
  } catch (error) {
    next(error)
  }
})

app.use(vite.middlewares)

// Start HTTP server on the loopback interface only. The demo spends real
// API quota (Tatum, Meta, Walrus) on unauthenticated endpoints, so it must
// never listen on an externally reachable interface by default. There is
// intentionally no environment override: to expose the server, edit the
// address below explicitly.
const port = process.env.PORT ?? 3000

server.listen(port, '127.0.0.1', () => {
  console.log(`RecallGuard development server listening on 127.0.0.1:${port}`)
})
