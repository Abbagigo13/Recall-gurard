import { Router } from 'express'
import { createRateLimiter, rateLimitOptions } from '../rate-limit.mjs'
import { mountDemoAuth, requireDemoAuth } from '../demo-auth.mjs'

// Demo spend protection: unauthenticated expensive endpoints are
// rate-limited before their handlers run, so rejected requests can never
// trigger Tatum, Meta, or Walrus calls. Single-user demo defaults.
const sessionsLimiter = createRateLimiter(rateLimitOptions('SESSIONS', 30, 60_000))
const memoriesLimiter = createRateLimiter(rateLimitOptions('MEMORIES', 60, 60_000))
const diagnosticsLimiter = createRateLimiter(rateLimitOptions('DIAGNOSTICS', 30, 60_000))
import {
  buildResearchPlan,
  rankMemories
} from '../research-planner.mjs'
import {
  buildRevisionOutcome,
  compareResearchEvidence
} from '../evidence-comparison.mjs'
import { publishAndVerify, probeWalrusAggregator, WALRUS_WRITE_ERROR_CODE } from '../walrus-storage.mjs'
import { initStore, publicPersistenceError, PERSISTENCE_ERROR_CODE, PERSISTENCE_UNHEALTHY_CODE } from '../store.mjs'
import { analyzeResearch, META_AI_ERROR_CODE, metaModel, metaApiBase } from '../meta-ai.mjs'
import {
  tatumFetch,
  tatumRpc,
  MissingApiKeyError,
  tatumGatewayUrl
} from '../tatum-client.mjs'

import {
  getSuiNetworkStatus as grpcGetSuiNetworkStatus,
  getSuiServiceInfo as grpcGetSuiServiceInfo,
  getSuiCheckpoint as grpcGetSuiCheckpoint,
  getSuiObject as grpcGetSuiObject
} from '../sui-grpc-client.mjs'

const router = Router()

// Demo-access authentication (Phase 6B). Login/logout/status/CSRF live
// under /auth/*; spend-bearing routes below require a session. Reads stay
// public. Sessions are server-side and in-memory: single-replica only,
// lost on restart.
mountDemoAuth(router)

// Walrus endpoints from official testnet specification / environment
const DEFAULT_WALRUS_AGGREGATOR = process.env.WALRUS_AGGREGATOR_URL || process.env.WALRUS_STORAGE_URL || 'https://aggregator.walrus-testnet.walrus.space'
const DEFAULT_WALRUS_PUBLISHER = process.env.WALRUS_PUBLISHER_URL || 'https://publisher.walrus-testnet.walrus.space'

// Seeded DEMO historical data (explicitly labeled provenance: 'demo_seed')
const DEMO_SESSIONS = [
  {
    id: 'DEMO-SES-001',
    provenance: 'demo_seed',
    question: 'Verify latest Sui checkpoint sequence number, committee size, and epoch progression',
    status: 'completed',
    createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    confidence: 0.94,
    recalledMemoryIds: ['DEMO-MEM-001', 'DEMO-MEM-002'],
    claims: [
      {
        id: 'DEMO-CLM-001',
        text: 'Sui Mainnet Genesis Checkpoint digest is 35834a8a (simulated reference demo).',
        type: 'verified_fact',
        source: 'Demo Seed Ground Truth',
        verifiedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        details: { method: 'sui_getChainIdentifier', network: 'sui-mainnet' }
      },
      {
        id: 'DEMO-CLM-002',
        text: 'Walrus uses 2D Reed-Solomon RedStuff encoding requiring 3f+1 sliver quorum.',
        type: 'verified_fact',
        source: 'Walrus Protocol Specification (Whitepaper §3.2)',
        verifiedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        details: { blobEncoding: '2D Reed-Solomon', redundancy: '3f+1' }
      },
      {
        id: 'DEMO-CLM-003',
        text: 'DeepBook V3 liquidity pool package upgrades require multi-sig governance consensus.',
        type: 'unverified_claim',
        source: 'Sui Community Discussion (Demo Observation)'
      }
    ],
    conclusion: 'Demonstration inquiry showing multi-session memory recall. Live queries run below will be marked provenance: live_production.',
    learningDelta: 'Reinforced epistemic weight on verifiable on-chain facts (+0.04).'
  },
  {
    id: 'DEMO-SES-002',
    provenance: 'demo_seed',
    question: 'What is the required minimum collateral for Walrus storage nodes on Sui?',
    status: 'completed',
    createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
    confidence: 0.91,
    recalledMemoryIds: ['DEMO-MEM-003'],
    claims: [
      {
        id: 'DEMO-CLM-004',
        text: 'Preliminary devnet blog claimed 5,000 SUI collateral.',
        type: 'superseded_claim',
        source: 'Deprecated Devnet Spec (DEMO-MEM-003)'
      },
      {
        id: 'DEMO-CLM-005',
        text: 'Updated Sui smart contract package object showed 10,000 SUI minimum stake requirement.',
        type: 'verified_fact',
        source: 'On-Chain Move Package Inspection',
        verifiedAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString()
      }
    ],
    conclusion: 'Agent updated conclusion from 5,000 SUI to 10,000 SUI based on direct on-chain contract state inspection.',
    learningDelta: 'Epistemic correction: Superseded DEMO-MEM-003. Confidence increased from 0.65 to 0.98.'
  }
]

const DEMO_MEMORIES = [
  {
    id: 'DEMO-MEM-001',
    provenance: 'demo_seed',
    category: 'protocol_spec',
    title: 'Walrus RedStuff 2D Reed-Solomon Codec',
    content: 'Walrus uses 2D Reed-Solomon erasure coding (RedStuff) ensuring blob reconstruction with 3f+1 Byzantine fault tolerance.',
    sourceReference: 'Walrus Whitepaper v1.2',
    walrusBlobId: 'demo_blob_redstuff_spec_v1',
    createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    status: 'active',
    reliabilityScore: 0.95,
    storageVerified: false
  },
  {
    id: 'DEMO-MEM-002',
    provenance: 'demo_seed',
    category: 'on_chain_fact',
    title: 'Sui Genesis Checkpoint Digest',
    content: 'Sui genesis checkpoint digest verified via Tatum RPC with chain identifier 35834a8a.',
    sourceReference: 'Tatum Sui RPC sui_getChainIdentifier (Reference)',
    walrusBlobId: 'demo_blob_sui_genesis_ref',
    createdAt: new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString(),
    status: 'active',
    reliabilityScore: 0.99,
    storageVerified: false
  },
  {
    id: 'DEMO-MEM-003',
    provenance: 'demo_seed',
    category: 'epistemic_stance',
    title: 'Walrus Storage Node Collateral (Deprecated)',
    content: 'Preliminary devnet estimate of 5,000 SUI collateral per storage node.',
    sourceReference: 'Walrus Devnet Draft Blog',
    walrusBlobId: 'demo_blob_deprecated_stake',
    createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    status: 'superseded',
    supersededBy: 'DEMO-MEM-004',
    reliabilityScore: 0.40,
    storageVerified: false
  },
  {
    id: 'DEMO-MEM-004',
    provenance: 'demo_seed',
    category: 'on_chain_fact',
    title: 'Walrus Storage Node Minimum Collateral',
    content: 'Verified on-chain contract threshold requires 10,000 SUI minimum stake for active storage node participation.',
    sourceReference: 'Tatum Sui RPC & Sui Move Package',
    walrusBlobId: 'demo_blob_sui_storage_stake',
    createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
    status: 'active',
    reliabilityScore: 0.98,
    storageVerified: false
  }
]

