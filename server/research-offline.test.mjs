// Phase 4 Step 7B: offline end-to-end integration test for
// POST /api/recallguard/sessions. No real network traffic leaves the
// process: Meta/Walrus HTTP is answered from in-test handlers, the Tatum
// gRPC client is module-mocked (grpc-js never touches fetch), and any
// other external request fails closed. No real credentials are used.
import { describe, it, before, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

const BASE = `/tmp/rg-offline-test-${process.pid}`
const DB_PATH = `${BASE}/recallguard.db`

const savedEnv = {}
for (const key of ['RECALLGUARD_DB_PATH', 'TATUM_API_KEY', 'META_API_KEY', 'META_MODEL', 'META_API_BASE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']) {
  savedEnv[key] = process.env[key]
}
process.env.RECALLGUARD_DB_PATH = DB_PATH
// Presence-only fake keys: the gRPC client is mocked and the Meta key is
// only checked for presence, so these values never leave the process.
process.env.TATUM_API_KEY = 'offline-fake-tatum-key-0123456789abcdef'
process.env.META_API_KEY = 'offline-fake-meta-key-0123456789abcdef'
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

// Mutable scenario switches read by the mocks below.
const tatumMode = { fail: false }
const walrusMode = { failPublish: false }
const metaMode = { fail: false, customContent: null }
let publishCount = 0
let lastPublishedBody = null
// External-call counters: the detail endpoint must never move these.
let tatumCalls = 0
let metaCalls = 0

// Clearly labelled synthetic Tatum fixture. Values are fixed, impossible
// mainnet readings chosen so a live leak would be obvious.
function tatumFixture() {
  const retrievedAt = new Date().toISOString()
  return {
    network: 'mainnet',
    provider: 'Tatum Sui gRPC',
    serviceInfo: {
      epoch: '424242',
      checkpointHeight: '42424242',
      chainId: 'synthetic-offline'
    },
    checkpoint: {
      sequenceNumber: '42424242',
      checkpoint: { digest: 'SYNTHETIC-OFFLINE-DIGEST' },
      retrievedAt
    },
    status: 'connected',
    retrievedAt
  }
}

// The Tatum client speaks gRPC, not fetch: inject a fake through the
// route's client seam, never a socket.
const {
  default: router,
  getPersistenceStore,
  setSuiGrpcClient
} = await import('./routes/recallguard.mjs')

const fakeSuiGrpcClient = {
  getSuiNetworkStatus: async (network) => {
    tatumCalls += 1
    if (tatumMode.fail) throw new Error('synthetic gRPC unavailable')
    return tatumFixture(network)
  },
  getSuiServiceInfo: async () => {
    tatumCalls += 1
    if (tatumMode.fail) throw new Error('synthetic gRPC unavailable')
    return tatumFixture().serviceInfo
  },
  getSuiCheckpoint: async () => {
    tatumCalls += 1
    if (tatumMode.fail) throw new Error('synthetic gRPC unavailable')
    return tatumFixture().checkpoint
  },
  getSuiObject: async () => {
    tatumCalls += 1
    if (tatumMode.fail) throw new Error('synthetic gRPC unavailable')
    return { digest: 'SYNTHETIC-OFFLINE-OBJECT' }
  },
  getSuiReferenceGasPrice: async (network) => {
    tatumCalls += 1
    if (tatumMode.fail) throw new Error('synthetic gRPC unavailable')
    return {
      network,
      provider: 'Tatum Sui gRPC',
      retrievedAt: new Date().toISOString(),
      epoch: '777',
      referenceGasPrice: '750',
      unit: 'MIST',
      evidenceStatus: 'retrieved_from_tatum',
      cryptographicallyVerified: false
    }
  }
}

// Each scenario installs its own fake and always restores the real client
// afterwards: afterEach runs even when a test's assertions fail, so a
// failure can never leak the fake into a later test.
beforeEach(() => {
  setSuiGrpcClient(fakeSuiGrpcClient)
})

afterEach(() => {
  setSuiGrpcClient(null)
})

function validAnalysis() {
  return {
    subQuestions: ['What checkpoint is latest?'],
    interpretation: 'The checkpoint advanced from 42424241 to 42424242.',
    contradictions: [{ claim: 'a', against: 'b', severity: 'low' }],
    uncertainties: ['Whether 42424242 is final.'],
    evidenceGaps: ['No object metadata was retrieved.'],
    confidenceNote: 'Moderate; based only on the supplied checkpoint metadata.'
  }
}

function metaCompletion() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ choices: [{ message: { content: JSON.stringify(validAnalysis()) } }] }),
    text: async () => 'unused'
  }
}

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('127.0.0.1')) return realFetch(url, init)
  if (target.includes('api.meta.ai')) {
    metaCalls += 1
    if (metaMode.fail) {
      return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}), text: async () => 'synthetic meta failure' }
    }
    if (metaMode.customContent !== null) {
      const content = metaMode.customContent
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ choices: [{ message: { content } }] }),
        text: async () => 'unused'
      }
    }
    return metaCompletion()
  }
  if (target.includes('publisher.walrus-testnet.walrus.space')) {
    if (walrusMode.failPublish) {
      return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}), text: async () => 'synthetic publisher outage' }
    }
    publishCount += 1
    lastPublishedBody = init?.body
    const blobId = `synthetic-blob-${publishCount}`
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        newlyCreated: {
          blobObject: { blobId, id: '0xsynthetic', registeredEpoch: 424242 },
          cost: {}
        }
      }),
      text: async () => 'unused'
    }
  }
  if (target.includes('aggregator.walrus-testnet.walrus.space')) {
    // Exact-byte read-back of whatever the mocked publisher accepted.
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => lastPublishedBody }
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
  // Fail closed when SQLite silently degrades to memory mode.
  const status = getPersistenceStore().getStatus()
  assert.equal(status.mode, 'sqlite', 'persistence must be sqlite, not degraded memory mode')
  assert.equal(status.persistent, true)
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

