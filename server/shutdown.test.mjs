// Phase 6B: graceful shutdown orchestration. All closers are fakes; no
// sockets, databases, or processes are touched.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createShutdown } from './shutdown.mjs'

function track() {
  const events = []
  return {
    events,
    fn: (name, { hang = false } = {}) => async () => {
      events.push(`start:${name}`)
      if (hang) await new Promise(() => {})
      events.push(`end:${name}`)
    }
  }
}

describe('graceful shutdown', () => {
  it('closes in order: server, vite, checkpoint, stores', async () => {
    const t = track()
    let exited = null
    const { shutdown } = createShutdown({
      closeServer: t.fn('server'),
      closeVite: t.fn('vite'),
      checkpointStores: [t.fn('checkpoint')],
      closeStores: [t.fn('store')],
      logger: { log: () => {} },
      timeoutMs: 1000,
      exitFn: (code) => { exited = code }
    })
    await shutdown('SIGTERM')
    assert.deepEqual(t.events, [
      'start:server', 'end:server',
      'start:vite', 'end:vite',
      'start:checkpoint', 'end:checkpoint',
      'start:store', 'end:store'
    ])
    assert.equal(exited, 0)
  })

  it('runs exactly once across duplicate signals', async () => {
    let serverCloses = 0
    let storeCloses = 0
    const { shutdown } = createShutdown({
      closeServer: async () => { serverCloses += 1 },
      checkpointStores: [],
      closeStores: [async () => { storeCloses += 1 }],
      logger: { log: () => {} },
      timeoutMs: 1000,
      exitFn: null
    })
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT'), shutdown('SIGTERM')])
    assert.equal(serverCloses, 1)
    assert.equal(storeCloses, 1)
  })

  it('a hanging server close still checkpoints and closes stores', async () => {
    const t = track()
    const { shutdown } = createShutdown({
      closeServer: t.fn('server', { hang: true }),
      checkpointStores: [t.fn('checkpoint')],
      closeStores: [t.fn('store')],
      logger: { log: () => {} },
      timeoutMs: 50,
      exitFn: null
    })
    await shutdown('SIGTERM')
    assert.ok(t.events.includes('start:checkpoint'))
    assert.ok(t.events.includes('start:store'))
  })

  it('logs only operational messages and reports finished state', async () => {
    const lines = []
    const { shutdown, isStarted, isFinished } = createShutdown({
      closeServer: async () => {},
      checkpointStores: [],
      closeStores: [],
      logger: { log: (line) => lines.push(String(line)) },
      timeoutMs: 1000,
      exitFn: null
    })
    assert.equal(isStarted(), false)
    await shutdown('SIGINT')
    assert.equal(isStarted(), true)
    assert.equal(isFinished(), true)
    assert.ok(lines.length >= 2)
    assert.ok(lines.every((line) => !/key|secret|token|passphrase|\.db|\/tmp|\/data/i.test(line)))
  })

  it('works without vite (production has no vite instance)', async () => {
    const closed = []
    const { shutdown } = createShutdown({
      closeServer: async () => { closed.push('server') },
      closeVite: null,
      checkpointStores: [],
      closeStores: [async () => { closed.push('store') }],
      logger: { log: () => {} },
      timeoutMs: 1000,
      exitFn: null
    })
    await shutdown('SIGTERM')
    assert.deepEqual(closed, ['server', 'store'])
  })
})