const DEMO_DECISIONS = [
  {
    id: 'DEMO-DEC-001',
    provenance: 'demo_seed',
    topic: 'Walrus Storage Node Minimum Collateral',
    previousSessionId: 'DEMO-SES-001',
    currentSessionId: 'DEMO-SES-002',
    priorClaim: 'Storage collateral is 5,000 SUI (Confidence: 65%) based on early devnet post.',
    newClaim: 'Storage collateral is 10,000 SUI (Confidence: 98%) based on Sui Move contract inspection.',
    changeReason: 'Direct verification of Sui smart contract package object revealed updated parameter. On-chain truth superseded off-chain community documentation.',
    impact: 'Replaced DEMO-MEM-003 with DEMO-MEM-004 in persistent memory graph.',
    timestamp: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString()
  }
]

// Runtime mutable stores
let sessions = [...DEMO_SESSIONS]
let memories = [...DEMO_MEMORIES]
let decisions = [...DEMO_DECISIONS]
// Pending evidence-change candidates awaiting independent verification.
// Kept separate from `decisions` so a candidate is never presented as a
// completed epistemic stance revision.
let revisionCandidates = []

// SQLite persistence (Phase 3). The store seeds demo rows once, migrates
// live records by id, and reloads the arrays from the database so the DB is
// the source of truth at boot. In a restricted preview without a writable
// filesystem it degrades to explicit non-persistent memory mode.
const { store: persistenceStore, sessions: storedSessions, memories: storedMemories, decisions: storedDecisions, revisionCandidates: storedCandidates } = initStore({
  dbPath: process.env.RECALLGUARD_DB_PATH || './data/recallguard.db',
  sessions,
  memories,
  decisions
})
sessions = storedSessions
memories = storedMemories
decisions = storedDecisions
revisionCandidates = storedCandidates

// Prompt version stamped on every persisted AI analysis row.
export const AI_PROMPT_VERSION = '1.0.0'

// Test seam for the integration below (also used by the HTTP suite via
// getPersistenceStore). Production always uses the real Meta client and
// the route's store; defaults keep that path intact.
export function getPersistenceStore() {
  return persistenceStore
}

// Injectable Tatum Sui gRPC client (test seam for the offline suite).
// grpc-js opens its own sockets outside fetch, so HTTP mocks cannot stub
// it. Production always uses the real client; offline tests inject a fake
// via setSuiGrpcClient and restore with setSuiGrpcClient(null).
const realSuiGrpcClient = {
  getSuiNetworkStatus: grpcGetSuiNetworkStatus,
  getSuiServiceInfo: grpcGetSuiServiceInfo,
  getSuiCheckpoint: grpcGetSuiCheckpoint,
  getSuiObject: grpcGetSuiObject
}
let suiGrpcClient = realSuiGrpcClient
export function setSuiGrpcClient(client) {
  suiGrpcClient = client ?? realSuiGrpcClient
}

// Meta AI interpretation for one persisted deterministic session.
// Never throws: every outcome resolves to stable { aiStatus, aiAnalysis,
// aiErrorCode }. The deterministic session, comparison, candidates, and
// decisions are never touched here — AI output is interpretation only.
// Every attempt is audited with one ai_analyses row (UNIQUE per session):
// the validated analysis on success, or status/model/error-code only on
// failure. A failed audit write reports persistence_failed and withholds
// the analysis so storage is never misrepresented.
export async function resolveAiAnalysis(newSession, matchedMemories, { analyzeFn = analyzeResearch, store = persistenceStore } = {}) {
  let result
  try {
    result = await analyzeFn({
      question: newSession.question,
      capability: newSession.researchPlan?.capability,
      onChainSuiData: newSession.onChainSuiData ?? null,
      recalledMemories: matchedMemories ?? [],
      evidenceComparison: newSession.evidenceComparison ?? null
    })
  } catch {
    result = { ok: false, aiStatus: 'unavailable', errorCode: META_AI_ERROR_CODE, analysis: null }
  }

  if (!result || result.ok !== true || !result.analysis) {
    const aiStatus = result && (result.aiStatus === 'invalid' || result.aiStatus === 'unavailable')
      ? result.aiStatus
      : 'unavailable'
    const errorCode = (result && result.errorCode) || META_AI_ERROR_CODE
    // Audit the failed attempt with stable fields only: status, model,
    // provider, prompt version, timestamp, the stable error code, and
    // sanitized validation diagnostics (field paths and rule names only).
    // Never raw provider detail, request bodies, or model output.
    const validationErrors = result && Array.isArray(result.validationErrors)
      ? result.validationErrors
      : []
    let recorded = false
    try {
      recorded = store.persistAiAnalysis({
        id: `AI-${newSession.id}`,
        sessionId: newSession.id,
        model: result && result.ran === false ? 'unknown' : metaModel(),
        provider: 'meta',
        promptVersion: AI_PROMPT_VERSION,
        status: aiStatus,
        analysis: null,
        latencyMs: (result && result.latencyMs) ?? null,
        errorCode,
        validationErrors
      })
    } catch {
      recorded = false
    }
    if (!recorded) {
      return { aiStatus: 'persistence_failed', aiAnalysis: null, aiErrorCode: PERSISTENCE_ERROR_CODE }
    }
    return {
      aiStatus,
      aiAnalysis: null,
      aiErrorCode: errorCode
    }
  }

  const { model, provider, ...analysisBody } = result.analysis
  let persisted = false
  try {
    persisted = store.persistAiAnalysis({
      id: `AI-${newSession.id}`,
      sessionId: newSession.id,
      model: result.analysis.model,
      provider: result.analysis.provider || 'meta',
      promptVersion: AI_PROMPT_VERSION,
      status: 'completed',
      analysis: analysisBody,
      latencyMs: result.latencyMs ?? null,
      errorCode: null
    })
  } catch {
    persisted = false
  }
  if (!persisted) {
    // The deterministic session stays intact; only the status reports that
    // the analysis write did not land. The analysis body is withheld so a
    // stored analysis is never implied. The code names the SQLite layer,
    // never the Meta provider, so provider vs persistence failures stay
    // distinguishable.
    return { aiStatus: 'persistence_failed', aiAnalysis: null, aiErrorCode: PERSISTENCE_ERROR_CODE }
  }
  return { aiStatus: 'completed', aiAnalysis: result.analysis, aiErrorCode: null }
}

