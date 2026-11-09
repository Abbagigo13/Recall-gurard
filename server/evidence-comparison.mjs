
const COMPARABLE_CAPABILITIES = new Set([
  'sui_checkpoint_status',
  'sui_chain_identifier',
  'sui_object_lookup',
  'sui_network_status',
  'sui_reference_gas_price'
])

function normalize(value) {
  return String(value ?? '').trim().toLowerCase()
}

function getEvidenceIdentity(session) {
  const plan = session?.researchPlan
  const evidence = session?.onChainSuiData

  if (!plan || !evidence || !COMPARABLE_CAPABILITIES.has(plan.capability)) {
    return null
  }

  const network = normalize(evidence.network || plan.network)

  switch (plan.capability) {
    case 'sui_checkpoint_status':
      return {
        subject: `sui:${network}:checkpoint`,
        property: 'sequence',
        value: evidence.checkpointSequence,
        timestamp: evidence.retrievedAt
      }

    case 'sui_chain_identifier':
      return {
        subject: `sui:${network}:chain`,
        property: 'chain_id',
        value: evidence.chainId,
        timestamp: evidence.retrievedAt
      }

    case 'sui_object_lookup':
      return {
        subject: `sui:${network}:object:${normalize(evidence.objectId)}`,
        property: 'object_digest',
        value: evidence.object?.digest,
        timestamp: evidence.retrievedAt
      }

    case 'sui_network_status':
      return {
        subject: `sui:${network}:epoch`,
        property: 'epoch',
        value: evidence.serviceInfo?.epoch,
        timestamp: evidence.retrievedAt
      }

    case 'sui_reference_gas_price':
      return {
        subject: `sui:${network}:gas`,
        property: 'reference_gas_price',
        value: evidence.referenceGasPrice,
        timestamp: evidence.retrievedAt
      }

    default:
      return null
  }
}

function isValidObservation(identity) {
  return Boolean(
    identity &&
    identity.subject &&
    identity.property &&
    identity.value !== null &&
    identity.value !== undefined &&
    identity.value !== ''
  )
}

export function compareResearchEvidence(newSession, previousSessions) {
  const current = getEvidenceIdentity(newSession)

  if (!isValidObservation(current)) {
    return {
      status: 'insufficient_evidence',
      reason: 'The new session does not contain a comparable structured observation.',
      revision: null
    }
  }

  const candidates = (previousSessions ?? [])
    .filter(session =>
      session &&
      session.id !== newSession.id &&
      session.status === 'completed' &&
      session.provenance === 'live_production'
    )
    .map(session => ({
      session,
      identity: getEvidenceIdentity(session)
    }))
    .filter(item =>
      isValidObservation(item.identity) &&
      item.identity.subject === current.subject &&
      item.identity.property === current.property
    )
    .sort((a, b) =>
      new Date(b.identity.timestamp || b.session.createdAt).getTime() -
      new Date(a.identity.timestamp || a.session.createdAt).getTime()
    )

  if (candidates.length === 0) {
    return {
      status: 'no_comparable_prior_evidence',
      reason: 'No previous live observation exists for the same subject and property.',
      revision: null
    }
  }

  const previous = candidates[0]
  const previousValue = String(previous.identity.value)
  const currentValue = String(current.value)

  if (previousValue === currentValue) {
    return {
      status: 'consistent_observation',
      reason: 'The new observation matches the most recent comparable live observation.',
      revision: null,
      comparedSessionId: previous.session.id
    }
  }

  const previousTime = new Date(
    previous.identity.timestamp || previous.session.createdAt
  ).getTime()

  const currentTime = new Date(
    current.timestamp || newSession.createdAt
  ).getTime()

  if (
    !Number.isFinite(previousTime) ||
    !Number.isFinite(currentTime) ||
    currentTime <= previousTime
  ) {
    return {
      status: 'insufficient_evidence',
      reason: 'Observation timestamps do not establish that the new observation is later.',
      revision: null,
      comparedSessionId: previous.session.id
    }
  }

  if (current.property === 'sequence' || current.property === 'epoch') {
    const oldNumber = Number(previous.identity.value)
    const newNumber = Number(current.value)

    if (
      !Number.isSafeInteger(oldNumber) ||
      !Number.isSafeInteger(newNumber)
    ) {
      return {
        status: 'insufficient_evidence',
        reason: 'Checkpoint or epoch values are not valid safe integers.',
        revision: null,
        comparedSessionId: previous.session.id
      }
    }

    if (newNumber < oldNumber) {
      return {
        status: 'unexpected_regression',
        reason: 'The newer observation reports a lower checkpoint or epoch value.',
        revision: null,
        comparedSessionId: previous.session.id
      }
    }

    if (newNumber > oldNumber) {
      return {
        status: 'newer_observation',
        reason: 'The checkpoint or epoch advanced. This is an update, not a contradiction.',
        revision: null,
        comparedSessionId: previous.session.id
      }
    }
  }

  if (current.property === 'reference_gas_price') {
    // The reference gas price is reset every epoch and can legitimately go
    // up or down, so a different later value is an update, not a conflict.
    return {
      status: 'newer_observation',
      reason: 'The reference gas price is set per epoch and can change. This is an update, not a contradiction.',
      revision: null,
      comparedSessionId: previous.session.id
    }
  }

  return {
    status: 'value_changed',
    reason: 'A newer observation for the same subject and property has a different value. Independent verification is still required before treating this as a contradiction.',
    revision: null,
    comparedSessionId: previous.session.id,
    previousValue,
    currentValue
  }
}

/**
 * Map an evidence comparison to a revision outcome.
 *
 * A `value_changed` comparison produces a pending evidence-change candidate,
 * never a committed belief revision: the comparator explicitly requires
 * independent verification first. Every other status produces neither a
 * candidate nor a revision. The `committedRevision` slot exists so a future
 * verified-commit path has a separate, explicit home; this path always
 * leaves it null and never supersedes stored memories.
 */
export function buildRevisionOutcome(comparison, context = {}) {
  if (!comparison || comparison.status !== 'value_changed') {
    return { candidate: null, committedRevision: null }
  }

  const evidence = context.evidence ?? null

  const candidate = {
    id: context.candidateId ?? `CAND-${Date.now().toString().slice(-6)}`,
    candidateType: 'evidence_change_candidate',
    status: 'pending_verification',
    verificationStatus: 'pending_independent_verification',
    provenance: 'live_production',
    capability: context.capability ?? null,
    previousSessionId: comparison.comparedSessionId ?? null,
    currentSessionId: context.currentSessionId ?? null,
    previousValue: comparison.previousValue ?? null,
    currentValue: comparison.currentValue ?? null,
    sourceEvidence: evidence
      ? {
        capability: context.capability ?? null,
        network: evidence.network ?? null,
        operation: evidence.operation ?? null,
        retrievedAt: evidence.retrievedAt ?? null,
        evidenceStatus: evidence.evidenceStatus ?? null,
        cryptographicallyVerified: false
      }
      : null,
    reason: comparison.reason ?? null,
    createdAt: new Date().toISOString()
  }

  return { candidate, committedRevision: null }
}
