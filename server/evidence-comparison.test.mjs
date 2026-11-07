
import assert from 'node:assert/strict'
import { compareResearchEvidence } from './evidence-comparison.mjs'

function makeSession({
  id,
  capability = 'sui_checkpoint_status',
  value,
  timestamp,
  provenance = 'live_production'
}) {
  const isCheckpoint = capability === 'sui_checkpoint_status'
  const isChainId = capability === 'sui_chain_identifier'

  return {
    id,
    provenance,
    status: 'completed',
    createdAt: timestamp,
    researchPlan: { capability },
    onChainSuiData: {
      network: 'sui-mainnet',
      retrievedAt: timestamp,
      ...(isCheckpoint && { checkpointSequence: value }),
      ...(isChainId && { chainId: value })
    }
  }
}

const olderTime = '2026-11-06T10:00:00.000Z'
const newerTime = '2026-11-06T11:00:00.000Z'

// Test 1: Identical checkpoint observations.
{
  const previous = makeSession({
    id: 'SES-001',
    value: 100,
    timestamp: olderTime
  })

  const current = makeSession({
    id: 'SES-002',
    value: 100,
    timestamp: newerTime
  })

  const result = compareResearchEvidence(current, [previous])

  assert.equal(result.status, 'consistent_observation')
  assert.equal(result.revision, null)
  console.log('PASS: Identical observations are consistent')
}

// Test 2: A newer checkpoint is an update, not a contradiction.
{
  const previous = makeSession({
    id: 'SES-003',
    value: 100,
    timestamp: olderTime
  })

  const current = makeSession({
    id: 'SES-004',
    value: 105,
    timestamp: newerTime
  })

  const result = compareResearchEvidence(current, [previous])

  assert.equal(result.status, 'newer_observation')
  assert.equal(result.revision, null)
  console.log('PASS: Newer checkpoint is not classified as a contradiction')
}

// Test 3: A changed chain identifier requires further verification.
{
  const previous = makeSession({
    id: 'SES-005',
    capability: 'sui_chain_identifier',
    value: 'chain-old',
    timestamp: olderTime
  })

  const current = makeSession({
    id: 'SES-006',
    capability: 'sui_chain_identifier',
    value: 'chain-new',
    timestamp: newerTime
  })

  const result = compareResearchEvidence(current, [previous])

  assert.equal(result.status, 'value_changed')
  assert.equal(result.revision, null)
  console.log('PASS: Changed chain identifier is flagged for further verification')
}

// Test 4: Demo records cannot become live comparison evidence.
{
  const demoPrevious = makeSession({
    id: 'DEMO-001',
    value: 100,
    timestamp: olderTime,
    provenance: 'demo_seed'
  })

  const current = makeSession({
    id: 'SES-007',
    value: 105,
    timestamp: newerTime
  })

  const result = compareResearchEvidence(current, [demoPrevious])

  assert.equal(result.status, 'no_comparable_prior_evidence')
  assert.equal(result.revision, null)
  console.log('PASS: Demo records are excluded from live comparisons')
}

console.log('\nAll evidence comparison tests passed.')
