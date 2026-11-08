// Frontend mounting split by environment (Phase 6B).
//
// Development keeps the existing Vite middleware workflow untouched.
// Production serves the prebuilt dist/ directory with plain Express and
// never touches Vite. API routes are always mounted first, so this module
// only handles what the routers declined.
import express from 'express'
import path from 'node:path'

export const API_NOT_FOUND_CODE = 'NOT_FOUND'

// Development: identical to the pre-6B behavior. Kept here so index.mjs
// reads as an explicit branch instead of inline Vite setup.
export async function mountDevFrontend({ app, server, root, createViteServer, reactPlugin }) {
  const vite = await createViteServer({
    root,
    configFile: false,
    cacheDir: '/tmp/vite',
    plugins: [reactPlugin()],
    server: {
      middlewareMode: true,
      hmr: { server },
      allowedHosts: true
    },
    appType: 'spa'
  })

  // History-API app route: serve the transformed index.html for /dashboard
  // (and only there) so direct navigation and refresh work. API routes
  // above take precedence; everything else falls through to Vite as before.
  const { readFileSync } = await import('node:fs')
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
  return vite
}

// Production: static dist/ serving + SPA fallback.
//
// Ordering guarantees:
// 1. Unknown /api/* routes get a JSON 404 (never index.html).
// 2. Built assets are served with caching; dotfiles are denied.
// 3. GET / and GET /dashboard serve dist/index.html.
// 4. Any other unmatched GET (browser refresh on a client route) falls
//    back to dist/index.html.
// 5. Only files inside distDir are ever exposed: .env, *.db*, source and
//    credentials live outside it and cannot be reached through here.
export function mountProdFrontend(app, distDir) {
  const indexFile = path.join(distDir, 'index.html')

  // Unknown API routes: JSON 404, not the SPA shell.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Unknown API route', code: API_NOT_FOUND_CODE })
  })

  app.use(
    express.static(distDir, {
      index: false,
      dotfiles: 'deny',
      maxAge: '1h'
    })
  )

  app.get(['/', '/dashboard'], (_req, res) => {
    res.sendFile(indexFile)
  })

  // Client-side routes below /dashboard (refresh / deep link).
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next()
    res.sendFile(indexFile)
  })
}
