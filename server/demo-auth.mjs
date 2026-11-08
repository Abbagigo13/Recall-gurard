// Minimal demo-access authentication (Phase 6B).
//
// Design: a demo passphrase (server-side Railway secret, never sent to the
// browser) unlocks a random server-side session. The session token travels
// in a Secure/HttpOnly/SameSite cookie; mutating requests additionally
// present a per-session CSRF token in the `x-csrf-token` header. The CSRF
// token lives in frontend memory only — never localStorage.
//
// - No new dependencies: node:crypto only.
// - Sessions are in-memory. That is safe only for the documented
//   single-replica deployment: sessions do NOT survive restarts and are
//   NOT shared between replicas.
// - When RECALLGUARD_DEMO_PASSPHRASE is unset, development stays open
//   (existing local behavior) while production denies protected routes
//   instead of silently running unprotected.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { createRateLimiter, rateLimitOptions } from './rate-limit.mjs'

export const AUTH_REQUIRED_CODE = 'AUTH_REQUIRED'
export const AUTH_NOT_CONFIGURED_CODE = 'AUTH_NOT_CONFIGURED'
export const CSRF_INVALID_CODE = 'CSRF_INVALID'
export const SESSION_COOKIE = 'rg_demo'
export const CSRF_HEADER = 'x-csrf-token'

// Reasonable demo TTL: one working day of access per login.
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000

function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

// Constant-shape comparison: both sides are hashed first so length can
// never leak through timing or error branches.
function secretsEqual(presented, expected) {
  const a = Buffer.from(sha256Hex(presented), 'hex')
  const b = Buffer.from(sha256Hex(expected), 'hex')
  return timingSafeEqual(a, b)
}

export function authConfigured(env = process.env) {
  const secret = env.RECALLGUARD_DEMO_PASSPHRASE
  return typeof secret === 'string' && secret.length > 0
}

export function isProductionEnv(env = process.env) {
  return env.NODE_ENV === 'production'
}

function baseCookieAttributes({ secure }) {
  const parts = ['Path=/', 'HttpOnly', 'SameSite=Lax']
  // Secure cookies are never sent over http://, so local development
  // (http://127.0.0.1) must omit it; production always sets it.
  if (secure) parts.push('Secure')
  return parts
}

export function buildSessionCookie(token, { secure }) {
  return [
    `${SESSION_COOKIE}=${token}`,
    ...baseCookieAttributes({ secure }),
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ].join('; ')
}

export function clearSessionCookie({ secure }) {
  return [
    `${SESSION_COOKIE}=`,
    ...baseCookieAttributes({ secure }),
    'Max-Age=0'
  ].join('; ')
}

export function parseCookies(header) {
  const out = {}
  if (!header || typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name && !(name in out)) out[name] = decodeURIComponent(value)
  }
  return out
}

// Server-side session registry. Token hashes only — raw tokens never rest
// here, so a heap dump cannot be replayed directly.
export function createSessionStore({ now = Date.now } = {}) {
  const sessions = new Map()
  let lastPrune = 0

  function prune() {
    const at = now()
    if (at - lastPrune < 60_000) return
    lastPrune = at
    for (const [hash, session] of sessions) {
      if (session.expiresAt <= at) sessions.delete(hash)
    }
  }

  return {
    create() {
      prune()
      const token = randomBytes(32).toString('hex')
      const csrfToken = randomBytes(32).toString('hex')
      const session = { csrfToken, expiresAt: now() + SESSION_TTL_MS }
      sessions.set(sha256Hex(token), session)
      return { token, csrfToken, expiresAt: session.expiresAt }
    },
    lookup(token) {
      if (!token) return null
      const session = sessions.get(sha256Hex(token))
      if (!session) return null
      if (session.expiresAt <= now()) {
        sessions.delete(sha256Hex(token))
        return null
      }
      return session
    },
    destroy(token) {
      if (!token) return
      sessions.delete(sha256Hex(token))
    },
    size: () => sessions.size
  }
}

const defaultStore = createSessionStore()

