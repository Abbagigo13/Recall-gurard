// Step 02 demo hardening tests: loopback bind, rate limits, diagnostics
// switch. Scratch DB only; Meta/Walrus HTTP mocked, Tatum gRPC injected,
// everything else fails closed. No real external calls.
import { describe, it, before, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { readFileSync } from 'node:fs'

const BASE = `/tmp/rg-security-test-${process.pid}`
const DB_PATH = `${BASE}/recallguard.db`

const savedEnv = {}
for (const key of ['RECALLGUARD_DB_PATH', 'TATUM_API_KEY', 'META_API_KEY', 'META_MODEL', 'META_API_BASE', 'RECALLGUARD_ENABLE_DIAGNOSTICS', 'RECALLGUARD_RATE_LIMIT_SESSIONS_MAX', 'RECALLGUARD_RATE_LIMIT_MEMORIES_MAX', 'RECALLGUARD_RATE_LIMIT_DIAGNOSTICS_MAX', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']) {
  savedEnv[key] = process.env[key]
}
process.env.RECALLGUARD_DB_PATH = DB_PATH
// Low limits so 429s trigger fast; production defaults stay generous.
process.env.RECALLGUARD_RATE_LIMIT_SESSIONS_MAX = '3'
process.env.RECALLGUARD_RATE_LIMIT_MEMORIES_MAX = '3'
process.env.RECALLGUARD_RATE_LIMIT_DIAGNOSTICS_MAX = '3'
delete process.env.TATUM_API_KEY
delete process.env.META_API_KEY
delete process.env.RECALLGUARD_ENABLE_DIAGNOSTICS
delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.ALL_PROXY
delete process.env.http_proxy
delete process.env.https_proxy
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

// External-call counters: any increment past the allowed requests proves a leak.
let tatumCalls = 0
let metaCalls = 0
let walrusPuts = 0

function tatumFixture() {
  const retrievedAt = new Date().toISOString()
  return {
    network: 'mainnet',
    provider: 'Tatum Sui gRPC',
    serviceInfo: { epoch: '424242', checkpointHeight: '42424242' },
    checkpoint: { sequenceNumber: '42424242', checkpoint: { digest: 'SYNTHETIC' }, retrievedAt },
    status: 'connected',
    retrievedAt
  }
}

const {
  default: router,
  setSuiGrpcClient
} = await import('./routes/recallguard.mjs')

const fakeSuiGrpcClient = {
  getSuiNetworkStatus: async () => { tatumCalls += 1; return tatumFixture() },
  getSuiServiceInfo: async () => { tatumCalls += 1; return tatumFixture().serviceInfo },
  getSuiCheckpoint: async () => { tatumCalls += 1; return tatumFixture().checkpoint },
  getSuiObject: async () => { tatumCalls += 1; return { digest: 'SYNTHETIC' } }
}

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
    metaCalls += 1
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content: JSON.stringify(validAnalysis()) } }] }),
      text: async () => 'unused'
    }
  }
  if (target.includes('publisher.walrus-testnet.walrus.space')) {
    walrusPuts += 1
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ newlyCreated: { blobObject: { blobId: `sec-blob-${walrusPuts}`, id: '0xsec', registeredEpoch: 1 }, cost: {} } }),
      text: async () => 'unused'
    }
  }
  if (target.includes('aggregator.walrus-testnet.walrus.space')) {
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => 'unused' }
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

beforeEach(() => {
  setSuiGrpcClient(fakeSuiGrpcClient)
})

afterEach(() => {
  setSuiGrpcClient(null)
})

after(async () => {
  await new Promise((resolve) => { server.close(resolve) })
  globalThis.fetch = realFetch
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

async function postSession() {
  const res = await realFetch(`${baseUrl}/api/recallguard/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'What is the latest Sui checkpoint status on mainnet?' })
  })
  return { status: res.status, body: await res.json() }
}

async function postMemory(n) {
  const res = await realFetch(`${baseUrl}/api/recallguard/memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `Security probe ${n}`, content: 'Synthetic rate-limit probe content.' })
  })
  return { status: res.status, body: await res.json() }
}

async function getJson(path) {
  const res = await realFetch(`${baseUrl}/api/recallguard${path}`)
  return { status: res.status, body: await res.json() }
}

describe('demo hardening', () => {
  it('binds through the environment-aware helper with no wildcard in the entry point', () => {
    // Phase 6B: development stays loopback-only while production binds the
    // platform interface. The contract lives in startup.mjs (covered by
    // production.test.mjs); the entry point must not hardcode either side.
    const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8')
    assert.ok(!source.includes('0.0.0.0'), 'must never hardcode an externally reachable interface')
    assert.ok(!source.includes('127.0.0.1'), 'must not hardcode the loopback interface either')
    assert.match(source, /resolveBind\(\)/, 'binding must resolve through the environment-aware helper')
  })

  it('rate-limits sessions and makes zero external calls when blocked', async () => {
    const first = [await postSession(), await postSession(), await postSession()]
    assert.ok(first.every((r) => r.status === 201))
    // Read-back mock returns mismatched bytes, so storage is unverified;
    // sessions still persist — only the rate-limit outcome matters here.
    const before = { tatumCalls, metaCalls, walrusPuts }
    const blocked = await postSession()
    assert.equal(blocked.status, 429)
    assert.equal(blocked.body.code, 'RATE_LIMIT_EXCEEDED')
    assert.deepEqual({ tatumCalls, metaCalls, walrusPuts }, before)
  })

  it('rate-limits memory publishes and makes zero publisher calls when blocked', async () => {
    const first = [await postMemory(1), await postMemory(2), await postMemory(3)]
    assert.ok(first.every((r) => r.status === 201))
    const putsBefore = walrusPuts
    const blocked = await postMemory(4)
    assert.equal(blocked.status, 429)
    assert.equal(blocked.body.code, 'RATE_LIMIT_EXCEEDED')
    assert.equal(walrusPuts, putsBefore)
  })

  it('disables diagnostics by default with zero external calls', async () => {
    const before = { tatumCalls, metaCalls, walrusPuts }
    const { status, body } = await getJson('/sui/diagnostics')
    assert.equal(status, 200)
    assert.equal(body.enabled, false)
    assert.equal(body.status, 'disabled')
    assert.equal(body.code, 'DIAGNOSTICS_DISABLED')
    assert.deepEqual({ tatumCalls, metaCalls, walrusPuts }, before)
    // The limiter still applies to the disabled endpoint.
    await getJson('/sui/diagnostics')
    await getJson('/sui/diagnostics')
    const blocked = await getJson('/sui/diagnostics')
    assert.equal(blocked.status, 429)
    assert.equal(blocked.body.code, 'RATE_LIMIT_EXCEEDED')
    assert.deepEqual({ tatumCalls, metaCalls, walrusPuts }, before)
  })

  it('leaves health and ordinary dashboard reads unblocked', async () => {
    // No Tatum key in this process, so health performs no external calls.
    for (const path of ['/health', '/metrics', '/sessions', '/memories', '/config-status', '/decisions', '/timeline']) {
      const { status } = await getJson(path)
      assert.equal(status, 200, `expected 200 for ${path}`)
    }
  })
})