// --------------------------------------------------------------------------
// 1. Health check & Integration Status Endpoint (/api/recallguard/health)
// --------------------------------------------------------------------------

    
router.get('/health', async (_req, res) => {
  const hasTatumKey = Boolean(process.env.TATUM_API_KEY)

  const walrusPublisherUrl = DEFAULT_WALRUS_PUBLISHER
  const walrusAggregatorUrl = DEFAULT_WALRUS_AGGREGATOR

  // Non-mutating Walrus aggregator connectivity check. Read-only probe:
  // no publication, no read-back, no writes of any kind.
  const aggregatorProbe = await probeWalrusAggregator({ aggregatorUrl: walrusAggregatorUrl })
  const walrusAggregatorStatus = aggregatorProbe.status
  const walrusAggregatorLatencyMs = aggregatorProbe.latencyMs

  // Do not perform storage writes during health checks
  const walrusPublisherStatus = 'not_checked'
  const walrusPublisherLatencyMs = null

  // Tatum Sui gRPC connectivity check
  let tatumRpcStatus = hasTatumKey
    ? 'checking'
    : 'not_configured'

  let tatumRpcLatencyMs = null
  let tatumRpcDetails = null

  if (hasTatumKey) {
    try {
      const started = Date.now()
      const result = await suiGrpcClient.getSuiNetworkStatus('mainnet')

      tatumRpcLatencyMs = Date.now() - started
      tatumRpcStatus = 'connected'

      tatumRpcDetails = {
        provider: result.provider,
        network: result.network,
        epoch: result.serviceInfo.epoch,
        checkpointHeight: result.serviceInfo.checkpointHeight,
        checkpointDigest: result.checkpoint.checkpoint?.digest,
        evidenceStatus: 'retrieved_from_tatum',
        cryptographicallyVerified: false
      }
    } catch (error) {
      tatumRpcStatus = error instanceof MissingApiKeyError
        ? 'missing_key'
        : 'network_error'

      tatumRpcDetails = {
        error: error.message
      }
    }
  }

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),

    integrations: {
      tatumSuiRpc: {
        configured: hasTatumKey,
        status: tatumRpcStatus,
        latencyMs: tatumRpcLatencyMs,
        details: tatumRpcDetails,
        gatewayHost: 'https://sui-mainnet-grpc.gateway.tatum.io',
        protocol: 'gRPC'
      },

      walrusMemory: {
        configured: true,
        publisherUrl: walrusPublisherUrl,
        publisherStatus: walrusPublisherStatus,
        publisherLatencyMs: walrusPublisherLatencyMs,
        aggregatorUrl: walrusAggregatorUrl,
        aggregatorStatus: walrusAggregatorStatus,
        aggregatorLatencyMs: walrusAggregatorLatencyMs,
        storageWriteTested: false
      }
    },

    counts: {
      totalSessions: sessions.length,
      realSessions: sessions.filter(
        s => s.provenance === 'live_production'
      ).length,
      demoSessions: sessions.filter(
        s => s.provenance === 'demo_seed'
      ).length,
      totalMemories: memories.length,
      realMemories: memories.filter(
        m => m.provenance === 'live_production'
      ).length,
      demoMemories: memories.filter(
        m => m.provenance === 'demo_seed'
      ).length
    },

    persistence: persistenceStore.getStatus()
  })
})

// Local-only readiness probe for platform health checks (Phase 6B).
// Distinct from the detailed /health endpoint above: no Tatum, Meta, or
// Walrus traffic, no database writes, no secrets, paths, or raw errors.
// 200 only when SQLite file storage is persistent and healthy; 503 when
// essential persistence is unavailable (including degraded memory mode).
router.get('/health/ready', (_req, res) => {
  const status = persistenceStore.getStatus()
  const ready = status.persistent === true && status.healthy !== false
  if (ready) {
    return res.json({ ready: true, code: 'READY' })
  }
  const code = status.healthy === false ? PERSISTENCE_UNHEALTHY_CODE : PERSISTENCE_ERROR_CODE
  res.status(503).json({ ready: false, code })
})

// Config status for UI badges (local configuration check only: no network
// requests, no secret values in the response).
router.get('/config-status', async (_req, res) => {
  const hasTatumKey = Boolean(process.env.TATUM_API_KEY)
  const metaKey = process.env.META_API_KEY
  const metaConfigured = typeof metaKey === 'string' && metaKey.length > 0
  res.json({
    hasTatumKey,
    hasWalrusSdk: true,
    walrusPublisher: DEFAULT_WALRUS_PUBLISHER,
    walrusAggregator: DEFAULT_WALRUS_AGGREGATOR,
    memwalAdapter: {
      pythonSdkPackage: 'memwal',
      version: '0.2.1-compatible',
      mode: 'live-walrus-http-bridge',
      storageEngine: 'Walrus RedStuff 2D Reed-Solomon'
    },
    meta: {
      configured: metaConfigured,
      provider: 'meta',
      model: metaModel(),
      baseUrl: metaApiBase(),
      status: metaConfigured ? 'configured' : 'missing_key'
    }
  })
})

// --------------------------------------------------------------------------
// 2. Metrics (Distinguishing Real vs Demo Evaluated Claims)
// --------------------------------------------------------------------------
router.get('/metrics', (_req, res) => {
  const realSessions = sessions.filter(s => s.provenance === 'live_production')
  const realMemories = memories.filter(m => m.provenance === 'live_production')
  const realDecisions = decisions.filter(d => d.provenance === 'live_production')

  const realEvaluatedClaims = realSessions.reduce((acc, s) => acc + s.claims.length, 0)
  const realVerifiedFacts = realSessions.reduce((acc, s) => acc + s.claims.filter(c => c.type === 'verified_fact').length, 0)
  const realSupersededClaims = realSessions.reduce((acc, s) => acc + s.claims.filter(c => c.type === 'superseded_claim').length, 0)

  const realTotalVerifiable = realVerifiedFacts + realSupersededClaims
  const realAccuracyScore = realTotalVerifiable > 0
    ? Math.round((realVerifiedFacts / realTotalVerifiable) * 1000) / 10
    : null

  // Aggregated (including labeled demo seed)
  const totalSessions = sessions.length
  const totalMemories = memories.length
  const totalClaims = sessions.reduce((acc, s) => acc + s.claims.length, 0)
  const verifiedFacts = sessions.reduce((acc, s) => acc + s.claims.filter(c => c.type === 'verified_fact').length, 0)
  const supersededClaims = sessions.reduce((acc, s) => acc + s.claims.filter(c => c.type === 'superseded_claim').length, 0)
  const totalVerifiable = verifiedFacts + supersededClaims
  const overallAccuracyScore = totalVerifiable > 0
    ? Math.round((verifiedFacts / totalVerifiable) * 1000) / 10
    : null

  res.json({
    real: {
      sessionsCount: realSessions.length,
      memoriesCount: realMemories.length,
      decisionsCount: realDecisions.length,
      evaluatedClaims: realEvaluatedClaims,
      verifiedFacts: realVerifiedFacts,
      supersededClaims: realSupersededClaims,
      accuracyScore: realAccuracyScore
    },
    aggregated: {
      totalSessions,
      totalMemories,
      evaluatedClaims: totalClaims,
      verifiedFacts,
      supersededClaims,
      accuracyScore: overallAccuracyScore,
      decisionsCount: decisions.length
    }
  })
})

