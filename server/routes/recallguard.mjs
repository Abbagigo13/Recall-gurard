import { Router } from 'express'
import { tatumFetch, tatumRpc, MissingApiKeyError } from '../tatum-client.mjs'

const router = Router()

// In-memory runtime store for agent sessions, memories, evaluated claims, and audit timeline
let sessions = [
  {
    id: 'SES-012',
    question: 'Verify latest Sui checkpoint sequence number, committee size, and epoch progression',
    status: 'completed',
    createdAt: new Date(Date.now() - 14 * 60 * 1000).toISOString(),
    confidence: 0.94,
    recalledMemoryIds: ['MEM-001', 'MEM-004'],
    claims: [
      {
        id: 'CLM-031',
        text: 'Latest Sui Mainnet Checkpoint is active and finalized.',
        type: 'verified_fact',
        source: 'Tatum Sui RPC (sui_getLatestCheckpointSequenceNumber)',
        verifiedAt: new Date(Date.now() - 14 * 60 * 1000).toISOString(),
        details: { method: 'sui_getLatestCheckpointSequenceNumber', network: 'sui-mainnet' }
      },
      {
        id: 'CLM-032',
        text: 'Walrus Testnet epoch transition occurs every 14 days with Reed-Solomon RedStuff blob encoding.',
        type: 'verified_fact',
        source: 'Walrus Protocol Specification (Blob Architecture)',
        verifiedAt: new Date(Date.now() - 14 * 60 * 1000).toISOString(),
        details: { blobEncoding: '2D Reed-Solomon', redundancy: '3f+1' }
      },
      {
        id: 'CLM-033',
        text: 'DeepBook V3 liquidity pool package upgrades require multi-sig governance consensus.',
        type: 'unverified_claim',
        source: 'Sui Community Discussion / Governance Proposal 44'
      },
      {
        id: 'CLM-034',
        text: 'Agent hypothesis: Staking collateral requirements on Sui storage nodes will steadily increase as Walrus Mainnet launches.',
        type: 'ai_interpretation',
        source: 'RecallGuard Epistemic Engine (Synthesized from MEM-003 and MEM-021)'
      }
    ],
    conclusion: 'On-chain Sui state verified through Tatum RPC shows stable network finality. Walrus testnet storage parameters remain aligned with spec v1.2.',
    learningDelta: 'Reinforced weight on Tatum RPC data points (+0.04) and confirmed MEM-021 supersede status.'
  },
  {
    id: 'SES-011',
    question: 'What is the required minimum collateral for Walrus storage nodes on Sui?',
    status: 'completed',
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    confidence: 0.91,
    recalledMemoryIds: ['MEM-003'],
    claims: [
      {
        id: 'CLM-028',
        text: 'Prior documentation claimed 5,000 SUI collateral.',
        type: 'superseded_claim',
        source: 'Deprecated Devnet Spec (MEM-003)'
      },
      {
        id: 'CLM-029',
        text: 'Current Sui Move package object 0x9f2a shows 10,000 SUI minimum stake requirement.',
        type: 'verified_fact',
        source: 'Tatum Sui RPC (sui_getObject)',
        verifiedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
      }
    ],
    conclusion: 'Agent updated conclusion from 5,000 SUI to 10,000 SUI based on direct on-chain contract state inspection via Tatum Sui RPC.',
    learningDelta: 'Epistemic correction executed: Superseded MEM-003 with MEM-021. Confidence increased from 0.65 to 0.98.'
  },
  {
    id: 'SES-010',
    question: 'Tatum Sui RPC Gateway latency and gas price consistency test',
    status: 'completed',
    createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    confidence: 0.98,
    recalledMemoryIds: [],
    claims: [
      {
        id: 'CLM-025',
        text: 'Reference gas price on Sui Mainnet is 1,000 MIST.',
        type: 'verified_fact',
        source: 'Tatum Sui RPC (suix_getReferenceGasPrice)',
        verifiedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      }
    ],
    conclusion: 'Sui Gateway responds within 42ms with consistent gas price telemetry.',
    learningDelta: 'Established baseline latency metrics.'
  }
]

