// Phase 4 Step 3 integration tests: POST /sessions with Meta AI.
// An express app mounts the real router against a scratch database.
// Global fetch is stubbed: api.meta.ai traffic is answered from a queue,
// localhost traffic passes through, everything else (Walrus) fails closed
// so the deterministic Walrus-failure path is exercised for free.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

const BASE = `/tmp/rg-ai-route-test-${process.pid}`
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
// Localhost test traffic must bypass the sandbox egress proxy.
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const {
  default: router,
  resolveAiAnalysis,
  getPersistenceStore,
  AI_PROMPT_VERSION,
  WALRUS_PUBLISH_SKIPPED_MESSAGE
} = await import('./routes/recallguard.mjs')

function analysisJson() {
  return {
    subQuestions: ['What checkpoint is latest?'],
    interpretation: 'The checkpoint advanced.',
    contradictions: [],
    uncertainties: ['Whether a newer checkpoint exists.'],
    evidenceGaps: [],
    confidenceNote: 'Based only on the supplied evidence.'
  }
}

function metaCompletion() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ choices: [{ message: { content: JSON.stringify(analysisJson()) } }] }),
    text: async () => 'unused'
  }
}

function metaFailure(status) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => `http ${status}`
  }
}

let metaQueue = []
let qwenQueue = []
let metaCalls = 0
let externalHosts = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('127.0.0.1')) return realFetch(url, init)
  try {
    externalHosts.push(new URL(target).hostname)
  } catch { /* ignore */ }
  if (target.includes('api.meta.ai')) {
    metaCalls += 1
    const next = metaQueue.shift()
    if (next instanceof Error) throw next
    return next
  }
  if (target.includes('dashscope.test')) {
    const next = qwenQueue.shift()
    if (next instanceof Error) throw next
    return next
  }
  throw new Error('network unreachable in tests')
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

