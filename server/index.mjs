
// Load local environment variables first.
import './env-bootstrap.mjs'

// Configure outbound HTTP proxy before network-dependent routes.
import './proxy-bootstrap.mjs'

// Load credentials after environment bootstrap.
// Supports credential rotation through the credentials store.
import './credentials-store.mjs'

import express from 'express'
import { createServer as createHttpServer } from 'http'
import { createServer as createViteServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'
import path from 'path'
import tatumRoutes from './routes/tatum.mjs'
import recallguardRoutes, { getPersistenceStore } from './routes/recallguard.mjs'
import { credentialGuard } from './credential-guard.mjs'
import { resolveBind } from './startup.mjs'
import { mountDevFrontend, mountProdFrontend } from './frontend.mjs'
import { createShutdown } from './shutdown.mjs'

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

// Environment-aware binding (Phase 6B). Development stays loopback-only
// with the Vite middleware workflow; production binds all interfaces on
// the platform-provided PORT and serves the prebuilt dist/ bundle.
// resolveBind throws in production without a valid PORT — never silently
// falling back — and leaves development behavior unchanged.
const { host, port, isProd } = resolveBind()

let vite = null
if (!isProd) {
  // Development: existing Vite middleware workflow, untouched.
  vite = await mountDevFrontend({ app, server, root, createViteServer, reactPlugin: react })
} else {
  // Production: plain Express static serving, no Vite middleware.
  mountProdFrontend(app, path.join(root, 'dist'))
}

server.listen(port, host, () => {
  console.log(`RecallGuard ${isProd ? 'production' : 'development'} server listening on ${host}:${port}`)
})

// Graceful shutdown: SIGTERM (platform stop) and SIGINT (local Ctrl-C).
// Stops accepting requests, lets in-flight work drain bounded, then
// checkpoints SQLite and closes it exactly once.
const persistenceStore = getPersistenceStore()
const shutdown = createShutdown({
  closeServer: (done) => server.close(done),
  closeVite: vite ? () => vite.close() : null,
  checkpointStores: [() => persistenceStore.checkpoint()],
  closeStores: [() => persistenceStore.close()],
  exitFn: (code) => process.exit(code)
})
shutdown.install()