// --------------------------------------------------------------------------
// 3. Research Workspace Sessions
// --------------------------------------------------------------------------
router.get('/sessions', (req, res) => {
  const { provenance } = req.query
  if (provenance && provenance !== 'all') {
    return res.json(sessions.filter(s => s.provenance === provenance))
  }
  res.json(sessions)
})

router.get('/sessions/:id', (req, res) => {
  const session = sessions.find(s => s.id === req.params.id)
  if (!session) return res.status(404).json({ error: 'Session not found' })
  // Historical AI status is read from the persisted audit record only.
  // Never runs inference and never writes: a pure read for the detail view.
  let recorded = null
  try {
    const rows = persistenceStore.listAiAnalysisBySession(session.id)
    recorded = rows.length > 0 ? rows[0] : null
  } catch {
    recorded = null
  }
  if (!recorded) {
    return res.json({
      ...session,
      aiStatus: 'not_run',
      aiAnalysis: null,
      aiErrorCode: null,
      aiModel: null,
      aiProvider: null
    })
  }
  return res.json({
    ...session,
    aiStatus: recorded.status,
    aiAnalysis: recorded.analysis,
    aiErrorCode: recorded.errorCode,
    aiModel: recorded.model,
    aiProvider: recorded.provider
  })
})



router.post('/sessions', sessionsLimiter, requireDemoAuth(), async (req, res) => {
  const { question, network = 'mainnet' } = req.body

  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({
      error: 'Question string is required'
    })
  }

  if (!['mainnet', 'testnet'].includes(network)) {
    return res.status(400).json({
      error: 'Network must be mainnet or testnet.'
    })
  }

  const cleanQuestion = question.trim()

  // 1. Build an explicit research plan.
  const researchPlan = buildResearchPlan(cleanQuestion)

  // 2. Recall and rank relevant memories.
  // Recall is not independent fact verification. Live research recalls
  // live memories only: demo_seed rows stay visible in demo sessions and
  // listings, but must never influence a live_production session, its
  // claims, or its AI input.
  const rankedMemories = rankMemories(
    cleanQuestion,
    memories.filter(
      memory => memory.status !== 'superseded' &&
        memory.provenance === 'live_production'
    )
  )

  const matchedMemories = rankedMemories.map(item => item.memory)
  const recalledMemoryIds = matchedMemories.map(memory => memory.id)
 

  // 3. Retrieve only the evidence requested by the research plan.
  let onChainSuiData = null
  let onChainError = null
  let observedCheckpointClaim = null

  if (researchPlan.requiresTatum) {
    if (!process.env.TATUM_API_KEY) {
      onChainError = 'TATUM_API_KEY not configured.'
    } else {
      try {
        if (researchPlan.capability === 'sui_checkpoint_status') {
          const result = await suiGrpcClient.getSuiNetworkStatus(network)
          const checkpoint = result.checkpoint?.checkpoint

          onChainSuiData = {
            network: `sui-${network}`,
            provider: result.provider,
            operation: 'checkpoint_status',
            checkpointSequence: result.checkpoint.sequenceNumber,
            checkpointDigest: checkpoint?.digest || null,
            epoch: result.serviceInfo.epoch,
            retrievedAt: result.retrievedAt,
            evidenceStatus: 'retrieved_from_tatum',
            cryptographicallyVerified: false
          }

        } else if (researchPlan.capability === 'sui_object_lookup') {
          const result = await suiGrpcClient.getSuiObject(
            network,
            researchPlan.requestedObjectId
          )

          onChainSuiData = {
            network: `sui-${network}`,
            provider: 'Tatum Sui gRPC',
            operation: 'object_lookup',
            objectId: researchPlan.requestedObjectId,
            object: result,
            retrievedAt: new Date().toISOString(),
            evidenceStatus: 'retrieved_from_tatum',
            cryptographicallyVerified: false
          }

        } else if (
          researchPlan.capability === 'sui_chain_identifier' ||
          researchPlan.capability === 'sui_network_status'
        ) {
          const result = await suiGrpcClient.getSuiServiceInfo(network)

          onChainSuiData = {
            network: `sui-${network}`,
            provider: 'Tatum Sui gRPC',
            operation: researchPlan.capability,
            chainId: result.chainId ?? result.chainIdentifier ?? null,
            serviceInfo: result,
            retrievedAt: new Date().toISOString(),
            evidenceStatus: 'retrieved_from_tatum',
            cryptographicallyVerified: false
          }
        }

        if (onChainSuiData) {
          observedCheckpointClaim = {
            id: `CLM-${Date.now()}-CHAIN`,
            text: `Retrieved ${researchPlan.capability} evidence from Tatum Sui gRPC on ${network}.`,
            type: 'on_chain_observation',
            source: 'Tatum Sui gRPC',
            verifiedAt: onChainSuiData.retrievedAt,
            details: {
              operation: onChainSuiData.operation,
              network: onChainSuiData.network,
              evidenceStatus: 'retrieved_from_tatum',
              cryptographicallyVerified: false
            }
          }
        }
      } catch (error) {
        onChainError = error.message
      }
    }
  }

  // 4. Classify the evidence honestly.
  const claims = []

  claims.push({
    id: `CLM-${Date.now()}-PLAN`,
    text: `Research capability selected: ${researchPlan.capability}.`,
    type: 'research_plan',
    source: 'RecallGuard Deterministic Research Planner',
    details: {
      plannerVersion: researchPlan.plannerVersion,
      evidenceSources: researchPlan.evidenceSources,
      aiModelUsed: false
    }
  })

  if (observedCheckpointClaim) {
    claims.push(observedCheckpointClaim)
  }

  if (onChainError) {
    claims.push({
      id: `CLM-${Date.now()}-ERR`,
      text: `Requested Tatum evidence could not be retrieved: ${onChainError}`,
      type: 'evidence_retrieval_error',
      source: 'Tatum Sui gRPC'
    })
  }

  for (const memory of matchedMemories) {
    claims.push({
      id: `CLM-${Date.now()}-${claims.length}`,
      text: `Recalled memory: ${memory.title}. This is previously stored information, not independent verification.`,
      type: 'recalled_memory',
      source: `Memory Index [${memory.id}]`,
      details: {
        memoryId: memory.id,
        provenance: memory.provenance,
        storageVerified: memory.storageVerified === true,
        status: memory.status
      }
    })
  }

  if (matchedMemories.length === 0) {
    claims.push({
      id: `CLM-${Date.now()}-NONE`,
      text: 'No matching stored memories were found in the local memory index.',
      type: 'memory_search_result',
      source: 'Local Memory Index'
    })
  }

  if (!observedCheckpointClaim && !researchPlan.requiresTatum) {
    claims.push({
      id: `CLM-${Date.now()}-SCOPE`,
      text: 'No configured external evidence connector currently supports this research capability.',
      type: 'evidence_gap',
      source: 'RecallGuard Evidence Planner'
    })
  }

  // 5. Build a transparent research conclusion.
  let conclusion

  if (onChainSuiData) {
    conclusion =
      `Retrieved ${researchPlan.capability} evidence from Tatum Sui gRPC on ${network}. ` +
      `${matchedMemories.length} relevant memories were recalled. ` +
      'The retrieved metadata is not independently cryptographically verified.'
  } else if (onChainError) {
    conclusion =
      `The research plan requested ${researchPlan.capability}, but Tatum evidence retrieval failed: ${onChainError}. ` +
      `${matchedMemories.length} relevant memories were recalled.`
  } else {
    conclusion =
      `Research scope analysis completed for: "${cleanQuestion}". ` +
      `${matchedMemories.length} relevant memories were recalled. ` +
      'No external evidence source was queried because this capability is not currently connected.'
  }

  const newSession = {
    id: `SES-LIVE-${Date.now().toString().slice(-6)}`,
    provenance: 'live_production',
    question: cleanQuestion,
    status: 'completed',
    createdAt: new Date().toISOString(),
    confidence: null,
    confidenceStatus: 'not_measured',
    researchPlan,
    onChainSuiData,
    recalledMemoryIds,
    claims,
    conclusion,
    learningDelta: matchedMemories.length > 0
      ? `Recalled ${matchedMemories.length} relevant memories: ${recalledMemoryIds.join(', ')}.`
      : 'No matching local memories were found.'
  }

  // 4b. Compare live evidence against previous live observations.
  // Read-only: previous sessions are never mutated here, and demo_seed
  // records are excluded inside compareResearchEvidence. A value change
  // yields a pending candidate only — committed revisions live in
  // `decisions` and are never auto-created on this path.
  let evidenceComparison = null
  let liveDecision = null
  let revisionCandidate = null

  try {
    evidenceComparison = compareResearchEvidence(newSession, sessions)
  } catch {
    evidenceComparison = {
      status: 'insufficient_evidence',
      reason: 'Evidence comparison could not be completed.',
      revision: null
    }
  }

  newSession.evidenceComparison = {
    status: evidenceComparison.status,
    reason: evidenceComparison.reason,
    comparedSessionId: evidenceComparison.comparedSessionId ?? null,
    previousValue: evidenceComparison.previousValue ?? null,
    currentValue: evidenceComparison.currentValue ?? null
  }

  if (
    evidenceComparison.status === 'consistent_observation' ||
    evidenceComparison.status === 'newer_observation' ||
    evidenceComparison.status === 'value_changed' ||
    evidenceComparison.status === 'unexpected_regression'
  ) {
    claims.push({
      id: `CLM-${Date.now()}-CMP`,
      text: `Evidence comparison (${evidenceComparison.status}): ${evidenceComparison.reason}`,
      type: 'evidence_comparison',
      source: 'RecallGuard Evidence Comparison Engine',
      details: {
        comparedSessionId: newSession.evidenceComparison.comparedSessionId,
        previousValue: newSession.evidenceComparison.previousValue,
        currentValue: newSession.evidenceComparison.currentValue
      }
    })
  }

  // A newer checkpoint/epoch sequence is an update, never a contradiction.
  // A genuine value change records a pending evidence-change candidate for
  // independent verification — never a committed revision, and no stored
  // memory is superseded here.
  {
    const outcome = buildRevisionOutcome(evidenceComparison, {
      evidence: onChainSuiData,
      capability: researchPlan.capability,
      currentSessionId: newSession.id,
      candidateId: `CAND-LIVE-${Date.now().toString().slice(-6)}`
    })

    revisionCandidate = outcome.candidate
    liveDecision = outcome.committedRevision

    if (revisionCandidate) {
      newSession.revisionCandidate = revisionCandidate

      newSession.learningDelta =
        `${newSession.learningDelta} Evidence change candidate recorded vs ${revisionCandidate.previousSessionId}; pending independent verification.`
    }
  }

  // Persist before exposing: the database write must succeed before the
  // record appears in memory, GET endpoints, or the dashboard. A failed
  // write returns 500 with no phantom record. The atomic helper inserts
  // the session row first so the candidate's foreign keys resolve in the
  // same transaction.
  const sessionPersisted = revisionCandidate
    ? persistenceStore.persistSessionWithCandidate(newSession, revisionCandidate)
    : persistenceStore.persistSession(newSession)
  if (!sessionPersisted) {
    // Public body carries only a stable code; raw driver detail was logged
    // server-side inside the store and never leaves the process.
    return res.status(500).json(publicPersistenceError('research session'))
  }
  sessions.unshift(newSession)
  if (revisionCandidate) {
    revisionCandidates.unshift(revisionCandidate)
  }


  // 5. Attempt to store the session finding in Walrus.
  

    
  let walrusStoreResult = null
  let walrusStoreError = null
  let storedMemory = null

  try {
    const memoryPayload = JSON.stringify({
      sessionId: newSession.id,
      question: cleanQuestion,
      conclusion: newSession.conclusion,
      timestamp: newSession.createdAt,
      onChainObservation: onChainSuiData
    })

    // 1-2. Publish and exact-byte verify via the shared helper.
    // A failed write never discards the session: it is recorded in
    // walrusStoreError while the session and its evidence stay intact.
    // Read-back equality confirms byte fidelity only, never claim truth.
    const walrusResult = await publishAndVerify(memoryPayload, {
      publisherUrl: DEFAULT_WALRUS_PUBLISHER,
      aggregatorUrl: DEFAULT_WALRUS_AGGREGATOR
    })

    const blobId = walrusResult.blobId
    const suiObjectId = walrusResult.suiObjectId
    const aggregatorUrl = walrusResult.aggregatorUrl
    const storageVerified = walrusResult.storageVerified === true
    const storageStatus = walrusResult.storageStatus
    const readbackError = walrusResult.error

    if (walrusResult.writeStatus !== 'accepted') {
      walrusStoreResult = null
      walrusStoreError = walrusResult.error
    } else {
      // 3. Record the actual verification result.
      walrusStoreResult = {
        blobId,
        suiObjectId,
        aggregatorUrl,
        readbackAttempts: walrusResult.readbackAttempts,
        cost: walrusResult.cost,
        certifiedEpoch: walrusResult.certifiedEpoch,
        writeStatus: 'accepted',
        storageVerified,
        storageStatus,
        readbackError,
        publishAttempts: walrusResult.publishAttempts,
        latencyMs: walrusResult.totalLatencyMs
      }

const sourceReferenceByCapability = {
  sui_checkpoint_status: 'Tatum Sui gRPC checkpoint metadata',
  sui_object_lookup: 'Tatum Sui gRPC object metadata',
  sui_chain_identifier: 'Tatum Sui gRPC chain identifier',
  sui_network_status: 'Tatum Sui gRPC network metadata',
  memory_and_scope_analysis: 'RecallGuard Research Engine'
}

const sourceReference =
  sourceReferenceByCapability[researchPlan.capability] ??
  'RecallGuard Research Engine'

      storedMemory = {
        id: `MEM-LIVE-${Date.now().toString().slice(-6)}`,
        provenance: 'live_production',
        category: onChainSuiData
          ? 'on_chain_observation'
          : 'epistemic_stance',
        title: `Observation: ${cleanQuestion.slice(0, 45)}...`,
        content: newSession.conclusion,
        sourceReference,
        walrusBlobId: blobId,
        walrusSuiObjectId: suiObjectId,
        walrusAggregatorUrl: aggregatorUrl,
        createdAt: new Date().toISOString(),
        status: 'active',
        reliabilityScore: null,
        confidence: null,
        confidenceStatus: 'not_measured',
        storageVerified,
        storageStatus
      }

      // The session above is already persisted; a Walrus failure never
      // discards it. The derived memory record follows the same
      // persist-before-expose rule: no phantom record on DB failure.
      if (persistenceStore.persistMemory(storedMemory)) {
        memories.unshift(storedMemory)
      } else {
        // Fixed public message: raw driver detail was logged server-side
        // inside the store. Response contract unchanged (201 with
        // storedMemory: null and a walrusStoreError string).
        walrusStoreError =
          'Session persisted, but its memory record could not be written to the database.'
        storedMemory = null
      }

      if (!storageVerified) {
        walrusStoreError = readbackError
      }
    }
  } catch (error) {
    // Fixed public message; raw exception detail goes to server logs only.
    console.error(`[recallguard] POST /sessions Walrus publish failed: ${error.message}`)
    walrusStoreError = 'Walrus publisher communication failed.'
  }

        
  // 5b. Meta AI interpretation (additive, never authoritative). Runs only
  // after the deterministic session is durable and the Walrus attempt has
  // resolved. Any AI or analysis-persistence failure degrades to an explicit
  // aiStatus; the session, comparison, candidates, and Walrus results are
  // unaffected, and AI output can never alter them (it is not consulted
  // above this line).
  const { aiStatus, aiAnalysis, aiErrorCode } = await resolveAiAnalysis(newSession, matchedMemories)

  // 6. Preserve the existing API response structure (additive fields only).
  // `liveDecision` stays null on this path: only a future verified-commit
  // flow may set it. Pending work is reported via `revisionCandidate`.
  res.status(201).json({
    session: newSession,
    storedMemory,
    walrusStoreResult,
    walrusStoreError,
    onChainSuiData,
    onChainError,
    evidenceComparison: newSession.evidenceComparison,
    liveDecision,
    revisionCandidate,
    aiAnalysis,
    aiStatus,
    aiErrorCode
  })
})


