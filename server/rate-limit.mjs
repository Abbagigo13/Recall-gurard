// Dependency-free fixed-window rate limiter for expensive endpoints.
//
// Demo safety without an auth system: bounds how often one client can
// trigger Tatum, Meta, or Walrus spend. Rejected requests are answered
// before any handler runs, so they can never touch external services.
// In-memory per-IP counters only; request bodies, secrets, and personal
// content are never logged here.
export const RATE_LIMIT_CODE = 'RATE_LIMIT_EXCEEDED'

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

// Test override hook: RECALLGUARD_RATE_LIMIT_<NAME>_MAX / _WINDOW_MS.
// Production uses the compiled-in defaults below.
export function rateLimitOptions(name, defaultMax, defaultWindowMs) {
  return {
    windowMs: positiveInt(process.env[`RECALLGUARD_RATE_LIMIT_${name}_WINDOW_MS`], defaultWindowMs),
    max: positiveInt(process.env[`RECALLGUARD_RATE_LIMIT_${name}_MAX`], defaultMax),
    code: RATE_LIMIT_CODE
  }
}

export function createRateLimiter({ windowMs, max, code = RATE_LIMIT_CODE }) {
  const hits = new Map()
  return (req, res, next) => {
    const now = Date.now()
    // Drop expired buckets on every check so the map stays bounded.
    for (const [key, entry] of hits) {
      if (now >= entry.resetAt) hits.delete(key)
    }
    const ip = String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 128)
    let entry = hits.get(ip)
    if (!entry) {
      entry = { count: 0, resetAt: now + windowMs }
      hits.set(ip, entry)
    }
    entry.count += 1
    if (entry.count > max) {
      res.status(429).json({
        error: 'Rate limit exceeded. Try again later.',
        code
      })
      return
    }
    next()
  }
}
