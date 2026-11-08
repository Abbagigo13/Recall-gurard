// Phase 6B: demo-access authentication. Scratch DB only; Meta/Walrus HTTP
// is answered from in-test handlers and the Tatum gRPC client is injected.
// Any other external request fails closed. No live calls.
import { describe, it, before, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

const BASE = `/tmp/rg-demoauth-test-${process.pid}`
const DB_PATH = `${BASE}/recallguard.db`
const PASSPHRASE = 'test-demo-passphrase-0123456789abcdef'

const savedEnv = {}
for (const key of ['RECALLGUARD_DB_PATH', 'RECALLGUARD_DEMO_PASSPHRASE', 'NODE_ENV', 'TATUM_API_KEY', 'META_API_KEY', 'META_MODEL', 'META_API_BASE', 'RECALLGUARD_ENABLE_DIAGNOSTICS', 'RECALLGUARD_RATE_LIMIT_LOGIN_MAX', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']) {
  savedEnv[key] = process.env[key]
}
process.env.RECALLGUARD_DB_PATH = DB_PATH
process.env.RECALLGUARD_DEMO_PASSPHRASE = PASSPHRASE
// Headroom for the many logins across this file; production default is 10.
process.env.RECALLGUARD_RATE_LIMIT_LOGIN_MAX = '100'
process.env.TATUM_API_KEY = 'offline-fake-tatum-key-0123456789abcdef'
process.env.META_API_KEY = 'offline-fake-meta-key-0123456789abcdef'
delete process.env.META_MODEL
delete process.env.META_API_BASE
delete process.env.RECALLGUARD_ENABLE_DIAGNOSTICS
delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.ALL_PROXY
delete process.env.http_proxy
delete process.env.https_proxy
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const {
  createSessionStore,
  requireDemoAuth,
  authConfigured,
  SESSION_COOKIE,
  CSRF_HEADER,
  AUTH_REQUIRED_CODE,
  AUTH_NOT_CONFIGURED_CODE,
  CSRF_INVALID_CODE
} = await import('./demo-auth.mjs')

const {
  default: router,
  setSuiGrpcClient
} = await import('./routes/recallguard.mjs')
const { default: tatumRouter } = await import('./routes/tatum.mjs')

function validAnalysis() {
  return {
    subQuestions: ['What checkpoint is latest?'],
    interpretation: 'The checkpoint advanced.',
    contradictions: [],
    uncertainties: ['Whether a newer checkpoint exists.'],
    evidenceGaps: [],
    confidenceNote: 'Based only on the supplied evidence.'
  }
}

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('127.0.0.1')) return realFetch(url, init)
  if (target.includes('api.meta.ai')) {
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content: JSON.stringify(validAnalysis()) } }] }),
      text: async () => 'unused'
    }
  }
  if (target.includes('publisher.walrus-testnet.walrus.space')) {
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ newlyCreated: { blobObject: { blobId: 'auth-test-blob', id: '0xauth', registeredEpoch: 1 }, cost: {} } }),
      text: async () => 'unused'
    }
  }
  if (target.includes('aggregator.walrus-testnet.walrus.space')) {
    return { ok: true, status: 200, headers: { get: () => 'text/plain' }, text: async () => 'unused' }
  }
  throw new Error(`unexpected external request: ${target}`)
}

let app
let server
let baseUrl

before(async () => {
  const { mkdirSync, rmSync } = await import('node:fs')
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(BASE, { recursive: true })
  app = express()
  app.use(express.json())
  app.use('/api/recallguard', router)
  app.use('/api/tatum', tatumRouter)
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
  setSuiGrpcClient({
    getSuiNetworkStatus: async () => { throw new Error('no tatum in auth tests') },
    getSuiServiceInfo: async () => { throw new Error('no tatum in auth tests') },
    getSuiCheckpoint: async () => { throw new Error('no tatum in auth tests') },
    getSuiObject: async () => { throw new Error('no tatum in auth tests') }
  })
})

afterEach(() => {
  setSuiGrpcClient({
    getSuiNetworkStatus: async () => { throw new Error('no tatum in auth tests') },
    getSuiServiceInfo: async () => { throw new Error('no tatum in auth tests') },
    getSuiCheckpoint: async () => { throw new Error('no tatum in auth tests') },
    getSuiObject: async () => { throw new Error('no tatum in auth tests') }
  })
})