// --------------------------------------------------------------------------
// 4. Memory Explorer Endpoints (Walrus Store & Retrieve)
// --------------------------------------------------------------------------
router.get('/memories', (req, res) => {
  const { category, search, provenance } = req.query
  let list = [...memories]
  if (provenance && provenance !== 'all') {
    list = list.filter(m => m.provenance === provenance)
  }
  if (category && category !== 'all') {
    list = list.filter(m => m.category === category)
  }
  if (search && typeof search === 'string') {
    const s = search.toLowerCase()
    list = list.filter(m => m.title.toLowerCase().includes(s) || m.content.toLowerCase().includes(s) || m.id.toLowerCase().includes(s))
  }
  res.json(list)
})

// Real Walrus Memory Storage: calls official Walrus Publisher HTTP PUT
router.post('/memories', memoriesLimiter, requireDemoAuth(), async (req, res) => {
  const { title, content, category = 'epistemic_stance', sourceReference = 'Manual Input' } = req.body
  if (!title || !content) {
    return res.status(400).json({ error: 'Title and content are required' })
  }

  const memoryPayload = JSON.stringify({
    title,
    content,
    category,
    sourceReference,
    createdAt: new Date().toISOString()
  })

  try {
    // Same verification rules as research sessions: publish with bounded
    // retries, then require exact-byte read-back before verified storage.
    // Read-back equality confirms byte fidelity only, never claim truth.
    const walrusResult = await publishAndVerify(memoryPayload, {
      publisherUrl: DEFAULT_WALRUS_PUBLISHER,
      aggregatorUrl: DEFAULT_WALRUS_AGGREGATOR
    })

    if (walrusResult.writeStatus !== 'accepted') {
      // Stable public bodies only; helper detail was designed body-free and
      // the raw form goes to server logs.
      console.error(`[recallguard] POST /memories Walrus write failed: ${walrusResult.error}`)
      const httpStatus = walrusResult.publishHttpStatus
      if (httpStatus && (httpStatus < 200 || httpStatus >= 300)) {
        return res.status(httpStatus).json({
          error: 'Walrus storage rejected operation',
          code: WALRUS_WRITE_ERROR_CODE
        })
      }
      return res.status(502).json({
        error: 'Failed to write memory blob to Walrus storage',
        code: WALRUS_WRITE_ERROR_CODE
      })
    }

    const blobId = walrusResult.blobId
    const suiObjectId = walrusResult.suiObjectId
    const pubData = walrusResult.publisherResponse

    
const newMemory = {
  id: `MEM-LIVE-${Date.now().toString().slice(-6)}`,
  provenance: 'live_production',
  category,
  title,
  content,
  sourceReference,
  walrusBlobId: blobId,
  walrusSuiObjectId: suiObjectId,
  walrusAggregatorUrl: walrusResult.aggregatorUrl,
  createdAt: new Date().toISOString(),
  status: 'active',
  reliabilityScore: null,
  storageVerified: walrusResult.storageVerified === true,
  storageStatus: walrusResult.storageStatus
}


    // Persist before exposing: a failed database write returns 500 with
    // no phantom record in GET /memories or the dashboard.
    if (!persistenceStore.persistMemory(newMemory)) {
      // Public body carries only a stable code; raw driver detail was logged
      // server-side inside the store and never leaves the process.
      return res.status(500).json(publicPersistenceError('memory record'))
    }
    memories.unshift(newMemory)
    res.status(201).json({
      success: true,
      memory: newMemory,
      walrusRawResponse: pubData
    })
  } catch (err) {
    // Raw exception text goes to server logs only; the public body is fixed.
    console.error(`[recallguard] POST /memories Walrus request failed: ${err.message}`)
    res.status(502).json({
      error: 'Failed to write memory blob to Walrus storage',
      code: WALRUS_WRITE_ERROR_CODE
    })
  }
})

