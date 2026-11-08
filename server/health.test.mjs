// Walrus aggregator health vocabulary tests. All HTTP is mocked; no live
// Walrus, Tatum, or Meta traffic leaves the process. Scratch DB only.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { classifyAggregatorProbeStatus, probeWalrusAggregator } from './walrus-storage.mjs'
import { walrusAggregatorStatusLabel } from '../src/statusLabels.ts'

const BASE = `/tmp/rg-health-test-${process.pid}`
const DB_PATH = `${BASE}/recallguard.db`

const savedEnv = {}
for (const key of ['RECALLGUARD_DB_PATH', 'TATUM_API_KEY', 'META_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']) {
  savedEnv[key] = process.env[key]
}
process.env.RECALLGUARD_DB_PATH = DB_PATH
delete process.env.TATUM_API_KEY
delete process.env.META_API_KEY
delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.ALL_PROXY
delete process.env.http_proxy
delete process.env.https_proxy
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const { default: router, getPersistenceStore } = await import('./routes/recallguard.mjs')

let putAttempts = 0
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('127.0.0.1')) return realFetch(url, init)
  if (target.includes('aggregator.walrus-testnet.walrus.space')) {
    return { ok: false, status: 400, headers: { get: () => null }, text: async () => 'bad request' }
  }
  if (target.includes('publisher.walrus-testnet.walrus.space')) {
    putAttempts += 1
    throw new Error('publisher must never be contacted by a health check')
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

describe('walrus aggregator health vocabulary', () => {
  it('maps HTTP 200 to probe_accepted', () => {
    assert.equal(classifyAggregatorProbeStatus(200), 'probe_accepted')
  })

  it('maps HTTP 404 to probe_accepted', () => {
    assert.equal(classifyAggregatorProbeStatus(404), 'probe_accepted')
  })

  it('maps HTTP 400 to probe_rejected', () => {
    assert.equal(classifyAggregatorProbeStatus(400), 'probe_rejected')
  })

  it('maps HTTP 403 to probe_rejected', () => {
    assert.equal(classifyAggregatorProbeStatus(403), 'probe_rejected')
  })

  it('maps HTTP 500 to service_error', () => {
    assert.equal(classifyAggregatorProbeStatus(500), 'service_error')
  })

  it('maps a network exception to unreachable without throwing', async () => {
    const result = await probeWalrusAggregator({
      fetchFn: async () => { throw new Error('connection refused') },
      aggregatorUrl: 'http://127.0.0.1:9'
    })
    assert.equal(result.status, 'unreachable')
    assert.ok(typeof result.latencyMs === 'number')
  })

  it('labels map correctly and never mark rejection as healthy', () => {
    assert.deepEqual(walrusAggregatorStatusLabel('probe_accepted'), { label: 'Accepted', tone: 'ok' })
    const rejected = walrusAggregatorStatusLabel('probe_rejected')
    assert.equal(rejected.tone, 'warn')
    assert.notEqual(rejected.tone, 'ok')
    assert.deepEqual(walrusAggregatorStatusLabel('service_error'), { label: 'Service error', tone: 'error' })
    assert.deepEqual(walrusAggregatorStatusLabel('unreachable'), { label: 'Unreachable', tone: 'error' })
    assert.deepEqual(walrusAggregatorStatusLabel(undefined), { label: 'Unknown', tone: 'unknown' })
  })

  it('health reports probe_rejected without publishing or writing', async () => {
    const store = getPersistenceStore()
    const before = {
      sessions: store.listSessions().length,
      audit: store.listAudit(1000).length,
      puts: putAttempts
    }
    const res = await realFetch(`${baseUrl}/api/recallguard/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.integrations.walrusMemory.aggregatorStatus, 'probe_rejected')
    assert.equal(body.integrations.walrusMemory.publisherStatus, 'not_checked')
    assert.equal(putAttempts, before.puts)
    assert.equal(store.listSessions().length, before.sessions)
    assert.equal(store.listAudit(1000).length, before.audit)
  })
})