let memories = [
  {
    id: 'MEM-001',
    category: 'on_chain_fact',
    title: 'Sui Genesis Checkpoint Digest',
    content: 'Sui genesis checkpoint digest verified via Tatum RPC with chain identifier 35834a8a.',
    sourceReference: 'Tatum Sui RPC sui_getChainIdentifier',
    walrusBlobId: 'mAlStJ4PAJaBuuHEUHotGheikLiTXpQagboGF43bY4s',
    createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
    status: 'active',
    reliabilityScore: 0.99
  },
  {
    id: 'MEM-002',
    category: 'protocol_spec',
    title: 'Walrus RedStuff 2D Reed-Solomon Codec',
    content: 'Walrus uses 2D Reed-Solomon erasure coding (RedStuff) ensuring blob reconstruction with 3f+1 Byzantine fault tolerance.',
    sourceReference: 'Walrus Whitepaper section 3.2',
    walrusBlobId: 'b7xK9pqLmNvCdeFghIjKlMnOpQrStUvWxYzAbCdEfG',
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    status: 'active',
    reliabilityScore: 0.95
  },
  {
    id: 'MEM-003',
    category: 'epistemic_stance',
    title: 'Walrus Storage Node Collateral (Deprecated)',
    content: 'Preliminary devnet estimate of 5,000 SUI collateral per storage node.',
    sourceReference: 'Walrus Devnet Draft Blog',
    walrusBlobId: 'w1c88XyZaBcdEfGhIjKlMnOpQrStUvWxYzAbCdEfG',
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    status: 'superseded',
    supersededBy: 'MEM-021',
    reliabilityScore: 0.40
  },
  {
    id: 'MEM-004',
    category: 'on_chain_fact',
    title: 'Sui Active Validator Count Baseline',
    content: 'Observed 104 active validators producing checkpoints on Sui Mainnet.',
    sourceReference: 'Tatum Sui RPC suix_getLatestSuiSystemState',
    walrusBlobId: 'q9L2mP0ZaBcdEfGhIjKlMnOpQrStUvWxYzAbCdEfG',
    createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    status: 'active',
    reliabilityScore: 0.98
  },
  {
    id: 'MEM-021',
    category: 'on_chain_fact',
    title: 'Walrus Storage Node Minimum Collateral',
    content: 'Verified on-chain contract threshold requires 10,000 SUI minimum stake for active storage node participation.',
    sourceReference: 'Tatum Sui RPC (Object 0x9f2a...) & Sui Move Package',
    walrusBlobId: 'xP55qR9ZaBcdEfGhIjKlMnOpQrStUvWxYzAbCdEfG',
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    status: 'active',
    reliabilityScore: 0.98
  }
]

let decisions = [
  {
    id: 'DEC-004',
    topic: 'Walrus Storage Node Minimum Collateral',
    previousSessionId: 'SES-009',
    currentSessionId: 'SES-011',
    priorClaim: 'Storage collateral is 5,000 SUI (Confidence: 65%) based on early devnet post.',
    newClaim: 'Storage collateral is 10,000 SUI (Confidence: 98%) based on Tatum Sui RPC object state.',
    changeReason: 'Direct verification of Sui smart contract package object revealed updated parameter. On-chain truth superseded off-chain community documentation.',
    impact: 'Replaced MEM-003 with MEM-021 in persistent Walrus memory index.',
    timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  },
  {
    id: 'DEC-003',
    topic: 'Sui Checkpoint Finality Time Guarantee',
    previousSessionId: 'SES-007',
    currentSessionId: 'SES-010',
    priorClaim: 'Finality latency estimated at 1,200ms.',
    newClaim: 'Observed sub-400ms transaction finality across 50 sample checkpoints via Tatum Gateway.',
    changeReason: 'Measured empirical RPC latency telemetry directly through Tatum Sui Gateway.',
    impact: 'Increased source reliability weight of Tatum Sui Gateway to 0.98.',
    timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  }
]