// Real Walrus Memory Recall / Fetch from Aggregator
router.get('/memories/walrus/:blobId', requireDemoAuth(), async (req, res) => {
  const { blobId } = req.params
  if (!blobId || blobId.startsWith('demo_')) {
    return res.status(400).json({ error: 'Cannot recall demo seed blob from real Walrus nodes.' })
  }

  try {
    const aggRes = await fetch(`${DEFAULT_WALRUS_AGGREGATOR}/v1/blobs/${blobId}`, {
      signal: AbortSignal.timeout(8000)
    })
    if (!aggRes.ok) {
      return res.status(aggRes.status).json({
        error: `Walrus aggregator returned HTTP ${aggRes.status}`
      })
    }

    const contentType = aggRes.headers.get('content-type') || 'text/plain'
    const rawData = await aggRes.text()

    let parsed = null
    try {
      parsed = JSON.parse(rawData)
    } catch (_e) {
      parsed = rawData
    }

    res.json({
      blobId,
      status: 'retrieved_from_walrus',
      aggregatorUrl: `${DEFAULT_WALRUS_AGGREGATOR}/v1/blobs/${blobId}`,
      contentType,
      data: parsed
    })
  } catch (err) {
    res.status(502).json({
      error: 'Failed to retrieve blob from Walrus aggregator',
      details: err.message
    })
  }
})

