
const STOP_WORDS = new Set([
  'what', 'when', 'where', 'which', 'who', 'whom', 'whose',
  'does', 'did', 'doing', 'have', 'has', 'had', 'will', 'would',
  'could', 'should', 'can', 'the', 'and', 'for', 'from', 'with',
  'that', 'this', 'these', 'those', 'about', 'into', 'through',
  'please', 'explain', 'tell', 'show', 'find', 'check', 'verify',
  'research', 'latest', 'current', 'give', 'me'
])

const SUI_NETWORK_TERMS =
  /\bsui\b|\bcheckpoint(s)?\b|\bepoch(s)?\b|\bchain identifier\b/i

const SUI_OBJECT_TERMS =
  /\b(object|package|object id|objectid)\b/i

const OBJECT_ID_PATTERN =
  /\b0x[a-fA-F0-9]{1,64}\b/

export function buildResearchPlan(question) {
  const cleanQuestion = question.trim()
  const normalized = cleanQuestion.toLowerCase()

  const objectId = cleanQuestion.match(OBJECT_ID_PATTERN)?.[0] ?? null

  let capability = 'memory_and_scope_analysis'
  let evidenceSources = ['local_memory_index']
  let evidenceRequirements = [
    'Check whether relevant prior memories exist.',
    'Identify what evidence is missing before drawing a conclusion.'
  ]

  if (
    objectId &&
    SUI_NETWORK_TERMS.test(normalized) &&
    SUI_OBJECT_TERMS.test(normalized)
  ) {
    capability = 'sui_object_lookup'
    evidenceSources = ['tatum_sui_grpc', 'local_memory_index']
    evidenceRequirements = [
      'Retrieve the specified Sui object from the selected network.',
      'Record the returned object metadata and retrieval timestamp.',
      'Do not describe retrieval as independent cryptographic verification.'
    ]
  } else if (
    /\b(checkpoint|checkpoints)\b|\blatest sui\b|\bsui network status\b/i.test(normalized)
  ) {
    capability = 'sui_checkpoint_status'
    evidenceSources = ['tatum_sui_grpc', 'local_memory_index']
    evidenceRequirements = [
      'Retrieve current Sui checkpoint metadata.',
      'Record checkpoint sequence, digest and available epoch metadata.',
      'Do not infer unrelated facts from checkpoint metadata.'
    ]
  } else if (/\b(chain identifier|chain id)\b/i.test(normalized) && /\bsui\b/i.test(normalized)) {
    capability = 'sui_chain_identifier'
    evidenceSources = ['tatum_sui_grpc', 'local_memory_index']
    evidenceRequirements = [
      'Retrieve the Sui chain identifier.',
      'Record the network and provider.',
      'Do not treat successful retrieval as proof of unrelated claims.'
    ]
  } else if (/\b(epoch|epochs)\b/i.test(normalized) && /\bsui\b/i.test(normalized)) {
    capability = 'sui_network_status'
    evidenceSources = ['tatum_sui_grpc', 'local_memory_index']
    evidenceRequirements = [
      'Retrieve available Sui network and epoch metadata.',
      'Record the provider and retrieval timestamp.'
    ]
  }

  const tokens = normalized
    .replace(/[^a-z0-9_-]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 3 && !STOP_WORDS.has(word))

  return {
    planner: 'deterministic_capability_router',
    plannerVersion: '1.0.0',
    question: cleanQuestion,
    capability,
    evidenceSources,
    evidenceRequirements,
    searchTerms: [...new Set(tokens)],
    requestedObjectId: objectId,
    requiresTatum: evidenceSources.includes('tatum_sui_grpc'),
    requiresWalrusRecall: false,
    aiModelUsed: false,
    planningStatus: 'completed'
  }
}

export function rankMemories(question, memories, limit = 10) {
  const plan = buildResearchPlan(question)
  const terms = plan.searchTerms

  if (!terms.length) return []

  // Restrict recall to memories that match the research capability.
  function isCompatibleMemory(memory) {
    const text = `
      ${memory.title ?? ''}
      ${memory.content ?? ''}
    `.toLowerCase()

    switch (plan.capability) {
      case 'sui_checkpoint_status':
        return (
          /\bcheckpoint(s)?\b/.test(text) &&
          !/\b(object lookup|sui_object_lookup)\b/.test(text)
        )

      case 'sui_object_lookup':
        return (
          /\b(object lookup|sui_object_lookup|object id|objectid)\b/.test(text) ||
          Boolean(
            plan.requestedObjectId &&
            text.includes(plan.requestedObjectId.toLowerCase())
          )
        )

      case 'sui_chain_identifier':
        return /\b(chain identifier|chain id)\b/.test(text)

      case 'sui_network_status':
        return /\b(epoch|network status|service info)\b/.test(text)

      default:
        return true
    }
  }

  return memories
    .filter(isCompatibleMemory)
    .map(memory => {
      const title = (memory.title ?? '').toLowerCase()
      const content = (memory.content ?? '').toLowerCase()

      const matchedTerms = terms.filter(term =>
        title.includes(term) || content.includes(term)
      )

      const titleMatches = matchedTerms.filter(term =>
        title.includes(term)
      )

      const score =
        (titleMatches.length * 2 + matchedTerms.length) /
        (terms.length * 3)

      return {
        memory,
        score,
        matchedTerms,
        titleMatches
      }
    })
    .filter(result =>
      result.matchedTerms.length >= 2 &&
      result.score >= 0.25
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}