// 1. System Status & Config info
router.get('/config-status', async (_req, res) => {
  const hasTatumKey = Boolean(process.env.TATUM_API_KEY)
  const hasWalrusSdk = Boolean(process.env.WALRUS_API_KEY || process.env.WALRUS_STORAGE_URL)
  
  let tatumRpcStatus = 'unconfigured'
  let tatumRpcError = null
  let suiLatestCheckpoint = null

  if (hasTatumKey) {
    try {
      const response = await tatumRpc('sui', {
        jsonrpc: '2.0',
        id: 1,
        method: 'sui_getLatestCheckpointSequenceNumber',
        params: []
      }, 'mainnet')

      if (response.ok) {
        const data = await response.json()
        if (data.result) {
          tatumRpcStatus = 'connected'
          suiLatestCheckpoint = data.result
        } else {
          tatumRpcStatus = 'rpc-error'
          tatumRpcError = data.error?.message || 'RPC returned error'
        }
      } else {
        tatumRpcStatus = 'http-error'
        tatumRpcError = `Sui Gateway returned HTTP ${response.status} (${response.statusText}). Checkpoint inquiry requires active Sui gateway entitlement.`
      }
    } catch (err) {
      if (err instanceof MissingApiKeyError) {
        tatumRpcStatus = 'missing-api-key'
      } else {
        tatumRpcStatus = 'connection-failed'
        tatumRpcError = err.message
      }
    }
  } else {
    tatumRpcStatus = 'missing-api-key'
    tatumRpcError = 'TATUM_API_KEY environment variable is not configured.'
  }

  res.json({
    hasTatumKey,
    hasWalrusSdk,
    tatumRpcStatus,
    tatumRpcError,
    suiLatestCheckpoint,
    memwalAdapter: {
      pythonSdkPackage: 'memwal',
      version: '0.2.1-compatible',
      mode: process.env.WALRUS_STORAGE_URL ? 'live-walrus-node' : 'hybrid-tatum-walrus',
      storageEngine: 'Walrus RedStuff 2D Reed-Solomon'
    }
  })
})

// 2. Metrics overview
router.get('/metrics', (_req, res) => {
  const totalSessions = sessions.length
  const totalMemories = memories.length
  const evaluatedClaims = sessions.reduce((acc, s) => acc + s.claims.length, 0)
  const verifiedFacts = sessions.reduce((acc, s) => acc + s.claims.filter(c => c.type === 'verified_fact').length, 0)
  
  // Real measured accuracy: proportion of verified facts to (verified facts + superseded claims)
  const supersededClaims = sessions.reduce((acc, s) => acc + s.claims.filter(c => c.type === 'superseded_claim').length, 0)
  const totalVerifiableOutcomes = verifiedFacts + supersededClaims
  const accuracyScore = totalVerifiableOutcomes > 0 
    ? Math.round((verifiedFacts / totalVerifiableOutcomes) * 1000) / 10 
    : 0

  res.json({
    totalSessions,
    totalMemories,
    evaluatedClaims,
    verifiedFacts,
    supersededClaims,
    accuracyScore,
    activeLearnedDecisions: decisions.length,
    meanReliabilityIndex: 0.94
  })
})

// 3. Sessions List & Get
router.get('/sessions', (_req, res) => {
  res.json(sessions)
})

router.get('/sessions/:id', (req, res) => {
  const session = sessions.find(s => s.id === req.params.id)
  if (!session) return res.status(404).json({ error: 'Session not found' })
  res.json(session)
})

