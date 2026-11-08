// Phase 6B: environment-aware startup, production static serving, and the
// local-only readiness probe. Scratch DB only; any non-localhost request
// fails closed. No live Tatum/Meta/Walrus traffic.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

import { resolveBind, isProduction, PRODUCTION_PORT_REQUIRED } from './startup.mjs'
import { mountProdFrontend, API_NOT_FOUND_CODE } from './frontend.mjs'

const BASE = `/tmp/rg-production-test-${process.pid}`
const DB_PATH = `${BASE}/recallguard.db`
const DIST = `${BASE}/dist`

const savedEnv = {}
for (const key of ['RECALLGUARD_DB_PATH', 'TATUM_API_KEY', 'META_API_KEY', 'RECALLGUARD_DEMO_PASSPHRASE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']) {
  savedEnv[key] = process.env[key]
}
process.env.RECALLGUARD_DB_PATH = DB_PATH
delete process.env.TATUM_API_KEY
delete process.env.META_API_KEY
delete process.env.RECALLGUARD_DEMO_PASSPHRASE
delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.ALL_PROXY
delete process.env.http_proxy
delete process.env.https_proxy
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const { default: router, getPersistenceStore } = await import('./routes/recallguard.mjs')

// Any external request is a test failure.
const realFetch = globalThis.fetch
let externalCalls = 0
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('127.0.0.1')) return realFetch(url, init)
  externalCalls += 1
  throw new Error(`unexpected external request: ${target}`)
}

let app
let server
let baseUrl

before(async () => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(`${DIST}/assets`, { recursive: true })
  writeFileSync(`${DIST}/index.html`, '<html><body>RecallGuard</body></html>')
  writeFileSync(`${DIST}/assets/app.js`, 'console.log("app")')
  writeFileSync(`${DIST}/.env`, 'SECRET=should-never-serve')
  app = express()
  app.use(express.json())
  app.use('/api/recallguard', router)
  mountProdFrontend(app, DIST)
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => { server.close(resolve) })
  globalThis.fetch = realFetch
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

async function get(path) {
  const res = await realFetch(`${baseUrl}${path}`)
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = null }
  return { status: res.status, body, text }
}

describe('environment-aware binding', () => {
  it('development binds loopback only', () => {
    const bind = resolveBind({ NODE_ENV: 'development' })
    assert.equal(bind.host, '127.0.0.1')
    assert.equal(bind.isProd, false)
  })

  it('unset NODE_ENV keeps development behavior', () => {
    const bind = resolveBind({})
    assert.equal(bind.host, '127.0.0.1')
    assert.equal(bind.isProd, false)
  })

  it('development preserves the default port and honors PORT', () => {
    assert.equal(resolveBind({}).port, 3000)
    assert.equal(resolveBind({ PORT: '4000' }).port, 4000)
  })

  it('production requires PORT and never falls back silently', () => {
    assert.throws(() => resolveBind({ NODE_ENV: 'production' }), (error) => {
      assert.match(error.message, new RegExp(PRODUCTION_PORT_REQUIRED))
      return true
    })
    assert.throws(() => resolveBind({ NODE_ENV: 'production', PORT: 'abc' }), /PRODUCTION_PORT_REQUIRED/)
  })

  it('production binds all interfaces on the platform port', () => {
    const bind = resolveBind({ NODE_ENV: 'production', PORT: '8080' })
    assert.equal(bind.host, '0.0.0.0')
    assert.equal(bind.port, 8080)
    assert.equal(bind.isProd, true)
  })

  it('isProduction is true only for production', () => {
    assert.equal(isProduction({ NODE_ENV: 'production' }), true)
    assert.equal(isProduction({ NODE_ENV: 'development' }), false)
    assert.equal(isProduction({}), false)
  })
})

describe('production static serving', () => {
  it('serves the landing page at /', async () => {
    const { status, text } = await get('/')
    assert.equal(status, 200)
    assert.match(text, /RecallGuard/)
  })

  it('serves the dashboard shell at /dashboard', async () => {
    const { status, text } = await get('/dashboard')
    assert.equal(status, 200)
    assert.match(text, /RecallGuard/)
  })

  it('serves built assets', async () => {
    const { status, text } = await get('/assets/app.js')
    assert.equal(status, 200)
    assert.match(text, /console\.log/)
  })

  it('falls back to index.html for client routes (refresh support)', async () => {
    const { status, text } = await get('/dashboard/research')
    assert.equal(status, 200)
    assert.match(text, /RecallGuard/)
  })

  it('returns JSON 404 for unknown API routes, never index.html', async () => {
    const { status, body } = await get('/api/recallguard/nope')
    assert.equal(status, 404)
    assert.equal(body.code, API_NOT_FOUND_CODE)
  })

  it('never exposes dotfiles from dist', async () => {
    // Unmatched paths fall back to the SPA shell; what matters is that the
    // dotfile bytes are never served.
    const { text } = await get('/.env')
    assert.doesNotMatch(text, /SECRET=should-never-serve/)
    assert.match(text, /RecallGuard/)
  })
})

describe('readiness probe', () => {
  it('returns 200 with a stable code when SQLite is persistent', async () => {
    const { status, body } = await get('/api/recallguard/health/ready')
    assert.equal(status, 200)
    assert.equal(body.ready, true)
    assert.equal(body.code, 'READY')
  })

  it('exposes no paths, secrets, or raw errors', async () => {
    const { body, text } = await get('/api/recallguard/health/ready')
    assert.deepEqual(Object.keys(body).sort(), ['code', 'ready'])
    assert.doesNotMatch(text, /\/tmp|\/data|\/home|\/root|sqlite|SQLITE/i)
  })

  it('performs zero writes: store contents are identical before and after', async () => {
    const store = getPersistenceStore()
    const before = JSON.stringify({
      sessions: store.listSessions().map((s) => s.id),
      memories: store.listMemories().map((m) => m.id),
      audit: store.listAudit(1000).length
    })
    for (let i = 0; i < 5; i++) await get('/api/recallguard/health/ready')
    const after = JSON.stringify({
      sessions: store.listSessions().map((s) => s.id),
      memories: store.listMemories().map((m) => m.id),
      audit: store.listAudit(1000).length
    })
    assert.equal(after, before)
  })

  it('makes zero external calls', async () => {
    externalCalls = 0
    await get('/api/recallguard/health/ready')
    await get('/api/recallguard/health/ready')
    assert.equal(externalCalls, 0)
  })

  it('the detailed health endpoint is unchanged and still present', async () => {
    const { status, body } = await get('/api/recallguard/health')
    assert.equal(status, 200)
    assert.equal(body.status, 'ok')
    assert.ok(body.integrations)
  })
})
