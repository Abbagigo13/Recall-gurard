import { Router } from 'express'
import {
  buildResearchPlan,
  rankMemories
} from '../research-planner.mjs'
import {
  compareResearchEvidence
} from '../evidence-comparison.mjs'
import {
  tatumFetch,
  tatumRpc,
  MissingApiKeyError,
  tatumGatewayUrl
} from '../tatum-client.mjs'

import {
  getSuiNetworkStatus,
  getSuiServiceInfo,
  getSuiCheckpoint,
  getSuiObject
} from '../sui-grpc-client.mjs'

const router = Router()

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

// --------------------------------------------------------------------------
// 1. Health check & Integration Status Endpoint (/api/recallguard/health)
// --------------------------------------------------------------------------

    
router.get('/health', async (_req, res) => {
  const hasTatumKey = Boolean(process.env.TATUM_API_KEY)

  const walrusPublisherUrl = DEFAULT_WALRUS_PUBLISHER
  const walrusAggregatorUrl = DEFAULT_WALRUS_AGGREGATOR

  // Non-mutating Walrus aggregator connectivity check
  let walrusAggregatorStatus = 'checking'
  let walrusAggregatorLatencyMs = null

  try {
    const started = Date.now()

    const response = await fetch(
      `${walrusAggregatorUrl}/v1/blobs/nonexistent_test_probe`,
      {
        method: 'GET',
        signal: AbortSignal.timeout(6000)
      }
    )

    walrusAggregatorLatencyMs = Date.now() - started

    walrusAggregatorStatus =
      response.ok || response.status === 404
        ? 'reachable'
        : `http-${response.status}`
  } catch {
    walrusAggregatorStatus = 'unreachable'
  }

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
      const result = await getSuiNetworkStatus('mainnet')

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
    }
  })
})

// Config status for UI badges
router.get('/config-status', async (_req, res) => {
  const hasTatumKey = Boolean(process.env.TATUM_API_KEY)
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
  res.json(session)
})