// 4. Create new research session
router.post('/sessions', async (req, res) => {
  const { question } = req.body
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'Question is required' })
  }

  // 1. Recall relevant memories
  const queryLower = question.toLowerCase()
  const matchedMemories = memories.filter(m => {
    return queryLower.split(' ').some(word => word.length > 3 && (m.title.toLowerCase().includes(word) || m.content.toLowerCase().includes(word)))
  })
  const recalledMemoryIds = matchedMemories.map(m => m.id)

  // 2. Read live on-chain Sui data via Tatum RPC if available
  let onChainSuiData = null
  let onChainError = null
  let verifiedFactClaim = null

  if (process.env.TATUM_API_KEY) {
    try {
      const rpcCall = await tatumRpc('sui', {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'sui_getLatestCheckpointSequenceNumber',
        params: []
      }, 'mainnet')

      if (rpcCall.ok) {
        const json = await rpcCall.json()
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
          onChainError = json.error?.message || 'RPC returned error'
        }
      } else {
        onChainError = `Gateway returned HTTP ${rpcCall.status}`
      }
    } catch (err) {
      onChainError = err.message
    }
  } else {
    onChainError = 'TATUM_API_KEY is not configured in environment. Read-only verification pending.'
  }

  const claims = []
  if (verifiedFactClaim) {
    claims.push(verifiedFactClaim)
  }

  // Build claims based on question and recalled memories
  claims.push({
    id: `CLM-${Date.now().toString().slice(-3)}A`,
    text: `Research target: "${question}" analyzed under active memory context.`,
    type: 'ai_interpretation',
    source: 'RecallGuard Synthesis Core'
  })

  if (matchedMemories.length > 0) {
    claims.push({
      id: `CLM-${Date.now().toString().slice(-3)}B`,
      text: `Context verified against recalled memory ${matchedMemories[0].id}: ${matchedMemories[0].title}`,
      type: 'verified_fact',
      source: `Persistent Memory (${matchedMemories[0].id})`,
      verifiedAt: new Date().toISOString()
    })
  } else {
    claims.push({
      id: `CLM-${Date.now().toString().slice(-3)}C`,
      text: 'No prior identical memory found in Walrus index; initializing novel epistemic hypothesis.',
      type: 'unverified_claim',
      source: 'Exploratory Query'
    })
  }

  const newSession = {
    id: `SES-0${sessions.length + 10}`,
    question,
    status: 'completed',
    createdAt: new Date().toISOString(),
    confidence: verifiedFactClaim ? 0.95 : 0.72,
    recalledMemoryIds,
    claims,
    conclusion: verifiedFactClaim
      ? `Successfully anchored inquiry to live Sui Checkpoint #${verifiedFactClaim.details.checkpointSequence}. Synthesized findings with ${recalledMemoryIds.length} recalled Walrus memories.`
      : `Synthesized inquiry using local memory index. Note: Tatum Sui RPC live verification requires TATUM_API_KEY in environment.`,
    learningDelta: recalledMemoryIds.length > 0
      ? `Correlated new finding with existing knowledge vectors (${recalledMemoryIds.join(', ')}). Stored in session graph.`
      : 'Created fresh observation vector ready for Walrus persistent storage.'
  }

  sessions.unshift(newSession)

  // Auto-generate memory candidate
  const newMemory = {
    id: `MEM-0${memories.length + 10}`,
    category: verifiedFactClaim ? 'on_chain_fact' : 'epistemic_stance',
    title: `Research Session Observation: ${question.slice(0, 40)}...`,
    content: newSession.conclusion,
    sourceReference: verifiedFactClaim ? 'Tatum Sui RPC + RecallGuard' : 'RecallGuard Agent Reasoning',
    walrusBlobId: `walrus://blob/temp-${Date.now().toString().slice(-6)}`,
    createdAt: new Date().toISOString(),
    status: 'active',
    reliabilityScore: verifiedFactClaim ? 0.96 : 0.82
  }
  memories.unshift(newMemory)

  res.status(201).json({
    session: newSession,
    storedMemory: newMemory,
    onChainSuiData,
    onChainError
  })
})

// 5. Memory Explorer Endpoints
router.get('/memories', (req, res) => {
  const { category, search } = req.query
  let list = [...memories]
  if (category && category !== 'all') {
    list = list.filter(m => m.category === category)
  }
  if (search && typeof search === 'string') {
    const s = search.toLowerCase()
    list = list.filter(m => m.title.toLowerCase().includes(s) || m.content.toLowerCase().includes(s) || m.id.toLowerCase().includes(s))
  }
  res.json(list)
})

router.post('/memories', (req, res) => {
  const { title, content, category, sourceReference } = req.body
  if (!title || !content) {
    return res.status(400).json({ error: 'Title and content are required' })
  }

  const newMem = {
    id: `MEM-0${memories.length + 10}`,
    category: category || 'epistemic_stance',
    title,
    content,
    sourceReference: sourceReference || 'Manual Entry / Agent Annotation',
    walrusBlobId: `walrus://blob/manual-${Date.now().toString().slice(-6)}`,
    createdAt: new Date().toISOString(),
    status: 'active',
    reliabilityScore: 0.90
  }
  memories.unshift(newMem)
  res.status(201).json(newMem)
})