function loginLimiter() {
  // Brute-force brake on the passphrase. Rejected attempts never reach
  // the comparison, so guessing is both slow and blind.
  return createRateLimiter(rateLimitOptions('LOGIN', 10, 15 * 60 * 1000))
}

// Mounts POST /auth/login, POST /auth/logout, GET /auth/status and
// GET /auth/csrf on the given router. Safe to mount once.
export function mountDemoAuth(router, { store = defaultStore, env = process.env } = {}) {
  const loginRateLimit = loginLimiter()

  router.post('/auth/login', loginRateLimit, (req, res) => {
    if (!authConfigured(env)) {
      return res.status(503).json({
        error: 'Demo access is not configured on this server.',
        code: AUTH_NOT_CONFIGURED_CODE
      })
    }
    const presented = req.body && req.body.passphrase
    if (typeof presented !== 'string' || presented.length === 0) {
      return res.status(401).json({ error: 'Invalid demo passphrase.', code: AUTH_REQUIRED_CODE })
    }
    let ok = false
    try {
      ok = secretsEqual(presented, env.RECALLGUARD_DEMO_PASSPHRASE)
    } catch {
      ok = false
    }
    if (!ok) {
      // Generic message: identical shape for wrong and missing secrets.
      return res.status(401).json({ error: 'Invalid demo passphrase.', code: AUTH_REQUIRED_CODE })
    }
    const session = store.create()
    const secure = isProductionEnv(env)
    res.setHeader('Set-Cookie', buildSessionCookie(session.token, { secure }))
    // The CSRF token goes to page memory, never to storage: the client
    // keeps it in a module variable and sends it as a header.
    res.json({ authenticated: true, csrfToken: session.csrfToken })
  })

  router.post('/auth/logout', (req, res) => {
    const cookies = parseCookies(req.headers.cookie)
    store.destroy(cookies[SESSION_COOKIE])
    res.setHeader('Set-Cookie', clearSessionCookie({ secure: isProductionEnv(env) }))
    res.json({ authenticated: false })
  })

  router.get('/auth/status', (req, res) => {
    const cookies = parseCookies(req.headers.cookie)
    res.json({ authenticated: store.lookup(cookies[SESSION_COOKIE]) !== null })
  })

  // Fresh CSRF token for an already-authenticated page (e.g. after a
  // reload wiped the in-memory copy). Cookie-authenticated, read-only.
  router.get('/auth/csrf', (req, res) => {
    const cookies = parseCookies(req.headers.cookie)
    const session = store.lookup(cookies[SESSION_COOKIE])
    if (!session) {
      return res.status(401).json({ error: 'Demo access required.', code: AUTH_REQUIRED_CODE })
    }
    res.json({ csrfToken: session.csrfToken })
  })

  return router
}

// Protects spend-bearing / mutating routes. Reads stay public.
// - Passphrase unconfigured + development: pass through (local behavior).
// - Passphrase unconfigured + production: deny with 503 (fail closed).
// - No/invalid/expired session: 401.
// - Mutating methods (POST/PUT/PATCH/DELETE) with a valid session still
//   need the per-session CSRF header: 403 otherwise.
export function requireDemoAuth({ store = defaultStore, env = process.env } = {}) {
  return (req, res, next) => {
    if (!authConfigured(env)) {
      if (isProductionEnv(env)) {
        return res.status(503).json({
          error: 'Demo access is not configured on this server.',
          code: AUTH_NOT_CONFIGURED_CODE
        })
      }
      return next()
    }
    const cookies = parseCookies(req.headers.cookie)
    const session = store.lookup(cookies[SESSION_COOKIE])
    if (!session) {
      return res.status(401).json({ error: 'Demo access required.', code: AUTH_REQUIRED_CODE })
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const presented = req.headers[CSRF_HEADER]
      if (typeof presented !== 'string' || presented.length === 0) {
        return res.status(403).json({ error: 'Missing CSRF token.', code: CSRF_INVALID_CODE })
      }
      let ok = false
      try {
        ok = secretsEqual(presented, session.csrfToken)
      } catch {
        ok = false
      }
      if (!ok) {
        return res.status(403).json({ error: 'Invalid CSRF token.', code: CSRF_INVALID_CODE })
      }
    }
    next()
  }
}