// --------------------------------------------------------------------------
// 5. Tatum Sui Direct RPC Query Verification endpoint (Read-Only)
// --------------------------------------------------------------------------

router.post('/sui/rpc', requireDemoAuth(), async (req, res) => {
  const {
    method = 'sui_getChainIdentifier',
    params = [],
    network = 'mainnet'
  } = req.body || {}

  // Only allow supported, read-only operations.
  const supportedMethods = [
    'sui_getLatestCheckpointSequenceNumber',
    'sui_getChainIdentifier',
    'sui_getObject'
  ]

  if (!supportedMethods.includes(method)) {
    return res.status(501).json({
      error: `Method "${method}" is not currently supported by the Tatum Sui gRPC integration.`,
      supportedMethods,
      isVerifiedFact: false,
      evidenceStatus: 'unsupported_method'
    })
  }

  if (!['mainnet', 'testnet'].includes(network)) {
    return res.status(400).json({
      error: 'Unsupported Sui network. Use mainnet or testnet.',
      isVerifiedFact: false
    })
  }

  if (!Array.isArray(params)) {
    return res.status(400).json({
      error: 'RPC params must be a JSON array.',
      isVerifiedFact: false
    })
  }

  if (!process.env.TATUM_API_KEY) {
    return res.status(503).json({
      error: 'TATUM_API_KEY is not configured.',
      isVerifiedFact: false
    })
  }

  const startedAt = Date.now()

  try {
    let result
    let operation

    switch (method) {
      case 'sui_getLatestCheckpointSequenceNumber': {
        operation = 'LedgerService.GetServiceInfo'

        const info = await suiGrpcClient.getSuiServiceInfo(network)

        result = String(info.checkpointHeight)
        break
      }

      case 'sui_getChainIdentifier': {
        operation = 'LedgerService.GetServiceInfo'

        const info = await suiGrpcClient.getSuiServiceInfo(network)

        result = info.chainId
        break
      }

      case 'sui_getObject': {
        operation = 'LedgerService.GetObject'

        const objectId = params[0]
        const options = params[1] || {}

        if (
          typeof options !== 'object' ||
          Array.isArray(options)
        ) {
          return res.status(400).json({
            error: 'Object options must be a JSON object.',
            isVerifiedFact: false
          })
        }

        const objectResponse = await suiGrpcClient.getSuiObject(
          network,
          objectId,
          options
        )

        result = objectResponse.object || null
        break
      }
    }

    res.json({
      network: `sui-${network}`,
      method,
      operation,
      params,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      provider: 'Tatum Sui gRPC',
      protocol: 'gRPC',
      status: 'success',
      evidenceStatus: 'retrieved_from_tatum',
      cryptographicallyVerified: false,
      isVerifiedFact: false,
      result
    })
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return res.status(503).json({
        error: err.message,
        isVerifiedFact: false
      })
    }

    res.status(502).json({
      error: 'Sui gRPC request failed.',
      details: err.message,
      network,
      method,
      provider: 'Tatum Sui gRPC',
      protocol: 'gRPC',
      durationMs: Date.now() - startedAt,
      evidenceStatus: 'retrieval_failed',
      cryptographicallyVerified: false,
      isVerifiedFact: false
    })
  }
})




// Detailed server-side diagnostics endpoint for Tatum Sui RPC