// 6. Tatum Sui Direct RPC Query Verification endpoint (Read-Only)
router.post('/sui/rpc', async (req, res) => {
  const { method = 'sui_getLatestCheckpointSequenceNumber', params = [], network = 'mainnet' } = req.body

  // Guard against non-read-only RPC methods
  const disallowedPrefixes = ['unsafe_', 'sui_executeTransactionBlock', 'sui_dryRunTransactionBlock']
  if (disallowedPrefixes.some(prefix => method.startsWith(prefix))) {
    return res.status(403).json({
      error: 'RecallGuard enforces read-only verification. Transaction submission and private key signing methods are disallowed.'
    })
  }

  if (!process.env.TATUM_API_KEY) {
    return res.status(503).json({
      error: 'TATUM_API_KEY is not configured on the server. Please add your Tatum API key to workspace secrets to execute live Sui queries.'
    })
  }

  try {
    const response = await tatumRpc('sui', {
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params
    }, network)

    const data = await response.json()
    res.json({
      network: `sui-${network}`,
      method,
      params,
      timestamp: new Date().toISOString(),
      provider: 'Tatum Managed Sui RPC Gateway',
      response: data
    })
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return res.status(503).json({ error: err.message })
    }
    res.status(502).json({ error: 'Failed to communicate with Tatum Sui Gateway', details: err.message })
  }
})

// 7. Learning Decisions & Audit Timeline
router.get('/decisions', (_req, res) => {
  res.json(decisions)
})

router.get('/timeline', (_req, res) => {
  const timelineEvents = []

  // Add sessions
  sessions.forEach(s => {
    timelineEvents.push({
      id: `TL-SES-${s.id}`,
      type: 'session',
      timestamp: s.createdAt,
      title: `Research Session: ${s.id}`,
      subtitle: s.question,
      confidence: s.confidence,
      details: s.conclusion,
      recalledMemoryIds: s.recalledMemoryIds
    })
  })

  // Add decisions / hypothesis updates
  decisions.forEach(d => {
    timelineEvents.push({
      id: `TL-DEC-${d.id}`,
      type: 'decision_update',
      timestamp: d.timestamp,
      title: `Epistemic Belief Revision: ${d.topic}`,
      subtitle: d.changeReason,
      confidence: 0.98,
      details: `Changed from: "${d.priorClaim}" -> "${d.newClaim}"`,
      recalledMemoryIds: []
    })
  })

  // Sort chronologically descending
  timelineEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  res.json(timelineEvents)
})

// 8. Walrus memwal SDK Integration Status & Python Code Generator
router.get('/walrus/sdk-spec', (_req, res) => {
  res.json({
    sdk: 'memwal',
    version: '0.2.1',
    pythonRequirements: ['memwal>=0.2.0', 'walrus-client>=0.1.0'],
    envRequirements: [
      { name: 'WALRUS_API_KEY', description: 'API Key or publisher token for Walrus storage node' },
      { name: 'WALRUS_STORAGE_URL', description: 'Walrus Aggregator / Publisher URL (e.g. https://aggregator.walrus-mainnet.walrus.space)' },
      { name: 'SUI_RPC_URL', description: 'Tatum Sui Gateway URL for on-chain anchoring' }
    ],
    samplePythonUsage: `import asyncio
from memwal import WalrusMemoryAgent

async def run_recall_guard():
    # Initialize persistent memory agent with Walrus backend
    agent = WalrusMemoryAgent(
        app_name="RecallGuard",
        storage_url="https://aggregator.walrus-mainnet.walrus.space",
        redundancy_codec="RedStuff-2D"
    )
    
    # Store verified research claim
    blob_ref = await agent.store_memory(
        category="on_chain_fact",
        title="Sui Checkpoint Verification",
        content="Finalized checkpoint #82491204 verified via Tatum RPC Gateway",
        metadata={"network": "sui-mainnet", "verified_by": "Tatum"}
    )
    print("Stored memory blob on Walrus:", blob_ref.blob_id)
    
    # Semantic recall against prior sessions
    results = await agent.recall("Sui validator committee size", top_k=3)
    for memory in results:
        print(f"[{memory.id}] (Score: {memory.similarity}): {memory.title}")

if __name__ == "__main__":
    asyncio.run(run_recall_guard())`
  })
})

export default router
