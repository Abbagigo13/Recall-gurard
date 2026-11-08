// Bounded graceful shutdown (Phase 6B).
//
// Order: stop accepting new requests -> let in-flight requests finish
// (bounded) -> close Vite (dev only) -> checkpoint SQLite -> close SQLite
// exactly once. Duplicate signals and duplicate calls are no-ops after the
// first run starts. Only safe operational messages are logged: no secrets,
// paths, or raw driver errors.
export const SHUTDOWN_TIMEOUT_MS = 10_000

export function createShutdown({
  closeServer,
  closeVite = null,
  checkpointStores = [],
  closeStores = [],
  logger = console,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
  exitFn = null
} = {}) {
  let started = false
  let finished = false

  async function shutdown(signal) {
    if (started) return
    started = true
    logger.log(`[recallguard] shutdown started (${signal})`)

    const bounded = (promise) =>
      Promise.race([
        promise.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, timeoutMs))
      ])

    // 1. Stop accepting new connections; in-flight requests get a bounded
    // window via the same timeout.
    try {
      await bounded(
        new Promise((resolve) => {
          let done = false
          const finish = () => {
            if (!done) {
              done = true
              resolve()
            }
          }
          try {
            const result = closeServer(finish)
            // Support promisified closers too.
            if (result && typeof result.then === 'function') result.then(finish, finish)
          } catch {
            finish()
          }
        })
      )
    } catch {
      // fall through: shutdown must keep moving
    }

    // 2. Dev Vite server, if any.
    if (typeof closeVite === 'function') {
      try {
        await bounded(Promise.resolve().then(closeVite))
      } catch {
        // ignore: still must checkpoint and close storage
      }
    }

    // 3. Checkpoint SQLite (WAL -> main image) before closing, so a
    // restart never depends on replaying a sidecar file.
    for (const checkpoint of checkpointStores) {
      try {
        await bounded(Promise.resolve().then(checkpoint))
      } catch {
        // ignore: close must still run
      }
    }

    // 4. Close each store exactly once (guarded here even if a store's own
    // close is not idempotent).
    for (const close of closeStores) {
      try {
        await bounded(Promise.resolve().then(close))
      } catch {
        // ignore
      }
    }

    finished = true
    logger.log('[recallguard] shutdown complete')
    if (typeof exitFn === 'function') exitFn(0)
  }

  function install() {
    const onSignal = (signal) => {
      shutdown(signal).catch(() => {})
    }
    process.once('SIGTERM', () => onSignal('SIGTERM'))
    process.once('SIGINT', () => onSignal('SIGINT'))
    return shutdown
  }

  return {
    shutdown,
    install,
    isStarted: () => started,
    isFinished: () => finished
  }
}
