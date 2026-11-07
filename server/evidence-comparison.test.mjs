import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildRevisionOutcome, compareResearchEvidence } from './evidence-comparison.mjs'

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

describe('evidence comparison', () => {
  it('treats identical checkpoint observations as consistent', () => {
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
  })

  it('treats a newer checkpoint as an update, not a contradiction', () => {
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
  })

  it('flags a changed chain identifier for further verification', () => {
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
  })

  it('excludes demo records from live comparisons', () => {
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
  })

  it('flags a changed object digest as a value change without committing a revision', () => {
    const previous = {
      id: 'SES-010',
      provenance: 'live_production',
      status: 'completed',
      createdAt: olderTime,
      researchPlan: { capability: 'sui_object_lookup' },
      onChainSuiData: {
        network: 'sui-mainnet',
        objectId: '0xabc',
        object: { digest: 'digest-old' },
        retrievedAt: olderTime
      }
    }

    const current = {
      id: 'SES-011',
      provenance: 'live_production',
      status: 'completed',
      createdAt: newerTime,
      researchPlan: { capability: 'sui_object_lookup' },
      onChainSuiData: {
        network: 'sui-mainnet',
        objectId: '0xABC',
        object: { digest: 'digest-new' },
        retrievedAt: newerTime
      }
    }

    const result = compareResearchEvidence(current, [previous])

    assert.equal(result.status, 'value_changed')
    assert.equal(result.revision, null)
    assert.equal(result.previousValue, 'digest-old')
    assert.equal(result.currentValue, 'digest-new')
  })

  it('treats an advanced epoch as an update, not a contradiction', () => {
    const previous = {
      id: 'SES-012',
      provenance: 'live_production',
      status: 'completed',
      createdAt: olderTime,
      researchPlan: { capability: 'sui_network_status' },
      onChainSuiData: {
        network: 'sui-mainnet',
        serviceInfo: { epoch: '10' },
        retrievedAt: olderTime
      }
    }

    const current = {
      id: 'SES-013',
      provenance: 'live_production',
      status: 'completed',
      createdAt: newerTime,
      researchPlan: { capability: 'sui_network_status' },
      onChainSuiData: {
        network: 'sui-mainnet',
        serviceInfo: { epoch: '11' },
        retrievedAt: newerTime
      }
    }

    const result = compareResearchEvidence(current, [previous])

    assert.equal(result.status, 'newer_observation')
    assert.equal(result.revision, null)
  })

  it('reports a regressing checkpoint without committing a revision', () => {
    const previous = makeSession({
      id: 'SES-014',
      value: 105,
      timestamp: olderTime
    })

    const current = makeSession({
      id: 'SES-015',
      value: 100,
      timestamp: newerTime
    })

    const result = compareResearchEvidence(current, [previous])

    assert.equal(result.status, 'unexpected_regression')
    assert.equal(result.revision, null)
  })

  it('yields insufficient evidence for memory-only analysis', () => {
    const current = {
      id: 'SES-016',
      provenance: 'live_production',
      status: 'completed',
      createdAt: newerTime,
      researchPlan: { capability: 'memory_and_scope_analysis' },
      onChainSuiData: null
    }

    const previous = makeSession({
      id: 'SES-017',
      value: 100,
      timestamp: olderTime
    })

    const result = compareResearchEvidence(current, [previous])

    assert.equal(result.status, 'insufficient_evidence')
    assert.equal(result.revision, null)
  })

  it('turns value_changed into a pending candidate, never a committed revision', () => {
    const previous = makeSession({
      id: 'SES-020',
      capability: 'sui_chain_identifier',
      value: 'chain-old',
      timestamp: olderTime
    })

    const current = {
      id: 'SES-021',
      provenance: 'live_production',
      status: 'completed',
      createdAt: newerTime,
      researchPlan: { capability: 'sui_chain_identifier' },
      onChainSuiData: {
        network: 'sui-mainnet',
        operation: 'sui_chain_identifier',
        chainId: 'chain-new',
        retrievedAt: newerTime,
        evidenceStatus: 'retrieved_from_tatum',
        cryptographicallyVerified: false
      }
    }

    const comparison = compareResearchEvidence(current, [previous])
    assert.equal(comparison.status, 'value_changed')

    const outcome = buildRevisionOutcome(comparison, {
      evidence: current.onChainSuiData,
      capability: 'sui_chain_identifier',
      currentSessionId: current.id,
      candidateId: 'CAND-TEST-001'
    })

    assert.equal(outcome.committedRevision, null)
    assert.ok(outcome.candidate)
    assert.equal(outcome.candidate.candidateType, 'evidence_change_candidate')
    assert.equal(outcome.candidate.status, 'pending_verification')
    assert.equal(outcome.candidate.verificationStatus, 'pending_independent_verification')
    assert.equal(outcome.candidate.previousValue, 'chain-old')
    assert.equal(outcome.candidate.currentValue, 'chain-new')
    assert.equal(outcome.candidate.previousSessionId, 'SES-020')
    assert.equal(outcome.candidate.currentSessionId, 'SES-021')
    assert.equal(outcome.candidate.sourceEvidence.network, 'sui-mainnet')
    assert.equal(outcome.candidate.sourceEvidence.cryptographicallyVerified, false)
  })

  it('creates neither candidate nor revision on checkpoint advance', () => {
    const previous = makeSession({
      id: 'SES-022',
      value: 100,
      timestamp: olderTime
    })

    const current = makeSession({
      id: 'SES-023',
      value: 105,
      timestamp: newerTime
    })

    const comparison = compareResearchEvidence(current, [previous])
    assert.equal(comparison.status, 'newer_observation')

    const outcome = buildRevisionOutcome(comparison, {
      evidence: current.onChainSuiData,
      capability: 'sui_checkpoint_status',
      currentSessionId: current.id,
      candidateId: 'CAND-TEST-002'
    })

    assert.equal(outcome.candidate, null)
    assert.equal(outcome.committedRevision, null)
  })

  it('creates neither candidate nor revision on checkpoint regression', () => {
    const previous = makeSession({
      id: 'SES-024',
      value: 105,
      timestamp: olderTime
    })

    const current = makeSession({
      id: 'SES-025',
      value: 100,
      timestamp: newerTime
    })

    const comparison = compareResearchEvidence(current, [previous])
    assert.equal(comparison.status, 'unexpected_regression')

    const outcome = buildRevisionOutcome(comparison, {
      evidence: current.onChainSuiData,
      capability: 'sui_checkpoint_status',
      currentSessionId: current.id,
      candidateId: 'CAND-TEST-003'
    })

    assert.equal(outcome.candidate, null)
    assert.equal(outcome.committedRevision, null)
  })

  it('leaves consistent and insufficient evidence with nothing committable', () => {
    const previous = makeSession({
      id: 'SES-026',
      value: 100,
      timestamp: olderTime
    })

    const consistent = makeSession({
      id: 'SES-027',
      value: 100,
      timestamp: newerTime
    })

    const consistentOutcome = buildRevisionOutcome(
      compareResearchEvidence(consistent, [previous]),
      { currentSessionId: consistent.id, candidateId: 'CAND-TEST-004' }
    )
    assert.equal(consistentOutcome.candidate, null)
    assert.equal(consistentOutcome.committedRevision, null)

    const memoryOnly = {
      id: 'SES-028',
      provenance: 'live_production',
      status: 'completed',
      createdAt: newerTime,
      researchPlan: { capability: 'memory_and_scope_analysis' },
      onChainSuiData: null
    }

    const insufficientOutcome = buildRevisionOutcome(
      compareResearchEvidence(memoryOnly, [previous]),
      { currentSessionId: memoryOnly.id, candidateId: 'CAND-TEST-005' }
    )
    assert.equal(insufficientOutcome.candidate, null)
    assert.equal(insufficientOutcome.committedRevision, null)
  })
})
