// Environment-aware startup resolution (Phase 6B).
//
// Development (NODE_ENV anything but 'production'):
// - loopback-only binding, preserving the existing local workflow.
// Production (NODE_ENV=production, e.g. Railway):
// - binds all interfaces and uses the platform-provided PORT.
// - never falls back to a hardcoded port: a missing/invalid PORT throws
//   instead of silently listening somewhere unexpected.
export function isProduction(env = process.env) {
  return env.NODE_ENV === 'production'
}

export const PRODUCTION_PORT_REQUIRED = 'PRODUCTION_PORT_REQUIRED'

function devPort(env) {
  const raw = env.PORT ?? 3000
  const port = Number.parseInt(raw, 10)
  return Number.isInteger(port) && port > 0 ? port : 3000
}

export function resolveBind(env = process.env) {
  if (isProduction(env)) {
    const port = Number.parseInt(env.PORT, 10)
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(
        `${PRODUCTION_PORT_REQUIRED}: NODE_ENV=production requires a valid PORT from the platform.`
      )
    }
    return { host: '0.0.0.0', port, isProd: true }
  }
  return { host: '127.0.0.1', port: devPort(env), isProd: false }
}
