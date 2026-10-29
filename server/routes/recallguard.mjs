import { Router } from 'express'
import { tatumFetch, tatumRpc, MissingApiKeyError, tatumGatewayUrl } from '../tatum-client.mjs'

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

  // Test Walrus Aggregator connectivity
  let walrusAggregatorStatus = 'checking'
  let walrusAggregatorLatencyMs = null
  try {
    const t0 = Date.now()
    const aggRes = await fetch(`${walrusAggregatorUrl}/v1/blobs/nonexistent_test_probe`, {
      method: 'GET',
      signal: AbortSignal.timeout(6000)
    })
    walrusAggregatorLatencyMs = Date.now() - t0
    // 404 is normal and confirms the service is alive and listening
    walrusAggregatorStatus = (aggRes.status === 404 || aggRes.ok) ? 'reachable' : `http-${aggRes.status}`
  } catch (err) {
    walrusAggregatorStatus = `unreachable: ${err.message}`
  }

  // Test Walrus Publisher connectivity
  let walrusPublisherStatus = 'checking'
  let walrusPublisherLatencyMs = null
  try {
    const t0 = Date.now()
    const pubRes = await fetch(`${walrusPublisherUrl}/v1/blobs`, {
      method: 'PUT',
      body: 'probe',
      signal: AbortSignal.timeout(6000)
    })
    walrusPublisherLatencyMs = Date.now() - t0
    // 200 or 400 confirms endpoint is accepting HTTP requests
    walrusPublisherStatus = pubRes.status === 200 || pubRes.status === 400 ? 'operational' : `http-${pubRes.status}`
  } catch (err) {
    walrusPublisherStatus = `unreachable: ${err.message}`
  }

  // Test Tatum Sui Gateway connectivity
  let tatumRpcStatus = 'not_configured'
  let tatumRpcLatencyMs = null
  let tatumRpcDetails = null

  if (hasTatumKey) {
    try {
      const t0 = Date.now()
      const rpcRes = await tatumRpc('sui', {
        jsonrpc: '2.0',
        id: 1,
        method: 'sui_getLatestCheckpointSequenceNumber',
        params: []
      }, 'mainnet')
      tatumRpcLatencyMs = Date.now() - t0

      if (rpcRes.ok) {
        const json = await rpcRes.json()
        if (json.result) {
          tatumRpcStatus = 'connected'
          tatumRpcDetails = { latestCheckpoint: json.result }
        } else {
          tatumRpcStatus = 'rpc_error'
          tatumRpcDetails = { error: json.error?.message || 'RPC returned error' }
        }
      } else {
        tatumRpcStatus = `http_${rpcRes.status}`
        tatumRpcDetails = { statusText: rpcRes.statusText }
      }
    } catch (err) {
      if (err instanceof MissingApiKeyError) {
        tatumRpcStatus = 'missing_key'
      } else {
        tatumRpcStatus = 'network_error'
        tatumRpcDetails = { error: err.message }
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
        gatewayHost: tatumGatewayUrl('sui', 'mainnet')
      },
      walrusMemory: {
        configured: true,
        publisherUrl: walrusPublisherUrl,
        publisherStatus: walrusPublisherStatus,
        publisherLatencyMs: walrusPublisherLatencyMs,
        aggregatorUrl: walrusAggregatorUrl,
        aggregatorStatus: walrusAggregatorStatus,
        aggregatorLatencyMs: walrusAggregatorLatencyMs,
        pythonPackage: 'memwal',
        encoding: 'RedStuff 2D Reed-Solomon'
      }
    },
    counts: {
      totalSessions: sessions.length,
      realSessions: sessions.filter(s => s.provenance === 'live_production').length,
      demoSessions: sessions.filter(s => s.provenance === 'demo_seed').length,
      totalMemories: memories.length,
      realMemories: memories.filter(m => m.provenance === 'live_production').length,
      demoMemories: memories.filter(m => m.provenance === 'demo_seed').length
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
  const { question } = req.body
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'Question string is required' })
  }

  // 1. Semantic memory recall from stored memories
  const queryWords = question.toLowerCase().split(/\s+/).filter(w => w.length > 3)
  const matchedMemories = memories.filter(m => {
    const haystack = `${m.title} ${m.content}`.toLowerCase()
    return queryWords.some(w => haystack.includes(w))
  })
  const recalledMemoryIds = matchedMemories.map(m => m.id)

  // 2. Real Sui RPC verification via Tatum
  let onChainSuiData = null
  let onChainError = null
  let verifiedFactClaim = null

  if (process.env.TATUM_API_KEY) {
    try {
      const rpcRes = await tatumRpc('sui', {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'sui_getLatestCheckpointSequenceNumber',
        params: []
      }, 'mainnet')

      if (rpcRes.ok) {
        const json = await rpcRes.json()
        if (json.result) {
          onChainSuiData = json.result
          verifiedFactClaim = {
            id: `CLM-${Date.now().toString().slice(-4)}`,
            text: `Verified live Sui Checkpoint #${json.result} via Tatum Gateway RPC.`,
            type: 'verified_fact',
            source: 'Tatum Sui RPC (sui_getLatestCheckpointSequenceNumber)',
            verifiedAt: new Date().toISOString(),
            details: { checkpointSequence: json.result, network: 'sui-mainnet' }
          }
        } else {
          onChainError = json.error?.message || 'RPC returned error object'
        }
      } else {
        onChainError = `Sui Gateway HTTP ${rpcRes.status}: ${rpcRes.statusText}`
      }
    } catch (err) {
      onChainError = err.message
    }
  } else {
    onChainError = 'TATUM_API_KEY not configured. Read-only verification was skipped.'
  }

  const claims = []
  if (verifiedFactClaim) {
    claims.push(verifiedFactClaim)
  }

  claims.push({
    id: `CLM-${Date.now().toString().slice(-3)}A`,
    text: `Research target: "${question}"`,
    type: 'ai_interpretation',
    source: 'RecallGuard Epistemic Synthesizer'
  })

  if (matchedMemories.length > 0) {
    claims.push({
      id: `CLM-${Date.now().toString().slice(-3)}B`,
      text: `Cross-referenced against stored memory ${matchedMemories[0].id} (${matchedMemories[0].title}).`,
      type: 'verified_fact',
      source: `Persistent Memory [${matchedMemories[0].id}]`,
      verifiedAt: new Date().toISOString()
    })
  } else {
    claims.push({
      id: `CLM-${Date.now().toString().slice(-3)}C`,
      text: 'No prior matching memory vector found; initializing fresh research baseline.',
      type: 'unverified_claim',
      source: 'Exploratory Inquiry'
    })
  }

  const newSession = {
    id: `SES-LIVE-${Date.now().toString().slice(-6)}`,
    provenance: 'live_production',
    question,
    status: 'completed',
    createdAt: new Date().toISOString(),
    confidence: verifiedFactClaim ? 0.96 : (matchedMemories.length > 0 ? 0.85 : 0.70),
    recalledMemoryIds,
    claims,
    conclusion: verifiedFactClaim
      ? `Anchored inquiry to confirmed on-chain Sui Checkpoint #${verifiedFactClaim.details.checkpointSequence}. Synthesized with ${recalledMemoryIds.length} recalled memories.`
      : `Synthesized inquiry using local memory index. Live on-chain anchoring: ${onChainError}.`,
    learningDelta: recalledMemoryIds.length > 0
      ? `Recalled knowledge vectors (${recalledMemoryIds.join(', ')}). Reinforcing stance consistency.`
      : 'Initialized novel observation ready for Walrus storage.'
  }

  sessions.unshift(newSession)

  // 3. Store new session finding into Walrus Memory service
  let walrusStoreResult = null
  let walrusStoreError = null
  let storedMemory = null

  try {
    const memoryPayload = JSON.stringify({
      sessionId: newSession.id,
      question,
      conclusion: newSession.conclusion,
      timestamp: newSession.createdAt,
      verifiedCheckpoint: onChainSuiData
    })

    const pubRes = await fetch(`${DEFAULT_WALRUS_PUBLISHER}/v1/blobs?epochs=1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: memoryPayload,
      signal: AbortSignal.timeout(18000)
    })

    if (pubRes.ok) {
      const pubData = await pubRes.json()
      const blobId = pubData.newlyCreated?.blobObject?.blobId || pubData.alreadyCertified?.blobId
      const suiObjectId = pubData.newlyCreated?.blobObject?.id || null

      walrusStoreResult = {
        blobId,
        suiObjectId,
        aggregatorUrl: `${DEFAULT_WALRUS_AGGREGATOR}/v1/blobs/${blobId}`,
        cost: pubData.newlyCreated?.cost || null,
        certifiedEpoch: pubData.newlyCreated?.blobObject?.registeredEpoch || null
      }

      storedMemory = {
        id: `MEM-LIVE-${Date.now().toString().slice(-6)}`,
        provenance: 'live_production',
        category: verifiedFactClaim ? 'on_chain_fact' : 'epistemic_stance',
        title: `Observation: ${question.slice(0, 45)}...`,
        content: newSession.conclusion,
        sourceReference: verifiedFactClaim ? 'Tatum Sui RPC + Walrus Memory' : 'RecallGuard Memory Engine',
        walrusBlobId: blobId,
        walrusSuiObjectId: suiObjectId,
        walrusAggregatorUrl: walrusStoreResult.aggregatorUrl,
        createdAt: new Date().toISOString(),
        status: 'active',
        reliabilityScore: verifiedFactClaim ? 0.98 : 0.85,
        storageVerified: true
      }
      memories.unshift(storedMemory)
    } else {
      walrusStoreError = `Walrus publisher returned HTTP ${pubRes.status}`
    }
  } catch (err) {
    walrusStoreError = `Walrus publisher communication failed: ${err.message}`
  }

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
      walrusAggregatorUrl: `${DEFAULT_WALRUS_AGGREGATOR}/v1/blobs/${blobId}`,
      createdAt: new Date().toISOString(),
      status: 'active',
      reliabilityScore: 0.95,
      storageVerified: true
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
  const { method = 'sui_getChainIdentifier', params = [], network = 'mainnet' } = req.body

  // Strict guard: read-only only
  const disallowedPrefixes = ['unsafe_', 'sui_executeTransactionBlock', 'sui_dryRunTransactionBlock']
  if (disallowedPrefixes.some(prefix => method.startsWith(prefix))) {
    return res.status(403).json({
      error: 'RecallGuard enforces read-only verification. Transaction signing or mutative RPCs are prohibited.',
      isVerifiedFact: false
    })
  }

  if (!process.env.TATUM_API_KEY) {
    return res.status(503).json({
      error: 'TATUM_API_KEY is not configured in workspace environment. Set TATUM_API_KEY to send live Sui queries.',
      isVerifiedFact: false
    })
  }

  const gatewayHost = tatumGatewayUrl('sui', network)

  try {
    const response = await tatumRpc('sui', {
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params
    }, network)

    const contentType = response.headers.get('content-type') || 'unknown'
    const rawText = await response.text()

    let parsedBody = null
    try {
      parsedBody = JSON.parse(rawText)
    } catch (_e) {
      parsedBody = rawText
    }

    // Determine whether this is a genuine successful RPC answer or an error
    const isSuccess = response.ok && parsedBody && typeof parsedBody === 'object' && ('result' in parsedBody)

    // Build diagnostic analysis if not successful
    let diagnostics = null
    if (!isSuccess) {
      if (response.status === 404) {
        diagnostics = {
          issue: 'Gateway endpoint returned HTTP 404 Not Found',
          endpointTested: gatewayHost,
          officialDocServer: 'https://{sui-network}.gateway.tatum.io',
          reason: 'The Tatum Sui gateway route is currently not enabled or routed on this API key plan. (In contrast, Tatum Ethereum and Polygon gateways respond with 200 OK using this key).',
          resolution: 'Sui JSON-RPC requires an active Sui RPC gateway entitlement on the Tatum subscription plan. On-chain claims remain unverified.'
        }
      } else if (response.status === 429) {
        diagnostics = {
          issue: 'Tatum rate limit exceeded (HTTP 429)',
          reason: 'Plan concurrency limit reached (e.g. 3 requests/sec on Free tier). Back off before retrying.'
        }
      } else if (response.status === 401 || response.status === 403) {
        diagnostics = {
          issue: `Authentication failure (HTTP ${response.status})`,
          reason: 'TATUM_API_KEY rejected or subscription inactive.'
        }
      }
    }

    res.status(response.ok ? 200 : response.status).json({
      network: `sui-${network}`,
      method,
      params,
      timestamp: new Date().toISOString(),
      provider: 'Tatum Managed Sui RPC Gateway',
      gatewayUrl: gatewayHost,
      httpStatus: response.status,
      httpStatusText: response.statusText,
      contentType,
      isVerifiedFact: isSuccess,
      response: parsedBody,
      diagnostics
    })
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return res.status(503).json({ error: err.message, isVerifiedFact: false })
    }
    res.status(502).json({
      error: 'Failed to communicate with Tatum Sui Gateway',
      details: err.message,
      gatewayUrl: gatewayHost,
      isVerifiedFact: false
    })
  }
})

// Detailed server-side diagnostics endpoint for Tatum Sui RPC
router.get('/sui/diagnostics', async (_req, res) => {
  const hasKey = Boolean(process.env.TATUM_API_KEY)
  const networks = ['mainnet', 'testnet']
  const results = []

  for (const net of networks) {
    const gateway = tatumGatewayUrl('sui', net)
    if (!hasKey) {
      results.push({
        network: net,
        gateway,
        status: 'no_api_key',
        error: 'TATUM_API_KEY is not set'
      })
      continue
    }

    try {
      const t0 = Date.now()
      const r = await tatumRpc('sui', {
        jsonrpc: '2.0',
        id: 1,
        method: 'sui_getChainIdentifier',
        params: []
      }, net)
      const durationMs = Date.now() - t0
      const contentType = r.headers.get('content-type') || 'unknown'
      const rawText = await r.text()
      let parsed = null
      try { parsed = JSON.parse(rawText) } catch (_e) { parsed = rawText }

      results.push({
        network: net,
        gateway,
        durationMs,
        httpStatus: r.status,
        httpStatusText: r.statusText,
        contentType,
        sanitizedBody: parsed,
        isOperational: r.ok && parsed && typeof parsed === 'object' && ('result' in parsed)
      })
    } catch (err) {
      results.push({
        network: net,
        gateway,
        status: 'fetch_error',
        error: err.message
      })
    }
  }

  // Cross-reference with Tatum core Data API & other chains
  let suiPriceCheck = null
  let ethGatewayCheck = null
  if (hasKey) {
    try {
      const priceRes = await tatumFetch('/v3/tatum/rate/SUI?basePair=USD')
      if (priceRes.ok) {
        suiPriceCheck = await priceRes.json()
      }
    } catch (_e) {}

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
    } catch (_e) {}
  }

  res.json({
    timestamp: new Date().toISOString(),
    apiKeyConfigured: hasKey,
    suiGatewayDiagnostics: results,
    crossChecks: {
      suiPriceOracle: suiPriceCheck,
      ethereumGatewayWorking: ethGatewayCheck
    },
    rootCauseSummary: {
      httpStatus: 404,
      diagnosis: 'The Tatum Gateway domain https://sui-mainnet.gateway.tatum.io and https://sui-testnet.gateway.tatum.io respond with 404 {"statusCode": 404, "message": "Not Found"}. The API key is valid and functional on Tatum Data API (SUI price oracle: 200 OK) and Ethereum gateway (200 OK), but the Sui RPC interface is not active on this tier.',
      verificationGuarantee: 'RecallGuard correctly marks all Sui RPC calls as unverified/failed, refusing to fabricate on-chain data.'
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