after(async () => {
  await new Promise((resolve) => { server.close(resolve) })
  globalThis.fetch = realFetch
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

async function call(method, path, { cookie = null, csrf = null, body = undefined } = {}) {
  const headers = {}
  if (cookie) headers.Cookie = cookie
  if (csrf) headers[CSRF_HEADER] = csrf
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await realFetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { parsed = null }
  return { status: res.status, body: parsed, text, headers: res.headers }
}

function sessionCookieFrom(res) {
  const setCookie = res.headers.get('set-cookie') || ''
  const pair = setCookie.split(';')[0]
  assert.match(pair, new RegExp(`^${SESSION_COOKIE}=`))
  return pair
}

async function loginAsDemo() {
  const logged = await call('POST', '/api/recallguard/auth/login', { body: { passphrase: PASSPHRASE } })
  assert.equal(logged.status, 200)
  return { cookie: sessionCookieFrom(logged), csrf: logged.body.csrfToken }
}

describe('demo auth unit behavior', () => {
  it('detects configuration from the environment', () => {
    assert.equal(authConfigured({ RECALLGUARD_DEMO_PASSPHRASE: 'x' }), true)
    assert.equal(authConfigured({}), false)
    assert.equal(authConfigured({ RECALLGUARD_DEMO_PASSPHRASE: '' }), false)
  })

  it('passes through in development when no passphrase is configured', async () => {
    let nextCalled = false
    const middleware = requireDemoAuth({ env: {} })
    await new Promise((resolve) => {
      middleware({ headers: {}, method: 'POST' }, { status: () => { throw new Error('must not deny') } }, () => {
        nextCalled = true
        resolve()
      })
    })
    assert.equal(nextCalled, true)
  })

  it('denies with 503 in production when no passphrase is configured', async () => {
    let denied = null
    const middleware = requireDemoAuth({ env: { NODE_ENV: 'production' } })
    middleware({ headers: {}, method: 'POST' }, {
      status: (code) => ({ json: (body) => { denied = { code, body } } })
    }, () => { throw new Error('must not pass') })
    assert.equal(denied.code, 503)
    assert.equal(denied.body.code, AUTH_NOT_CONFIGURED_CODE)
  })

  it('sessions expire after the TTL', () => {
    let now = 1_000_000
    const store = createSessionStore({ now: () => now })
    const { token } = store.create()
    assert.ok(store.lookup(token))
    now += 8 * 60 * 60 * 1000 + 1
    assert.equal(store.lookup(token), null)
  })
})

describe('demo auth routes', () => {
  it('rejects a wrong passphrase without leaking anything', async () => {
    const { status, body, text } = await call('POST', '/api/recallguard/auth/login', {
      body: { passphrase: 'wrong-passphrase' }
    })
    assert.equal(status, 401)
    assert.equal(body.code, AUTH_REQUIRED_CODE)
    assert.doesNotMatch(text, new RegExp(PASSPHRASE))
  })

  it('rejects a missing passphrase body', async () => {
    const { status } = await call('POST', '/api/recallguard/auth/login', { body: {} })
    assert.equal(status, 401)
  })

  it('login issues an HttpOnly session cookie and a CSRF token', async () => {
    const res = await realFetch(`${baseUrl}/api/recallguard/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: PASSPHRASE })
    })
    const setCookie = res.headers.get('set-cookie') || ''
    assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=[0-9a-f]{64}`))
    assert.match(setCookie, /HttpOnly/i)
    assert.match(setCookie, /SameSite=Lax/i)
    assert.match(setCookie, /Max-Age=\d+/i)
    const body = await res.json()
    assert.equal(body.authenticated, true)
    assert.match(body.csrfToken, /^[0-9a-f]{64}$/)
    // Neither the passphrase nor the session token appears in the body.
    assert.doesNotMatch(JSON.stringify(body), new RegExp(PASSPHRASE))
    const token = setCookie.split(';')[0].split('=')[1]
    assert.doesNotMatch(JSON.stringify(body), new RegExp(token))
  })

  it('status reflects the session and logout clears it', async () => {
    const before = await call('GET', '/api/recallguard/auth/status')
    assert.equal(before.body.authenticated, false)
    const { cookie } = await loginAsDemo()
    const during = await call('GET', '/api/recallguard/auth/status', { cookie })
    assert.equal(during.body.authenticated, true)
    await call('POST', '/api/recallguard/auth/logout', { cookie })
    const afterLogout = await call('GET', '/api/recallguard/auth/status', { cookie })
    assert.equal(afterLogout.body.authenticated, false)
  })

  it('never logs the passphrase or session token', async () => {
    const lines = []
    const origLog = console.log
    const origError = console.error
    console.log = (...args) => { lines.push(args.map(String).join(' ')) }
    console.error = (...args) => { lines.push(args.map(String).join(' ')) }
    let token = null
    try {
      const res = await realFetch(`${baseUrl}/api/recallguard/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: PASSPHRASE })
      })
      token = (res.headers.get('set-cookie') || '').split(';')[0].split('=')[1]
      await res.json()
      await call('POST', '/api/recallguard/auth/logout', { cookie: `${SESSION_COOKIE}=${token}` })
    } finally {
      console.log = origLog
      console.error = origError
    }
    const dump = lines.join('\n')
    assert.doesNotMatch(dump, new RegExp(PASSPHRASE))
    if (token) assert.doesNotMatch(dump, new RegExp(token))
  })
})

describe('protected spend-bearing routes', () => {
  it('rejects unauthenticated POST /sessions', async () => {
    const { status, body } = await call('POST', '/api/recallguard/sessions', {
      body: { question: 'What is the latest Sui checkpoint status on mainnet?' }
    })
    assert.equal(status, 401)
    assert.equal(body.code, AUTH_REQUIRED_CODE)
  })

  it('rejects unauthenticated POST /memories', async () => {
    const { status, body } = await call('POST', '/api/recallguard/memories', {
      body: { title: 'Probe memory title', content: 'Probe memory content for auth.' }
    })
    assert.equal(status, 401)
    assert.equal(body.code, AUTH_REQUIRED_CODE)
  })

  it('rejects unauthenticated POST /sui/rpc', async () => {
    const { status, body } = await call('POST', '/api/recallguard/sui/rpc', {
      body: { method: 'sui_getChainIdentifier', params: [], network: 'mainnet' }
    })
    assert.equal(status, 401)
    assert.equal(body.code, AUTH_REQUIRED_CODE)
  })

  it('rejects unauthenticated GET /api/tatum/status (live egress)', async () => {
    const { status, body } = await call('GET', '/api/tatum/status')
    assert.equal(status, 401)
    assert.equal(body.code, AUTH_REQUIRED_CODE)
  })

  it('keeps ordinary dashboard reads public', async () => {
    for (const path of ['/api/recallguard/sessions', '/api/recallguard/memories', '/api/recallguard/metrics', '/api/recallguard/timeline', '/api/recallguard/health/ready', '/api/recallguard/config-status']) {
      const { status } = await call('GET', path)
      assert.equal(status, 200, path)
    }
  })

  it('rejects an authenticated session without a CSRF header', async () => {
    const { cookie } = await loginAsDemo()
    const { status, body } = await call('POST', '/api/recallguard/memories', {
      cookie,
      body: { title: 'Probe memory title', content: 'Probe memory content for auth.' }
    })
    assert.equal(status, 403)
    assert.equal(body.code, CSRF_INVALID_CODE)
  })

  it('rejects a forged CSRF token', async () => {
    const { cookie } = await loginAsDemo()
    const { status, body } = await call('POST', '/api/recallguard/memories', {
      cookie,
      csrf: '0'.repeat(64),
      body: { title: 'Probe memory title', content: 'Probe memory content for auth.' }
    })
    assert.equal(status, 403)
    assert.equal(body.code, CSRF_INVALID_CODE)
  })

  it('an authenticated request with a valid CSRF token proceeds', async () => {
    const { cookie, csrf } = await loginAsDemo()
    const { status, body } = await call('POST', '/api/recallguard/memories', {
      cookie,
      csrf,
      body: { title: 'Authed probe memory', content: 'Stored through a valid demo session.' }
    })
    assert.equal(status, 201)
    assert.equal(body.success, true)
  })

  it('a forged session cookie is rejected', async () => {
    const { status, body } = await call('POST', '/api/recallguard/sui/rpc', {
      cookie: `${SESSION_COOKIE}=${'f'.repeat(64)}`,
      csrf: '0'.repeat(64),
      body: { method: 'sui_getChainIdentifier', params: [], network: 'mainnet' }
    })
    assert.equal(status, 401)
    assert.equal(body.code, AUTH_REQUIRED_CODE)
  })
})