router.post('/sessions', async (req, res) => {
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
  // Recall is not independent fact verification.
  const rankedMemories = rankMemories(
    cleanQuestion,
    memories.filter(memory => memory.status !== 'superseded')
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
          const result = await getSuiNetworkStatus(network)
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
          const result = await getSuiObject(
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
          const result = await getSuiServiceInfo(network)

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

  sessions.unshift(newSession)


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

    // 1. Publish the memory to Walrus.
    const pubRes = await fetch(
      `${DEFAULT_WALRUS_PUBLISHER}/v1/blobs?epochs=1`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: memoryPayload,
        signal: AbortSignal.timeout(18000)
      }
    )

    if (!pubRes.ok) {
      walrusStoreError =
        `Walrus publisher returned HTTP ${pubRes.status}`
    } else {
      const pubData = await pubRes.json()

      const blobId =
        pubData.newlyCreated?.blobObject?.blobId ||
        pubData.alreadyCertified?.blobId ||
        null

      const suiObjectId =
        pubData.newlyCreated?.blobObject?.id || null

      const aggregatorUrl = blobId
        ? `${DEFAULT_WALRUS_AGGREGATOR}/v1/blobs/${blobId}`
        : null

      // 2. Verify the upload by reading it back.
      let storageVerified = false
      let storageStatus = 'write_accepted_unverified'
      let readbackError = null
      let readbackAttempts = 0

      if (aggregatorUrl) {
           const retryDelays = [500, 1000, 2000, 3000]
    let lastReadbackError = null

    for (let attempt = 0; attempt < 5; attempt++) {
      readbackAttempts = attempt + 1
      try {
        const readbackRes = await fetch(aggregatorUrl, {
          signal: AbortSignal.timeout(12000)
        })

        if (readbackRes.ok) {
          const retrievedPayload = await readbackRes.text()

          if (retrievedPayload === memoryPayload) {
            storageVerified = true
            storageStatus = 'verified_readback'
            readbackError = null
          } else {
            readbackError =
              'Retrieved blob does not exactly match the uploaded payload.'
            storageStatus = 'readback_mismatch'
          }

          break
        }

        lastReadbackError =
          `Walrus read-back returned HTTP ${readbackRes.status}`

        if (
          readbackRes.status !== 404 &&
          readbackRes.status < 500
        ) {
          break
        }
      } catch (error) {
        lastReadbackError =
          `Walrus read-back failed: ${error.message}`
      }

      if (attempt < 4) {
        await new Promise(resolve =>
          setTimeout(resolve, retryDelays[attempt])
        )
      }
    }

    if (!storageVerified && storageStatus !== 'readback_mismatch') {
      readbackError =
        lastReadbackError || 'Walrus read-back failed after retries.'
      storageStatus = 'readback_failed'
    }
      } else {
        readbackError = 'Publisher response did not contain a blob ID.'
        storageStatus = 'missing_blob_id'
      }

      // 3. Record the actual verification result.
      walrusStoreResult = {
        blobId,
        suiObjectId,
        aggregatorUrl,
        readbackAttempts,
        cost: pubData.newlyCreated?.cost || null,
        certifiedEpoch:
          pubData.newlyCreated?.blobObject?.registeredEpoch || null,
        writeStatus: 'accepted',
        storageVerified,
        storageStatus,
        readbackError
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

      memories.unshift(storedMemory)

      if (!storageVerified) {
        walrusStoreError = readbackError
      }
    }
  } catch (error) {
    walrusStoreError =
      `Walrus publisher communication failed: ${error.message}`
  }

        
  // 6. Preserve the existing API response structure.
  res.status(201).json({
    session: newSession,
    storedMemory,
    walrusStoreResult,
    walrusStoreError,
    onChainSuiData,
    onChainError
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
router.post('/memories', async (req, res) => {
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
    const pubRes = await fetch(`${DEFAULT_WALRUS_PUBLISHER}/v1/blobs?epochs=1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: memoryPayload,
      signal: AbortSignal.timeout(18000)
    })

    if (!pubRes.ok) {
      const errText = await pubRes.text()
      return res.status(pubRes.status).json({
        error: `Walrus storage rejected operation (HTTP ${pubRes.status})`,
        details: errText
      })
    }

    const pubData = await pubRes.json()
    const blobId = pubData.newlyCreated?.blobObject?.blobId || pubData.alreadyCertified?.blobId
    const suiObjectId = pubData.newlyCreated?.blobObject?.id || null

    
const newMemory = {
  id: `MEM-LIVE-${Date.now().toString().slice(-6)}`,
  provenance: 'live_production',
  category,
  title,
  content,
  sourceReference,
  walrusBlobId: blobId,
  walrusSuiObjectId: suiObjectId,
  walrusAggregatorUrl: blobId
    ? `${DEFAULT_WALRUS_AGGREGATOR}/v1/blobs/${blobId}`
    : null,
  createdAt: new Date().toISOString(),
  status: 'active',
  reliabilityScore: null,
  storageVerified: false,
  storageStatus: 'write_accepted_unverified'
}


    memories.unshift(newMemory)
    res.status(201).json({
      success: true,
      memory: newMemory,
      walrusRawResponse: pubData
    })
  } catch (err) {
    res.status(502).json({
      error: 'Failed to write memory blob to Walrus storage',
      details: err.message
    })
  }
})

// Real Walrus Memory Recall / Fetch from Aggregator
router.get('/memories/walrus/:blobId', async (req, res) => {
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

router.post('/sui/rpc', async (req, res) => {
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

        const info = await getSuiServiceInfo(network)

        result = String(info.checkpointHeight)
        break
      }

      case 'sui_getChainIdentifier': {
        operation = 'LedgerService.GetServiceInfo'

        const info = await getSuiServiceInfo(network)

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

        const objectResponse = await getSuiObject(
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
router.get('/sui/diagnostics', async (_req, res) => {
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
        const networkStatus = await getSuiNetworkStatus(net)
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