async function postSession(question, extra = {}) {
  const res = await realFetch(`${baseUrl}/api/recallguard/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, ...extra })
  })
  return { status: res.status, body: await res.json() }
}

function qwenCompletion() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ choices: [{ message: { content: JSON.stringify(analysisJson()) } }] }),
    text: async () => 'unused'
  }
}

async function getJson(path) {
  const res = await realFetch(`${baseUrl}/api/recallguard${path}`)
  return { status: res.status, body: await res.json() }
}

const QUESTION = 'What is the latest Sui checkpoint?'

// IDs of sessions created by the controls suite (which runs before the
// Meta AI suite: the final Meta AI test leaves the store unhealthy).
const controlSessionIds = []

function resetExternalTracking() {
  metaCalls = 0
  externalHosts = []
  metaQueue = []
  qwenQueue = []
}

function useQwenStub() {
  process.env.DASHSCOPE_API_KEY = 'test-qwen-key'
  process.env.QWEN_API_BASE = 'https://dashscope.test/compatible-mode/v1'
}

function clearQwenStub() {
  delete process.env.DASHSCOPE_API_KEY
  delete process.env.QWEN_API_BASE
}

describe('POST /sessions test controls (noFallback, skipWalrus)', () => {
  it('A. default request keeps the full workflow: Meta fallback, Walrus attempt', async () => {
    process.env.META_API_KEY = 'test-meta-key'
    clearQwenStub()
    resetExternalTracking()
    metaQueue = [metaCompletion()]
    const { status, body } = await postSession('Default workflow check?')
    assert.equal(status, 201)
    assert.equal(body.aiStatus, 'completed')
    assert.equal(body.aiProvider, 'meta')
    assert.equal(body.aiFallbackUsed, true)
    assert.equal(body.aiFallbackDisabled, false)
    assert.equal(metaCalls, 1)
    // Walrus was attempted (and failed closed in tests): the skip message
    // must not appear, and no memory was stored.
    assert.notEqual(body.walrusStoreError, WALRUS_PUBLISH_SKIPPED_MESSAGE)
    assert.equal(body.storedMemory, null)
    delete process.env.META_API_KEY
  })

  it('B. noFallback with Qwen success never contacts Meta', async () => {
    delete process.env.META_API_KEY
    useQwenStub()
    resetExternalTracking()
    qwenQueue = [qwenCompletion()]
    const { status, body } = await postSession('Qwen-only success?', { noFallback: true })
    assert.equal(status, 201)
    assert.equal(body.aiStatus, 'completed')
    assert.equal(body.aiProvider, 'qwen')
    assert.equal(body.aiAnalysis.model, 'qwen3.8-flash')
    assert.equal(body.aiFallbackUsed, false)
    assert.equal(body.aiFallbackDisabled, true)
    assert.equal(metaCalls, 0)
    assert.deepEqual(metaQueue, [])
    const rows = getPersistenceStore().listAiAnalysisBySession(body.session.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].provider, 'qwen')
    controlSessionIds.push(body.session.id)
    clearQwenStub()
  })

  it('B. noFallback with Qwen failure reports honestly without Meta', async () => {
    delete process.env.META_API_KEY
    clearQwenStub()
    resetExternalTracking()
    const { status, body } = await postSession('Qwen-only failure?', { noFallback: true })
    assert.equal(status, 201)
    assert.equal(body.aiStatus, 'unavailable')
    assert.equal(body.aiAnalysis, null)
    assert.equal(body.aiProvider, null)
    assert.equal(body.aiFallbackUsed, false)
    assert.equal(body.aiFallbackDisabled, true)
    assert.equal(metaCalls, 0)
    // Deterministic session persisted despite the AI failure.
    assert.ok(body.session.id.startsWith('SES-LIVE-'))
    const rows = getPersistenceStore().listAiAnalysisBySession(body.session.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].provider, 'unavailable')
    controlSessionIds.push(body.session.id)
  })

  it('C. skipWalrus contacts no Walrus host and stores no memory', async () => {
    process.env.META_API_KEY = 'test-meta-key'
    clearQwenStub()
    resetExternalTracking()
    metaQueue = [metaCompletion()]
    const memoriesBefore = (await getJson('/memories')).body.length
    const { status, body } = await postSession('Skip Walrus?', { skipWalrus: true })
    assert.equal(status, 201)
    assert.equal(body.walrusStoreResult, null)
    assert.equal(body.storedMemory, null)
    assert.equal(body.walrusStoreError, WALRUS_PUBLISH_SKIPPED_MESSAGE)
    assert.ok(!externalHosts.some((host) => host.includes('walrus')))
    const memoriesAfter = (await getJson('/memories')).body.length
    assert.equal(memoriesAfter, memoriesBefore)
    // Session, AI analysis, and audit persistence are unaffected.
    assert.equal(body.aiStatus, 'completed')
    assert.equal(body.aiProvider, 'meta')
    const rows = getPersistenceStore().listAiAnalysisBySession(body.session.id)
    assert.equal(rows.length, 1)
    controlSessionIds.push(body.session.id)
    delete process.env.META_API_KEY
  })

  it('D. both flags with Qwen success: no Meta, no Walrus, full persistence', async () => {
    delete process.env.META_API_KEY
    useQwenStub()
    resetExternalTracking()
    qwenQueue = [qwenCompletion()]
    const { status, body } = await postSession('Both flags success?', { noFallback: true, skipWalrus: true })
    assert.equal(status, 201)
    assert.equal(body.aiStatus, 'completed')
    assert.equal(body.aiProvider, 'qwen')
    assert.equal(body.aiFallbackUsed, false)
    assert.equal(body.aiFallbackDisabled, true)
    assert.equal(metaCalls, 0)
    assert.equal(body.walrusStoreError, WALRUS_PUBLISH_SKIPPED_MESSAGE)
    assert.ok(!externalHosts.some((host) => host.includes('walrus')))
    const detail = await getJson(`/sessions/${body.session.id}`)
    assert.equal(detail.body.aiProvider, 'qwen')
    assert.equal(detail.body.aiFallbackUsed, false)
    assert.equal(detail.body.aiFallbackDisabled, true)
    controlSessionIds.push(body.session.id)
    clearQwenStub()
  })

  it('D. both flags with Qwen failure: session and audit still correct', async () => {
    delete process.env.META_API_KEY
    clearQwenStub()
    resetExternalTracking()
    const { status, body } = await postSession('Both flags failure?', { noFallback: true, skipWalrus: true })
    assert.equal(status, 201)
    assert.equal(body.aiStatus, 'unavailable')
    assert.equal(metaCalls, 0)
    assert.equal(body.walrusStoreError, WALRUS_PUBLISH_SKIPPED_MESSAGE)
    const audits = getPersistenceStore().listAudit(1000)
      .filter((row) => row.entity_id === `AI-${body.session.id}`)
    assert.equal(audits.length, 1)
    const details = JSON.parse(audits[0].details_json)
    assert.equal(details.fallbackUsed, false)
    assert.equal(details.fallbackDisabled, true)
    assert.equal(details.meta, null)
    controlSessionIds.push(body.session.id)
  })

  it('E. rejects non-boolean flag types', async () => {
    for (const bad of ['true', 1, 0, null, {}, []]) {
      const r1 = await postSession('Bad noFallback?', { noFallback: bad })
      assert.equal(r1.status, 400)
      assert.equal(r1.body.error, 'noFallback must be a boolean')
      const r2 = await postSession('Bad skipWalrus?', { skipWalrus: bad })
      assert.equal(r2.status, 400)
      assert.equal(r2.body.error, 'skipWalrus must be a boolean')
    }
    // Explicit false behaves exactly like omission.
    process.env.META_API_KEY = 'test-meta-key'
    clearQwenStub()
    resetExternalTracking()
    metaQueue = [metaCompletion()]
    const { status, body } = await postSession('Explicit false?', { noFallback: false, skipWalrus: false })
    assert.equal(status, 201)
    assert.equal(body.aiProvider, 'meta')
    assert.equal(body.aiFallbackUsed, true)
    assert.notEqual(body.walrusStoreError, WALRUS_PUBLISH_SKIPPED_MESSAGE)
    controlSessionIds.push(body.session.id)
    delete process.env.META_API_KEY
  })

  it('F. flagged and normal sessions stay listed and readable', async () => {
    assert.ok(controlSessionIds.length >= 6)
    const list = await getJson('/sessions')
    for (const id of controlSessionIds) {
      assert.ok(list.body.some((row) => row.id === id))
      const detail = await getJson(`/sessions/${id}`)
      assert.equal(detail.status, 200)
      assert.equal(detail.body.id, id)
    }
    for (const row of list.body) {
      const detail = await getJson(`/sessions/${row.id}`)
      assert.equal(detail.status, 200)
      assert.equal(detail.body.id, row.id)
    }
    const memories = await getJson('/memories')
    assert.ok(Array.isArray(memories.body))
  })
})

describe('POST /sessions with Meta AI', () => {
  it('returns a deterministic session plus completed AI analysis', async () => {
    process.env.META_API_KEY = 'test-meta-key'
    metaQueue = [metaCompletion()]
    const { status, body } = await postSession(QUESTION)
    assert.equal(status, 201)
    // Deterministic core intact (Walrus unreachable in tests, session kept).
    assert.ok(body.session.id.startsWith('SES-LIVE-'))
    assert.equal(body.session.question, QUESTION)
    assert.ok(body.evidenceComparison)
    assert.equal(body.liveDecision, null)
    assert.equal(body.revisionCandidate, null)
    assert.equal(body.walrusStoreResult, null)
    assert.ok(typeof body.walrusStoreError === 'string')
    // AI additive fields.
    assert.equal(body.aiStatus, 'completed')
    assert.equal(body.aiErrorCode, null)
    assert.equal(body.aiAnalysis.model, 'muse-spark-1.3')
    assert.equal(body.aiAnalysis.provider, 'meta')
    assert.equal(body.aiAnalysis.interpretation, 'The checkpoint advanced.')
    // Analysis persisted and linked to the session.
    const rows = getPersistenceStore().listAiAnalysisBySession(body.session.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].promptVersion, AI_PROMPT_VERSION)
    assert.equal(rows[0].status, 'completed')
    assert.equal(rows[0].analysis.interpretation, 'The checkpoint advanced.')
  })

  it('keeps deterministic verification identical with and without AI', async () => {
    process.env.META_API_KEY = 'test-meta-key'
    metaQueue = [metaCompletion()]
    const withAi = await postSession('What is the Sui chain identifier for mainnet?')
    delete process.env.META_API_KEY
    const withoutAi = await postSession('What is the Sui chain identifier for mainnet?')
    assert.equal(withAi.status, 201)
    assert.equal(withoutAi.status, 201)
    assert.equal(withAi.body.aiStatus, 'completed')
    assert.equal(withoutAi.body.aiStatus, 'unavailable')
    assert.deepEqual(withAi.body.evidenceComparison, withoutAi.body.evidenceComparison)
    assert.equal(withAi.body.revisionCandidate, null)
    assert.equal(withoutAi.body.revisionCandidate, null)
    assert.equal(withAi.body.liveDecision, null)
    const decisions = await getJson('/decisions')
    assert.ok(decisions.body.every((d) => !String(d.id).startsWith('DEC-LIVE-')))
  })

  it('reports and audits unavailable when no key is configured', async () => {
    delete process.env.META_API_KEY
    metaQueue = []
    const { status, body } = await postSession('What is the latest Sui checkpoint?')
    assert.equal(status, 201)
    assert.equal(body.aiStatus, 'unavailable')
    assert.equal(body.aiAnalysis, null)
    assert.equal(body.aiErrorCode, 'QWEN_AI_UNAVAILABLE')
    // The unrun attempt is audited: model unknown, no analysis content.
    // Neither provider ran, so none is named: the primary (Qwen) code and
    // the explicit 'unavailable' provider replace the old Meta default.
    const rows = getPersistenceStore().listAiAnalysisBySession(body.session.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'unavailable')
    assert.equal(rows[0].model, 'unknown')
    assert.equal(rows[0].provider, 'unavailable')
    assert.equal(rows[0].promptVersion, AI_PROMPT_VERSION)
    assert.equal(rows[0].analysis, null)
    assert.equal(rows[0].errorCode, 'QWEN_AI_UNAVAILABLE')
  })

  it('reports and audits invalid on 401 without retrying', async () => {
    process.env.META_API_KEY = 'revoked-key'
    metaQueue = [
      { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}), text: async () => 'SENSITIVE-401 revoked-key-material' },
      { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}), text: async () => 'SENSITIVE-401 revoked-key-material' }
    ]
    const { status, body } = await postSession('What is the latest Sui checkpoint?')
    assert.equal(status, 201)
    assert.equal(body.aiStatus, 'invalid')
    assert.equal(body.aiAnalysis, null)
    assert.equal(body.aiErrorCode, 'META_AI_INVALID')
    assert.ok(body.session.id.startsWith('SES-LIVE-'))
    // The failed attempt is audited with the stable code only: no raw
    // provider body, no credentials, no request content.
    const rows = getPersistenceStore().listAiAnalysisBySession(body.session.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'invalid')
    assert.equal(rows[0].model, 'muse-spark-1.3')
    assert.equal(rows[0].analysis, null)
    assert.equal(rows[0].errorCode, 'META_AI_INVALID')
    const serialized = JSON.stringify(rows[0])
    assert.ok(!serialized.includes('SENSITIVE-401'))
    assert.ok(!serialized.includes('revoked-key-material'))
    assert.ok(!serialized.includes('revoked-key'))
  })

  it('reports and audits unavailable on repeated provider failure', async () => {
    process.env.META_API_KEY = 'test-meta-key'
    metaQueue = [metaFailure(500), metaFailure(500), metaFailure(500)]
    const { status, body } = await postSession('What is the latest Sui checkpoint?')
    assert.equal(status, 201)
    assert.equal(body.aiStatus, 'unavailable')
    assert.equal(body.aiAnalysis, null)
    assert.equal(body.session.question, 'What is the latest Sui checkpoint?')
    const rows = getPersistenceStore().listAiAnalysisBySession(body.session.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'unavailable')
    assert.equal(rows[0].model, 'muse-spark-1.3')
    assert.equal(rows[0].analysis, null)
    assert.equal(rows[0].errorCode, 'META_AI_UNAVAILABLE')
  })

  it('maps analysis persistence failure to persistence_failed', async () => {
    const fakeStore = { persistAiAnalysis: () => false }
    const okResult = {
      ok: true,
      aiStatus: 'completed',
      errorCode: null,
      latencyMs: 5,
      analysis: { ...analysisJson(), model: 'muse-spark-1.3', provider: 'meta' }
    }
    const out = await resolveAiAnalysis(
      { id: 'SES-UNIT-1', question: 'q?', onChainSuiData: null },
      [],
      { analyzeFn: async () => okResult, store: fakeStore }
    )
    assert.equal(out.aiStatus, 'persistence_failed')
    assert.equal(out.aiAnalysis, null)
    assert.equal(out.aiErrorCode, 'PERSISTENCE_UNAVAILABLE')
  })

  it('distinguishes provider failure from database persistence failure', async () => {
    const session = { id: 'SES-UNIT-D', question: 'q?', onChainSuiData: null }
    const okResult = {
      ok: true, aiStatus: 'completed', errorCode: null, latencyMs: 5,
      analysis: { ...analysisJson(), model: 'muse-spark-1.3', provider: 'meta' }
    }
    // Provider failure: Meta-named code, unavailable status.
    const providerFailed = await resolveAiAnalysis(session, [], {
      analyzeFn: async () => ({ ok: false, aiStatus: 'unavailable', errorCode: 'META_AI_UNAVAILABLE', analysis: null }),
      store: { persistAiAnalysis: () => true }
    })
    assert.equal(providerFailed.aiStatus, 'unavailable')
    assert.equal(providerFailed.aiErrorCode, 'META_AI_UNAVAILABLE')
    // Database failure: SQLite-named code, persistence_failed status.
    const persistFailed = await resolveAiAnalysis(session, [], {
      analyzeFn: async () => okResult,
      store: { persistAiAnalysis: () => false }
    })
    assert.equal(persistFailed.aiStatus, 'persistence_failed')
    assert.equal(persistFailed.aiErrorCode, 'PERSISTENCE_UNAVAILABLE')
    assert.notEqual(providerFailed.aiErrorCode, persistFailed.aiErrorCode)
    assert.notEqual(providerFailed.aiStatus, persistFailed.aiStatus)
  })

  it('reports persistence_failed when the failure audit itself cannot be stored', async () => {
    const session = { id: 'SES-UNIT-F', question: 'q?', onChainSuiData: null }
    const out = await resolveAiAnalysis(session, [], {
      analyzeFn: async () => ({ ok: false, aiStatus: 'unavailable', errorCode: 'META_AI_UNAVAILABLE', analysis: null }),
      store: { persistAiAnalysis: () => false }
    })
    assert.equal(out.aiStatus, 'persistence_failed')
    assert.equal(out.aiAnalysis, null)
    assert.equal(out.aiErrorCode, 'PERSISTENCE_UNAVAILABLE')
  })

  it('maps invalid, thrown, and malformed AI results to safe statuses', async () => {
    const session = { id: 'SES-UNIT-2', question: 'q?', onChainSuiData: null }
    const store = { persistAiAnalysis: () => true }
    const invalid = await resolveAiAnalysis(session, [], {
      analyzeFn: async () => ({ ok: false, aiStatus: 'invalid', errorCode: 'META_AI_INVALID', analysis: null }),
      store
    })
    assert.deepEqual(invalid, { aiStatus: 'invalid', aiAnalysis: null, aiErrorCode: 'META_AI_INVALID', aiProvider: 'meta', aiFallbackUsed: false, aiFallbackDisabled: false })
    const thrown = await resolveAiAnalysis(session, [], {
      analyzeFn: async () => { throw new Error('boom') },
      store
    })
    assert.deepEqual(thrown, { aiStatus: 'unavailable', aiAnalysis: null, aiErrorCode: 'META_AI_UNAVAILABLE', aiProvider: 'meta', aiFallbackUsed: false, aiFallbackDisabled: false })
    const malformed = await resolveAiAnalysis(session, [], {
      analyzeFn: async () => ({ ok: true, analysis: null }),
      store
    })
    assert.deepEqual(malformed, { aiStatus: 'unavailable', aiAnalysis: null, aiErrorCode: 'META_AI_UNAVAILABLE', aiProvider: 'meta', aiFallbackUsed: false, aiFallbackDisabled: false })
  })

  it('builds the AI prompt from session evidence only', async () => {
    let seen = null
    const store = { persistAiAnalysis: () => true }
    await resolveAiAnalysis(
      {
        id: 'SES-UNIT-3', question: 'Latest checkpoint?',
        researchPlan: { capability: 'sui_checkpoint_status' },
        onChainSuiData: { network: 'sui-mainnet', checkpointSequence: '105' },
        evidenceComparison: { status: 'newer_observation' }
      },
      [{ id: 'MEM-1', title: 't', provenance: 'live_production', content: 'SECRET', storageVerified: true }],
      { analyzeFn: async (input) => { seen = input; return { ok: false, aiStatus: 'unavailable', errorCode: 'x', analysis: null } }, store }
    )
    assert.equal(seen.question, 'Latest checkpoint?')
    assert.equal(seen.capability, 'sui_checkpoint_status')
    assert.equal(seen.onChainSuiData.checkpointSequence, '105')
    assert.equal(seen.evidenceComparison.status, 'newer_observation')
    // Full memory objects travel in-process to the client; the Meta client
    // strips them to id/title/provenance when building the HTTP body
    // (covered by the client suite's evidence-only prompt test).
    assert.deepEqual(seen.recalledMemories, [
      { id: 'MEM-1', title: 't', provenance: 'live_production', content: 'SECRET', storageVerified: true }
    ])
  })

  it('returns sanitized persistence errors when session persistence fails', async () => {
    const before = await getJson('/sessions')
    getPersistenceStore().markUnhealthy('test-induced failure')
    const { status, body } = await postSession('Will this persist?')
    assert.equal(status, 500)
    assert.equal(body.error, 'Failed to persist research session')
    assert.equal(body.code, 'PERSISTENCE_UNAVAILABLE')
    assert.ok(!('details' in body))
    const after = await getJson('/sessions')
    assert.equal(after.body.length, before.body.length)
  })
})
