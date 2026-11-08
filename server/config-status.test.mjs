// Phase 4 Step 6: config-status Meta visibility tests. Local configuration
// check only: global fetch fails closed so any Meta network request would
// fail the test. No real credentials are used.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

const BASE = `/tmp/rg-config-status-test-${process.pid}`
const DB_PATH = `${BASE}/recallguard.db`

const savedEnv = {}
for (const key of ['RECALLGUARD_DB_PATH', 'TATUM_API_KEY', 'META_API_KEY', 'META_MODEL', 'META_API_BASE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']) {
  savedEnv[key] = process.env[key]
}
process.env.RECALLGUARD_DB_PATH = DB_PATH
delete process.env.TATUM_API_KEY
delete process.env.META_API_KEY
delete process.env.META_MODEL
delete process.env.META_API_BASE
delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.ALL_PROXY
delete process.env.http_proxy
delete process.env.https_proxy
// Localhost test traffic must bypass the sandbox egress proxy.
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const { default: router } = await import('./routes/recallguard.mjs')
const { META_API_BASE_DEFAULT, META_MODEL_DEFAULT } = await import('./meta-ai.mjs')

const realFetch = globalThis.fetch
globalThis.fetch = async () => {
  throw new Error('network request forbidden in config-status tests')
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

async function getConfigStatus() {
  const res = await realFetch(`${baseUrl}/api/recallguard/config-status`)
  return { status: res.status, body: await res.json() }
}

describe('GET /config-status meta visibility', () => {
  it('reports configured when the Meta key is set', async () => {
    process.env.META_API_KEY = 'test-meta-key-0123456789abcdef'
    delete process.env.META_MODEL
    delete process.env.META_API_BASE
    const { status, body } = await getConfigStatus()
    assert.equal(status, 200)
    assert.equal(body.meta.configured, true)
    assert.equal(body.meta.provider, 'meta')
    assert.equal(body.meta.status, 'configured')
  })

  it('reports missing_key when the Meta key is absent', async () => {
    delete process.env.META_API_KEY
    const { status, body } = await getConfigStatus()
    assert.equal(status, 200)
    assert.equal(body.meta.configured, false)
    assert.equal(body.meta.status, 'missing_key')
  })

  it('reports missing_key when the Meta key is empty', async () => {
    process.env.META_API_KEY = ''
    const { status, body } = await getConfigStatus()
    assert.equal(status, 200)
    assert.equal(body.meta.configured, false)
    assert.equal(body.meta.status, 'missing_key')
    delete process.env.META_API_KEY
  })

  it('reports the default model and base URL', async () => {
    process.env.META_API_KEY = 'test-meta-key-0123456789abcdef'
    delete process.env.META_MODEL
    delete process.env.META_API_BASE
    const { body } = await getConfigStatus()
    assert.equal(body.meta.model, META_MODEL_DEFAULT)
    assert.equal(body.meta.baseUrl, META_API_BASE_DEFAULT)
  })

  it('reports a custom model and base URL', async () => {
    process.env.META_API_KEY = 'test-meta-key-0123456789abcdef'
    process.env.META_MODEL = 'custom-model-9.9'
    process.env.META_API_BASE = 'https://custom.example/v2/'
    const { body } = await getConfigStatus()
    assert.equal(body.meta.model, 'custom-model-9.9')
    // Trailing slashes are normalized by the Meta client.
    assert.equal(body.meta.baseUrl, 'https://custom.example/v2')
    delete process.env.META_MODEL
    delete process.env.META_API_BASE
  })

  it('never contains the secret value', async () => {
    const secret = 'super-secret-meta-key-xyz-1234567890'
    process.env.META_API_KEY = secret
    const { body } = await getConfigStatus()
    const serialized = JSON.stringify(body)
    assert.ok(!serialized.includes(secret))
    delete process.env.META_API_KEY
  })

  it('leaves existing Tatum and Walrus fields unchanged', async () => {
    delete process.env.META_API_KEY
    delete process.env.TATUM_API_KEY
    const withoutKey = await getConfigStatus()
    assert.equal(withoutKey.body.hasTatumKey, false)
    process.env.TATUM_API_KEY = 'test-tatum-key'
    const withKey = await getConfigStatus()
    assert.equal(withKey.body.hasTatumKey, true)
    delete process.env.TATUM_API_KEY
    for (const body of [withoutKey.body, withKey.body]) {
      assert.equal(body.hasWalrusSdk, true)
      assert.equal(body.walrusPublisher, 'https://publisher.walrus-testnet.walrus.space')
      assert.equal(body.walrusAggregator, 'https://aggregator.walrus-testnet.walrus.space')
      assert.deepEqual(body.memwalAdapter, {
        pythonSdkPackage: 'memwal',
        version: '0.2.1-compatible',
        mode: 'live-walrus-http-bridge',
        storageEngine: 'Walrus RedStuff 2D Reed-Solomon'
      })
    }
  })
})