async function postSession(question) {
  const res = await realFetch(`${baseUrl}/api/recallguard/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question })
  })
  return { status: res.status, body: await res.json() }
}

async function postMemory(title, content) {
  const res = await realFetch(`${baseUrl}/api/recallguard/memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content })
  })
  return { status: res.status, body: await res.json() }
}

async function getJson(path) {
  const res = await realFetch(`${baseUrl}/api/recallguard${path}`)
  return { status: res.status, body: await res.json() }
}

const CHECKPOINT_QUESTION = 'What is the latest Sui checkpoint status on mainnet?'

let completedSessionId = null
let unavailableSessionId = null

function assertNoSecrets(serialized) {
  for (const secret of [process.env.TATUM_API_KEY, process.env.META_API_KEY]) {
    assert.ok(!serialized.includes(secret), 'response must never contain a secret value')
  }
}

describe('offline research workflow', () => {
  it('Scenario 1: successful checkpoint research end to end', async () => {
    const { status, body } = await postSession(CHECKPOINT_QUESTION)
    assert.equal(status, 201)
    assertNoSecrets(JSON.stringify(body))

    // Deterministic core.
    assert.ok(body.session.id.startsWith('SES-LIVE-'))
    assert.equal(body.session.provenance, 'live_production')
    assert.equal(body.session.onChainSuiData.checkpointSequence, '42424242')
    assert.equal(body.session.onChainSuiData.evidenceStatus, 'retrieved_from_tatum')
    assert.equal(body.session.onChainSuiData.cryptographicallyVerified, false)
    assert.equal(body.onChainError, null)
    assert.ok(body.session.conclusion.includes('Retrieved sui_checkpoint_status'))
    assert.ok(body.session.claims.some((c) => c.type === 'on_chain_observation'))
    assert.ok(!body.session.claims.some((c) => c.type === 'evidence_retrieval_error'))
    // UI contract: retrieved observations always pair a retrieval timestamp
    // with cryptographicallyVerified: false, so the frontend can label
    // them "Retrieved" and never "Verified".
    for (const claim of body.session.claims.filter((c) => c.type === 'on_chain_observation')) {
      assert.ok(typeof claim.verifiedAt === 'string' && claim.verifiedAt.length > 0)
      assert.equal(claim.details?.cryptographicallyVerified, false)
    }

    // First live observation: no comparable prior, hence no candidate.
    assert.equal(body.evidenceComparison.status, 'no_comparable_prior_evidence')
    assert.equal(body.revisionCandidate, null)
    assert.equal(body.liveDecision, null)

    // Walrus publish + exact-byte read-back, exactly one blob.
    assert.equal(body.walrusStoreResult.writeStatus, 'accepted')
    assert.equal(body.walrusStoreResult.storageVerified, true)
    assert.equal(body.walrusStoreError, null)
    assert.equal(publishCount, 1)
    assert.ok(body.storedMemory)
    assert.equal(body.storedMemory.provenance, 'live_production')
    assert.equal(body.storedMemory.walrusBlobId, 'synthetic-blob-1')

    // Meta analysis completed and audited exactly once.
    assert.equal(body.aiStatus, 'completed')
    assert.equal(body.aiErrorCode, null)
    assert.equal(body.aiAnalysis.model, 'muse-spark-1.3')
    assert.equal(body.aiAnalysis.provider, 'meta')
    assert.equal(body.aiAnalysis.interpretation, 'The checkpoint advanced from 42424241 to 42424242.')

    // SQLite records with intact foreign keys.
    const store = getPersistenceStore()
    const sessionId = body.session.id
    assert.equal(store.listSessions().some((s) => s.id === sessionId), true)
    const evidence = store.listEvidence(sessionId)
    assert.equal(evidence.length, 1)
    assert.equal(String(evidence[0].session_id), sessionId)
    assert.equal(store.listAiAnalysisBySession(sessionId).length, 1)
    assert.equal(store.listCandidates().length, 0)
    const auditActions = store.listAudit(50).map((row) => `${row.action}:${row.entity_id}`)
    assert.ok(auditActions.includes(`session.created:${sessionId}`))
    assert.ok(auditActions.includes(`memory.created:${body.storedMemory.id}`))
    assert.ok(auditActions.includes(`ai_analysis.created:AI-${sessionId}`))
    // Exactly one AI audit event for this analysis: no duplicates.
    assert.equal(
      store.listAudit(100).filter((row) => row.action === 'ai_analysis.created' && row.entity_id === `AI-${sessionId}`).length,
      1
    )
    completedSessionId = sessionId
  })

  it('Scenario 2: Tatum unavailable still yields a session with an error claim', async () => {
    tatumMode.fail = true
    const { status, body } = await postSession(CHECKPOINT_QUESTION)
    tatumMode.fail = false
    assert.equal(status, 201)
    assertNoSecrets(JSON.stringify(body))

    assert.equal(body.session.onChainSuiData, null)
    assert.ok(typeof body.onChainError === 'string')
    // No fabricated observation: the error is a claim, not evidence.
    assert.ok(!body.session.claims.some((c) => c.type === 'on_chain_observation'))
    assert.ok(body.session.claims.some((c) => c.type === 'evidence_retrieval_error'))
    assert.ok(body.session.conclusion.includes('Tatum evidence retrieval failed'))

    // SQLite: session and audit exist, but no evidence row.
    const store = getPersistenceStore()
    assert.equal(store.listSessions().some((s) => s.id === body.session.id), true)
    assert.equal(store.listEvidence(body.session.id).length, 0)
    assert.ok(store.listAudit(50).some((row) => row.action === 'session.created' && row.entity_id === body.session.id))
  })

  it('Scenario 3: Walrus unavailable keeps the persisted session', async () => {
    walrusMode.failPublish = true
    const { status, body } = await postSession(CHECKPOINT_QUESTION)
    walrusMode.failPublish = false
    assert.equal(status, 201)
    assertNoSecrets(JSON.stringify(body))

    assert.equal(body.walrusStoreResult, null)
    assert.ok(typeof body.walrusStoreError === 'string')
    assert.equal(body.storedMemory, null)
    // The deterministic session and its evidence survive the Walrus outage.
    assert.equal(body.session.onChainSuiData.checkpointSequence, '42424242')
    const store = getPersistenceStore()
    assert.equal(store.listSessions().some((s) => s.id === body.session.id), true)
    assert.equal(store.listEvidence(body.session.id).length, 1)
  })

  it('Scenario 4: Meta unavailable leaves deterministic results unchanged', async () => {
    metaMode.fail = true
    const { status, body } = await postSession(CHECKPOINT_QUESTION)
    metaMode.fail = false
    assert.equal(status, 201)
    assertNoSecrets(JSON.stringify(body))

    assert.equal(body.aiStatus, 'unavailable')
    assert.equal(body.aiAnalysis, null)
    assert.equal(body.aiErrorCode, 'META_AI_UNAVAILABLE')
    // Deterministic core is identical in shape to the success path.
    assert.equal(body.session.onChainSuiData.checkpointSequence, '42424242')
    assert.ok(body.session.conclusion.includes('Retrieved sui_checkpoint_status'))
    assert.ok(body.session.claims.some((c) => c.type === 'on_chain_observation'))
    assert.equal(body.walrusStoreResult.writeStatus, 'accepted')

    // The failed attempt is still audited exactly once.
    const rows = getPersistenceStore().listAiAnalysisBySession(body.session.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'unavailable')
    assert.equal(rows[0].analysis, null)
    unavailableSessionId = body.session.id
  })

  it('Scenario 6: live research recalls live memories but never demo memories', async () => {
    // Seed one eligible live memory through the real memories endpoint.
    const live = await postMemory(
      'Sui genesis checkpoint digest live tracker',
      'Live tracking note for the sui genesis checkpoint digest recall check.'
    )
    assert.equal(live.status, 201)
    const liveMemoryId = live.body.memory.id

    // Highly demo-relevant question: DEMO-MEM-002 ("Sui Genesis Checkpoint
    // Digest") would score above the recall threshold without isolation.
    const { status, body } = await postSession('What is the Sui genesis checkpoint digest?')
    assert.equal(status, 201)
    assertNoSecrets(JSON.stringify(body))

    assert.ok(body.session.recalledMemoryIds.includes(liveMemoryId))
    assert.ok(!body.session.recalledMemoryIds.some((id) => String(id).startsWith('DEMO-')))
    for (const claim of body.session.claims.filter((c) => c.type === 'recalled_memory')) {
      assert.equal(claim.details.provenance, 'live_production')
    }

    // Demo functionality remains intact: demo sessions, demo memories, and
    // the superseded demo memory are all still listed and untouched.
    const sessions = await getJson('/sessions')
    assert.ok(sessions.body.some((s) => s.id === 'DEMO-SES-001'))
    assert.ok(sessions.body.some((s) => s.id === 'DEMO-SES-002'))
    const memories = await getJson('/memories')
    assert.ok(memories.body.some((m) => m.id === 'DEMO-MEM-001'))
    assert.ok(memories.body.some((m) => m.id === 'DEMO-MEM-003' && m.status === 'superseded'))
    assert.ok(!body.session.recalledMemoryIds.includes('DEMO-MEM-003'))
  })

  it('Scenario 7: guardrail rejection audits only sanitized diagnostics', async () => {
    const violating = JSON.stringify({
      ...validAnalysis(),
      interpretation: 'The checkpoint advanced. Further verification is needed.'
    })
    metaMode.customContent = violating
    const { status, body } = await postSession(CHECKPOINT_QUESTION)
    metaMode.customContent = null
    assert.equal(status, 201)
    assertNoSecrets(JSON.stringify(body))
    assert.equal(body.aiStatus, 'unavailable')
    assert.equal(body.aiAnalysis, null)
    assert.equal(body.aiErrorCode, 'META_AI_UNAVAILABLE')
    // Deterministic core is unaffected by the rejected interpretation.
    assert.equal(body.session.onChainSuiData.checkpointSequence, '42424242')

    const rows = getPersistenceStore().listAudit(100)
    const audit = rows.find((row) => row.action === 'ai_analysis.created' && row.entity_id === `AI-${body.session.id}`)
    assert.ok(audit, 'expected an ai_analysis.created audit row')
    const details = JSON.parse(audit.details_json)
    assert.deepEqual(details.validationErrors, ['guardrail violation in interpretation'])
    assert.ok(!JSON.stringify(details).includes('Further verification is needed'))
    // Exactly one AI analysis row and one audit event: no duplicates,
    // and no raw model response stored anywhere.
    assert.equal(getPersistenceStore().listAiAnalysisBySession(body.session.id).length, 1)
    assert.equal(
      rows.filter((row) => row.action === 'ai_analysis.created' && row.entity_id === `AI-${body.session.id}`).length,
      1
    )
  })

  it('session detail includes the persisted successful AI analysis', async () => {
    assert.ok(completedSessionId, 'Scenario 1 must run first')
    const before = { tatumCalls, metaCalls, publishCount }
    const beforeCounts = {
      sessions: getPersistenceStore().listSessions().length,
      audit: getPersistenceStore().listAudit(1000).length
    }
    const { status, body } = await getJson(`/sessions/${completedSessionId}`)
    assert.equal(status, 200)
    // Existing session fields preserved.
    assert.equal(body.id, completedSessionId)
    assert.equal(body.provenance, 'live_production')
    assert.ok(Array.isArray(body.claims) && body.claims.length > 0)
    assert.ok(typeof body.conclusion === 'string')
    // Persisted AI analysis attached read-only.
    assert.equal(body.aiStatus, 'completed')
    assert.equal(body.aiErrorCode, null)
    assert.equal(body.aiModel, 'muse-spark-1.3')
    assert.equal(body.aiProvider, 'meta')
    assert.equal(body.aiAnalysis.interpretation, 'The checkpoint advanced from 42424241 to 42424242.')
    // Pure read: no external calls, no new rows, no audit events.
    assert.deepEqual({ tatumCalls, metaCalls, publishCount }, before)
    assert.equal(getPersistenceStore().listSessions().length, beforeCounts.sessions)
    assert.equal(getPersistenceStore().listAudit(1000).length, beforeCounts.audit)
  })

  it('session detail includes the unavailable AI status without invoking Meta', async () => {
    assert.ok(unavailableSessionId, 'Scenario 4 must run first')
    const before = { tatumCalls, metaCalls, publishCount }
    const { status, body } = await getJson(`/sessions/${unavailableSessionId}`)
    assert.equal(status, 200)
    assert.equal(body.id, unavailableSessionId)
    assert.equal(body.aiStatus, 'unavailable')
    assert.equal(body.aiErrorCode, 'META_AI_UNAVAILABLE')
    assert.equal(body.aiAnalysis, null)
    assert.equal(body.aiModel, 'muse-spark-1.3')
    assert.equal(body.aiProvider, 'meta')
    assert.deepEqual({ tatumCalls, metaCalls, publishCount }, before)
  })

  it('session detail reports sessions without AI records honestly', async () => {
    const { status, body } = await getJson('/sessions/DEMO-SES-001')
    assert.equal(status, 200)
    assert.equal(body.id, 'DEMO-SES-001')
    assert.equal(body.aiStatus, 'not_run')
    assert.equal(body.aiAnalysis, null)
    assert.equal(body.aiErrorCode, null)
    // List rows stay lightweight: no AI fields on the collection endpoint.
    const list = await getJson('/sessions')
    assert.ok(list.body.every((s) => !('aiStatus' in s)))
  })

  it('every emitted claim type belongs to the supported contract', async () => {
    // The dashboard maps exactly these 11 types; anything outside would
    // render as an undifferentiated fallback. Each claim carries exactly
    // one type, so per-type counts can never double-count.
    const CONTRACT_11 = [
      'verified_fact', 'unverified_claim', 'ai_interpretation', 'superseded_claim',
      'research_plan', 'on_chain_observation', 'evidence_retrieval_error',
      'recalled_memory', 'memory_search_result', 'evidence_gap', 'evidence_comparison'
    ]
    const { status, body } = await postSession('What philosophical meaning does memory hold for agents?')
    assert.equal(status, 201)
    assertNoSecrets(JSON.stringify(body))
    assert.ok(body.session.claims.some((c) => c.type === 'evidence_gap'))
    for (const claim of body.session.claims) {
      assert.equal(typeof claim.type, 'string')
      assert.ok(CONTRACT_11.includes(claim.type), `unmapped claim type: ${claim.type}`)
      assert.equal(body.session.claims.filter((c) => c === claim).length, 1)
    }
  })

  it('Scenario 8: reference gas price research retrieves live Sui evidence', async () => {
    const callsBefore = tatumCalls
    const { status, body } = await postSession('What is the current Sui reference gas price?')
    assert.equal(status, 201)
    assertNoSecrets(JSON.stringify(body))

    assert.equal(body.session.researchPlan.capability, 'sui_reference_gas_price')
    assert.equal(tatumCalls - callsBefore, 1)
    assert.equal(body.onChainError, null)

    const evidence = body.session.onChainSuiData
    assert.equal(evidence.operation, 'reference_gas_price')
    assert.equal(evidence.referenceGasPrice, '750')
    assert.equal(evidence.unit, 'MIST')
    assert.equal(evidence.epoch, '777')
    assert.equal(evidence.evidenceStatus, 'retrieved_from_tatum')
    assert.equal(evidence.cryptographicallyVerified, false)
    assert.ok(body.session.claims.some((c) => c.type === 'on_chain_observation'))
    assert.ok(!body.session.claims.some((c) => c.type === 'evidence_retrieval_error'))
    assert.equal(body.evidenceComparison.status, 'no_comparable_prior_evidence')
  })

  it('Scenario 5: persistence failure leaves no phantom session or candidate', async () => {
    const before = await getJson('/sessions')
    const beforeCount = before.body.length
    const candidatesBefore = getPersistenceStore().listCandidates().length

    // Simulate a dead database: every persist call now fails closed.
    getPersistenceStore().close()
    const { status, body } = await postSession(CHECKPOINT_QUESTION)
    assert.equal(status, 500)
    assert.equal(body.code, 'PERSISTENCE_UNAVAILABLE')

    // No phantom in-memory records were exposed: the route unshifts the
    // session and candidate only after the persist succeeds, and there is
    // no HTTP surface for candidates, so the session count is the check.
    const after = await getJson('/sessions')
    assert.equal(after.body.length, beforeCount)
    assert.equal(candidatesBefore, 0)
  })
})