// Detailed server-side diagnostics endpoint for Tatum Sui gRPC
// Diagnostics stay disabled by default and their disabled response stays
// public. When an operator explicitly enables them, the live fan-out costs
// real quota, so authentication is required on the enabled path only.
function requireDemoAuthWhenEnabled(req, res, next) {
  const enabled = process.env.RECALLGUARD_ENABLE_DIAGNOSTICS === '1' ||
    String(process.env.RECALLGUARD_ENABLE_DIAGNOSTICS).toLowerCase() === 'true'
  if (!enabled) return next()
  return requireDemoAuth()(req, res, next)
}
router.get('/sui/diagnostics', diagnosticsLimiter, requireDemoAuthWhenEnabled, async (_req, res) => {
  // Expensive diagnostics fan out to several live external services per
  // request, so they are opt-in. Safe default: disabled in demo mode.
  // To enable for local debugging, set RECALLGUARD_ENABLE_DIAGNOSTICS=1.
  const diagnosticsEnabled = process.env.RECALLGUARD_ENABLE_DIAGNOSTICS === '1' ||
    String(process.env.RECALLGUARD_ENABLE_DIAGNOSTICS).toLowerCase() === 'true'
  if (!diagnosticsEnabled) {
    return res.json({
      enabled: false,
      status: 'disabled',
      code: 'DIAGNOSTICS_DISABLED',
      message: 'Set RECALLGUARD_ENABLE_DIAGNOSTICS=1 to enable live diagnostics.'
    })
  }
  const hasKey = Boolean(process.env.TATUM_API_KEY)
  const networks = ['mainnet', 'testnet']

  const apiBase = process.env.TATUM_API_BASE || 'https://api.tatum.io'
  const domain = new URL(apiBase).hostname.replace(/^api\./, '')

  const results = await Promise.all(
    networks.map(async (net) => {
      const gateway = `https://sui-${net}-grpc.gateway.${domain}`

      if (!hasKey) {
        return {
          network: net,
          gateway,
          protocol: 'gRPC',
          status: 'no_api_key',
          isOperational: false,
          error: 'TATUM_API_KEY is not set'
        }
      }

      try {
        const startedAt = Date.now()
        const networkStatus = await suiGrpcClient.getSuiNetworkStatus(net)
        const durationMs = Date.now() - startedAt

        const serviceInfo = networkStatus.serviceInfo || {}
        const checkpoint = networkStatus.checkpoint || {}

        return {
          network: net,
          gateway,
          protocol: 'gRPC',
          provider: 'Tatum Sui gRPC',
          durationMs,
          status: 'connected',
          isOperational: true,
          chainIdentifier: serviceInfo.chainId || null,
          epoch: serviceInfo.epoch || null,
          checkpointHeight: serviceInfo.checkpointHeight || null,
          latestCheckpoint: {
            sequenceNumber: checkpoint.sequenceNumber || null,
            digest: checkpoint.checkpoint?.digest || null
          },
          evidenceStatus: checkpoint.evidenceStatus,
          cryptographicallyVerified: false,
          retrievedAt: networkStatus.retrievedAt
        }
      } catch (err) {
        return {
          network: net,
          gateway,
          protocol: 'gRPC',
          status: 'connection_failed',
          isOperational: false,
          error: err.message
        }
      }
    })
  )

  // Cross-reference with Tatum core Data API and another chain.
  let suiPriceCheck = null
  let ethGatewayCheck = null

  if (hasKey) {
    try {
      const priceRes = await tatumFetch('/v3/tatum/rate/SUI?basePair=USD')

      suiPriceCheck = {
        status: priceRes.status,
        ok: priceRes.ok,
        data: priceRes.ok ? await priceRes.json() : null
      }
    } catch (err) {
      suiPriceCheck = {
        ok: false,
        error: err.message
      }
    }

    try {
      const ethRes = await tatumRpc('ethereum', {
        jsonrpc: '2.0',
        id: 1,
        method: 'web3_clientVersion',
        params: []
      }, 'mainnet')

      ethGatewayCheck = {
        status: ethRes.status,
        ok: ethRes.ok
      }
    } catch (err) {
      ethGatewayCheck = {
        ok: false,
        error: err.message
      }
    }
  }

  const operationalNetworks = results.filter(
    result => result.isOperational
  ).map(result => result.network)

  res.json({
    timestamp: new Date().toISOString(),
    apiKeyConfigured: hasKey,
    suiGatewayDiagnostics: results,
    crossChecks: {
      suiPriceOracle: suiPriceCheck,
      ethereumGatewayWorking: ethGatewayCheck
    },
    rootCauseSummary: {
      protocol: 'gRPC',
      operationalNetworks,
      diagnosis: operationalNetworks.length
        ? `Tatum Sui gRPC connectivity is confirmed for: ${operationalNetworks.join(', ')}. Legacy Sui JSON-RPC HTTP 404 responses do not establish that the API key lacks Sui access.`
        : 'Tatum Sui gRPC connectivity has not been confirmed. Review the individual network diagnostics.',
      verificationGuarantee: 'Checkpoint metadata is retrieved from Tatum Sui gRPC. Retrieval alone does not independently establish cryptographic verification or prove the truth of a research claim.'
    }
  })
})


// --------------------------------------------------------------------------
// 6. Learning Decisions & Audit Timeline
// --------------------------------------------------------------------------
router.get('/decisions', (_req, res) => {
  res.json(decisions)
})

router.get('/timeline', (_req, res) => {
  const timelineEvents = []

  sessions.forEach(s => {
    timelineEvents.push({
      id: `TL-${s.id}`,
      type: 'session',
      provenance: s.provenance,
      timestamp: s.createdAt,
      title: `${s.provenance === 'demo_seed' ? '[DEMO] ' : ''}Research Session: ${s.id}`,
      subtitle: s.question,
      confidence: s.confidence,
      details: s.conclusion,
      recalledMemoryIds: s.recalledMemoryIds
    })
  })

  decisions.forEach(d => {
    timelineEvents.push({
      id: `TL-${d.id}`,
      type: 'decision_update',
      provenance: d.provenance,
      timestamp: d.timestamp,
      title: `${d.provenance === 'demo_seed' ? '[DEMO] ' : ''}Epistemic Revision: ${d.topic}`,
      subtitle: d.changeReason,
      confidence: 0.98,
      details: `Changed: "${d.priorClaim}" -> "${d.newClaim}"`,
      recalledMemoryIds: []
    })
  })

  timelineEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  res.json(timelineEvents)
})

// --------------------------------------------------------------------------
// 7. Official Walrus memwal SDK Specification
// --------------------------------------------------------------------------
router.get('/walrus/sdk-spec', (_req, res) => {
  res.json({
    sdk: 'memwal',
    version: '0.2.1',
    storageEngine: 'Walrus RedStuff 2D Reed-Solomon',
    endpoints: {
      publisher: DEFAULT_WALRUS_PUBLISHER,
      aggregator: DEFAULT_WALRUS_AGGREGATOR,
      tatumSuiGateway: 'https://sui-mainnet.gateway.tatum.io'
    },
    envRequirements: [
      { name: 'TATUM_API_KEY', description: 'Tatum API Key for authenticating Sui RPC gateway requests' },
      { name: 'WALRUS_PUBLISHER_URL', description: 'HTTP endpoint for storing blobs (default: https://publisher.walrus-testnet.walrus.space)' },
      { name: 'WALRUS_AGGREGATOR_URL', description: 'HTTP endpoint for retrieving blobs (default: https://aggregator.walrus-testnet.walrus.space)' }
    ],
    officialPythonExample: `# Official memwal Python SDK integration pattern
import asyncio
from memwal import WalrusMemoryAgent

async def main():
    # Initialize agent with official Walrus endpoints
    agent = WalrusMemoryAgent(
        app_name="RecallGuard",
        publisher_url="https://publisher.walrus-testnet.walrus.space",
        aggregator_url="https://aggregator.walrus-testnet.walrus.space",
        epochs=1
    )
    
    # Store verifiable memory blob
    ref = await agent.store(
        category="on_chain_fact",
        title="Sui Checkpoint Verification",
        content="Finalized checkpoint verified via Tatum Sui Gateway",
        metadata={"network": "sui-mainnet", "provider": "Tatum"}
    )
    print("Stored blob on Walrus:", ref.blob_id)

    # Retrieve memory blob by ID
    memory = await agent.recall(ref.blob_id)
    print("Retrieved memory:", memory.content)

if __name__ == "__main__":
    asyncio.run(main())`
  })
})

export default router
