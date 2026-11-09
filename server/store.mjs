// SQLite persistence adapter (Phase 3) using Node.js built-in node:sqlite.
// No extra dependencies. Never stores API keys or credentials: only the
// session/memory/decision/candidate/evidence shapes already served by the API.

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'

export const SCHEMA_VERSION = 2

// Stable public error codes. Raw driver messages (table/column names,
// filesystem paths, OS errors) are never safe for HTTP responses, so the
// API returns only these codes plus a fixed message. Raw detail stays
// server-side in logs via console.error at the failure site.
export const PERSISTENCE_ERROR_CODE = 'PERSISTENCE_UNAVAILABLE'
export const PERSISTENCE_UNHEALTHY_CODE = 'PERSISTENCE_UNHEALTHY'

export function publicPersistenceError(action) {
  return { error: `Failed to persist ${action}`, code: PERSISTENCE_ERROR_CODE }
}

const PROVENANCE_CHECK =
  "provenance IN ('demo_seed', 'live_production')"

function boolToInt(value) {
  return value === true ? 1 : 0
}

function intToBool(value) {
  return value === 1
}

function toJson(value) {
  if (value === undefined || value === null) return null
  return JSON.stringify(value)
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS research_sessions (
    id TEXT PRIMARY KEY,
    provenance TEXT NOT NULL CHECK (${PROVENANCE_CHECK}),
    question TEXT NOT NULL,
    network TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    confidence REAL,
    confidence_status TEXT,
    research_plan_json TEXT,
    onchain_data_json TEXT,
    recalled_memory_ids_json TEXT,
    claims_json TEXT,
    conclusion TEXT,
    learning_delta TEXT,
    evidence_comparison_json TEXT,
    revision_candidate_json TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    provenance TEXT NOT NULL CHECK (${PROVENANCE_CHECK}),
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source_reference TEXT,
    walrus_blob_id TEXT,
    walrus_sui_object_id TEXT,
    walrus_aggregator_url TEXT,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    superseded_by TEXT,
    reliability_score REAL,
    confidence REAL,
    confidence_status TEXT,
    storage_verified INTEGER NOT NULL DEFAULT 0,
    storage_status TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    provenance TEXT NOT NULL CHECK (${PROVENANCE_CHECK}),
    topic TEXT NOT NULL,
    previous_session_id TEXT,
    current_session_id TEXT,
    prior_claim TEXT,
    new_claim TEXT,
    change_reason TEXT,
    impact TEXT,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS revision_candidates (
    id TEXT PRIMARY KEY,
    candidate_type TEXT NOT NULL DEFAULT 'evidence_change_candidate',
    status TEXT NOT NULL DEFAULT 'pending_verification',
    verification_status TEXT,
    provenance TEXT NOT NULL CHECK (${PROVENANCE_CHECK}),
    capability TEXT,
    previous_session_id TEXT,
    current_session_id TEXT,
    previous_value TEXT,
    current_value TEXT,
    source_evidence_json TEXT,
    reason TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolution TEXT,
    FOREIGN KEY (previous_session_id) REFERENCES research_sessions (id) ON DELETE RESTRICT,
    FOREIGN KEY (current_session_id) REFERENCES research_sessions (id) ON DELETE RESTRICT
  )`,

  `CREATE TABLE IF NOT EXISTS evidence_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES research_sessions (id) ON DELETE RESTRICT,
    capability TEXT,
    network TEXT,
    evidence_status TEXT,
    retrieved_at TEXT,
    payload_json TEXT,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    provenance TEXT,
    details_json TEXT,
    created_at TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_sessions_provenance
    ON research_sessions (provenance, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_provenance
    ON memories (provenance, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_category
    ON memories (category)`,
  `CREATE INDEX IF NOT EXISTS idx_decisions_provenance
    ON decisions (provenance, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_candidates_status
    ON revision_candidates (status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_candidates_session
    ON revision_candidates (current_session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_session
    ON evidence_records (session_id)`,

  `CREATE TABLE IF NOT EXISTS ai_analyses (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES research_sessions (id) ON DELETE RESTRICT,
    model TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'meta',
    prompt_version TEXT NOT NULL,
    status TEXT NOT NULL,
    analysis_json TEXT,
    latency_ms INTEGER,
    error_code TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (session_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_ai_analyses_session
    ON ai_analyses (session_id)`
]

// Append-only audit log is enforced at the database level, not just by
// convention in the application layer. INSERT works normally; UPDATE and
// DELETE abort with an error. Triggers use IF NOT EXISTS so they apply to
// both fresh and pre-existing databases on every init.
const TRIGGER_STATEMENTS = [
  `CREATE TRIGGER IF NOT EXISTS trg_audit_events_no_update
   BEFORE UPDATE ON audit_events
   BEGIN
     SELECT RAISE(ABORT, 'audit_events is append-only: UPDATE rejected');
   END`,

  `CREATE TRIGGER IF NOT EXISTS trg_audit_events_no_delete
   BEFORE DELETE ON audit_events
   BEGIN
     SELECT RAISE(ABORT, 'audit_events is append-only: DELETE rejected');
   END`
]

// Ordered schema migrations keyed by the version they migrate FROM.
// Each entry migrates the database one version forward and must leave
// schema_meta.schema_version at the new version. Unknown versions throw
// instead of being silently misread.
const MIGRATIONS = {
  // v1 -> v2: add the ai_analyses table for Meta AI research analyses.
  // Additive only: no existing table is altered, no rows are touched.
  // IF NOT EXISTS keeps it idempotent (fresh databases already created the
  // table via SCHEMA_STATEMENTS above).
  1(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS ai_analyses (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES research_sessions (id) ON DELETE RESTRICT,
      model TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'meta',
      prompt_version TEXT NOT NULL,
      status TEXT NOT NULL,
      analysis_json TEXT,
      latency_ms INTEGER,
      error_code TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (session_id)
    )`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_analyses_session
      ON ai_analyses (session_id)`)
  }
}

// ---------------------------------------------------------------------------
// Row <-> object mapping (reconstructs the exact API shapes)
// ---------------------------------------------------------------------------

function mapSessionRow(row) {
  return {
    id: row.id,
    provenance: row.provenance,
    question: row.question,
    status: row.status,
    createdAt: row.created_at,
    confidence: row.confidence,
    confidenceStatus: row.confidence_status,
    researchPlan: row.research_plan_json ? JSON.parse(row.research_plan_json) : undefined,
    onChainSuiData: row.onchain_data_json ? JSON.parse(row.onchain_data_json) : null,
    recalledMemoryIds: row.recalled_memory_ids_json ? JSON.parse(row.recalled_memory_ids_json) : [],
    claims: row.claims_json ? JSON.parse(row.claims_json) : [],
    conclusion: row.conclusion,
    learningDelta: row.learning_delta,
    ...(row.evidence_comparison_json
      ? { evidenceComparison: JSON.parse(row.evidence_comparison_json) }
      : {}),
    ...(row.revision_candidate_json
      ? { revisionCandidate: JSON.parse(row.revision_candidate_json) }
      : {})
  }
}

function mapMemoryRow(row) {
  return {
    id: row.id,
    provenance: row.provenance,
    category: row.category,
    title: row.title,
    content: row.content,
    sourceReference: row.source_reference,
    walrusBlobId: row.walrus_blob_id,
    walrusSuiObjectId: row.walrus_sui_object_id,
    walrusAggregatorUrl: row.walrus_aggregator_url,
    createdAt: row.created_at,
    status: row.status,
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    reliabilityScore: row.reliability_score,
    ...(row.confidence !== null && row.confidence !== undefined
      ? { confidence: row.confidence } : {}),
    ...(row.confidence_status ? { confidenceStatus: row.confidence_status } : {}),
    storageVerified: intToBool(row.storage_verified),
    ...(row.storage_status ? { storageStatus: row.storage_status } : {})
  }
}

function mapDecisionRow(row) {
  return {
    id: row.id,
    provenance: row.provenance,
    topic: row.topic,
    previousSessionId: row.previous_session_id,
    currentSessionId: row.current_session_id,
    priorClaim: row.prior_claim,
    newClaim: row.new_claim,
    changeReason: row.change_reason,
    impact: row.impact,
    timestamp: row.created_at
  }
}

function mapCandidateRow(row) {
  return {
    id: row.id,
    candidateType: row.candidate_type,
    status: row.status,
    verificationStatus: row.verification_status,
    provenance: row.provenance,
    capability: row.capability,
    previousSessionId: row.previous_session_id,
    currentSessionId: row.current_session_id,
    previousValue: row.previous_value,
    currentValue: row.current_value,
    sourceEvidence: row.source_evidence_json
      ? JSON.parse(row.source_evidence_json)
      : null,
    reason: row.reason,
    createdAt: row.created_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    ...(row.resolution ? { resolution: row.resolution } : {})
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function mapAiAnalysisRow(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    model: row.model,
    provider: row.provider,
    promptVersion: row.prompt_version,
    status: row.status,
    analysis: row.analysis_json ? JSON.parse(row.analysis_json) : null,
    latencyMs: row.latency_ms,
    errorCode: row.error_code,
    createdAt: row.created_at
  }
}

function insertSessionRow(db, session, { orIgnore = true } = {}) {
  db.prepare(
    `INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO research_sessions
      (id, provenance, question, network, status, created_at, confidence,
       confidence_status, research_plan_json, onchain_data_json,
       recalled_memory_ids_json, claims_json, conclusion, learning_delta,
       evidence_comparison_json, revision_candidate_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id,
    session.provenance,
    session.question,
    session.onChainSuiData?.network ?? null,
    session.status,
    session.createdAt,
    session.confidence ?? null,
    session.confidenceStatus ?? null,
    toJson(session.researchPlan),
    toJson(session.onChainSuiData),
    toJson(session.recalledMemoryIds ?? []),
    toJson(session.claims ?? []),
    session.conclusion ?? null,
    session.learningDelta ?? null,
    toJson(session.evidenceComparison),
    toJson(session.revisionCandidate)
  )
}

function insertMemoryRow(db, memory, { orIgnore = true } = {}) {
  db.prepare(
    `INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO memories
      (id, provenance, category, title, content, source_reference,
       walrus_blob_id, walrus_sui_object_id, walrus_aggregator_url,
       created_at, status, superseded_by, reliability_score, confidence,
       confidence_status, storage_verified, storage_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    memory.id,
    memory.provenance,
    memory.category,
    memory.title,
    memory.content,
    memory.sourceReference ?? null,
    memory.walrusBlobId ?? null,
    memory.walrusSuiObjectId ?? null,
    memory.walrusAggregatorUrl ?? null,
    memory.createdAt,
    memory.status,
    memory.supersededBy ?? null,
    memory.reliabilityScore ?? null,
    memory.confidence ?? null,
    memory.confidenceStatus ?? null,
    boolToInt(memory.storageVerified),
    memory.storageStatus ?? null
  )
}

function insertDecisionRow(db, decision, { orIgnore = true } = {}) {
  db.prepare(
    `INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO decisions
      (id, provenance, topic, previous_session_id, current_session_id,
       prior_claim, new_claim, change_reason, impact, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    decision.id,
    decision.provenance,
    decision.topic,
    decision.previousSessionId ?? null,
    decision.currentSessionId ?? null,
    decision.priorClaim ?? null,
    decision.newClaim ?? null,
    decision.changeReason ?? null,
    decision.impact ?? null,
    decision.timestamp
  )
}

function insertCandidateRow(db, candidate, { orIgnore = true } = {}) {
  db.prepare(
    `INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO revision_candidates
      (id, candidate_type, status, verification_status, provenance,
       capability, previous_session_id, current_session_id, previous_value,
       current_value, source_evidence_json, reason, created_at,
       resolved_at, resolution)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    candidate.id,
    candidate.candidateType ?? 'evidence_change_candidate',
    candidate.status ?? 'pending_verification',
    candidate.verificationStatus ?? null,
    candidate.provenance ?? 'live_production',
    candidate.capability ?? null,
    candidate.previousSessionId ?? null,
    candidate.currentSessionId ?? null,
    candidate.previousValue ?? null,
    candidate.currentValue ?? null,
    toJson(candidate.sourceEvidence),
    candidate.reason ?? null,
    candidate.createdAt ?? new Date().toISOString(),
    candidate.resolvedAt ?? null,
    candidate.resolution ?? null
  )
}

function insertEvidenceRow(db, session) {
  const evidence = session.onChainSuiData
  if (!evidence || typeof evidence !== 'object') return
  db.prepare(
    `INSERT INTO evidence_records
      (session_id, capability, network, evidence_status, retrieved_at,
       payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id,
    session.researchPlan?.capability ?? null,
    evidence.network ?? null,
    evidence.evidenceStatus ?? null,
    evidence.retrievedAt ?? session.createdAt,
    toJson(evidence),
    new Date().toISOString()
  )
}

function insertAuditRow(db, { actor, action, entityType, entityId, provenance, details }) {
  db.prepare(
    `INSERT INTO audit_events
      (actor, action, entity_type, entity_id, provenance, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    actor,
    action,
    entityType,
    entityId ?? null,
    provenance ?? null,
    toJson(details),
    new Date().toISOString()
  )
}

function runTransaction(db, fn, onRollbackFailure) {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch (rollbackError) {
      // A failed rollback is never silent: the caller marks the store
      // unhealthy so later reads/writes cannot pretend all is well.
      if (typeof onRollbackFailure === 'function') {
        onRollbackFailure(rollbackError)
      }
    }
    throw error
  }
}

function seedDemoRows(db, { sessions, memories, decisions }) {
  runTransaction(db, () => {
    for (const session of sessions) insertSessionRow(db, session)
    for (const memory of memories) insertMemoryRow(db, memory)
    for (const decision of decisions) insertDecisionRow(db, decision)
  })
}

function loadAll(db) {
  const sessions = db
    .prepare('SELECT * FROM research_sessions ORDER BY created_at DESC')
    .all()
    .map(mapSessionRow)
  const memories = db
    .prepare('SELECT * FROM memories ORDER BY created_at DESC')
    .all()
    .map(mapMemoryRow)
  const decisions = db
    .prepare('SELECT * FROM decisions ORDER BY created_at DESC')
    .all()
    .map(mapDecisionRow)
  const revisionCandidates = db
    .prepare('SELECT * FROM revision_candidates ORDER BY created_at DESC')
    .all()
    .map(mapCandidateRow)
  return { sessions, memories, decisions, revisionCandidates }
}

function memoryStore(db, dbPath) {
  return {
    mode: 'sqlite',
    persistent: true,
    dbPath,
    // Internal-only raw driver message. Never serialized to HTTP: getStatus
    // exposes only a stable public code. Server-side logs carry the detail.
    lastError: null,
    healthy: true,

    // Marks the store unhealthy (e.g. a failed ROLLBACK). Safe to expose:
    // the detail is logged server-side; only a stable code goes public.
    markUnhealthy(detail) {
      this.healthy = false
      this.lastError = detail
      console.error(`[recallguard] persistence store unhealthy: ${detail}`)
    },

    onRollbackFailure(rollbackError) {
      this.markUnhealthy(`rollback failed (${rollbackError.message}); writes are disabled pending restart`)
    },

    getStatus() {
      return {
        mode: this.mode,
        persistent: this.persistent,
        // Public status never carries filesystem paths. The absolute path
        // stays on the store object itself (this.dbPath) for server-side
        // diagnostics and backup operations only.
        dbPath: null,
        schemaVersion: SCHEMA_VERSION,
        reason: this.healthy === false
          ? 'SQLite persistence is unhealthy; writes are disabled pending restart.'
          : 'SQLite file storage active.',
        lastError: this.healthy === false
          ? PERSISTENCE_UNHEALTHY_CODE
          : (this.lastError ? PERSISTENCE_ERROR_CODE : null)
      }
    },

    // Query helpers (used by tests and future route reads).
    listSessions(provenance = 'all') {
      const rows = provenance === 'all'
        ? db.prepare('SELECT * FROM research_sessions ORDER BY created_at DESC').all()
        : db.prepare(
          'SELECT * FROM research_sessions WHERE provenance = ? ORDER BY created_at DESC'
        ).all(provenance)
      return rows.map(mapSessionRow)
    },

    listMemories({ provenance = 'all', category = 'all' } = {}) {
      let sql = 'SELECT * FROM memories'
      const params = []
      const clauses = []
      if (provenance !== 'all') {
        clauses.push('provenance = ?')
        params.push(provenance)
      }
      if (category !== 'all') {
        clauses.push('category = ?')
        params.push(category)
      }
      if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`
      sql += ' ORDER BY created_at DESC'
      return db.prepare(sql).all(...params).map(mapMemoryRow)
    },

    listDecisions(provenance = 'all') {
      const rows = provenance === 'all'
        ? db.prepare('SELECT * FROM decisions ORDER BY created_at DESC').all()
        : db.prepare(
          'SELECT * FROM decisions WHERE provenance = ? ORDER BY created_at DESC'
        ).all(provenance)
      return rows.map(mapDecisionRow)
    },

    listCandidates(status = 'all') {
      const rows = status === 'all'
        ? db.prepare('SELECT * FROM revision_candidates ORDER BY created_at DESC').all()
        : db.prepare(
          'SELECT * FROM revision_candidates WHERE status = ? ORDER BY created_at DESC'
        ).all(status)
      return rows.map(mapCandidateRow)
    },

    listAiAnalysisBySession(sessionId) {
      const rows = db
        .prepare('SELECT * FROM ai_analyses WHERE session_id = ? ORDER BY created_at ASC')
        .all(sessionId)
      return rows.map(mapAiAnalysisRow)
    },

    listEvidence(sessionId) {
      return db
        .prepare('SELECT * FROM evidence_records WHERE session_id = ? ORDER BY id ASC')
        .all(sessionId)
    },

    listAudit(limit = 100) {
      return db
        .prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT ?')
        .all(limit)
    },

    // Write-through persist calls. Never throw: on failure the in-memory
    // arrays remain authoritative for this process and the error is
    // surfaced via getStatus().lastError.
    persistSession(session) {
      if (this.healthy === false) return false
      try {
        // Strict insert: live writes fail loudly (and roll back) instead of
        // being silently ignored, so a lost write is never mistaken for success.
        runTransaction(db, () => {
          insertSessionRow(db, session, { orIgnore: false })
          insertEvidenceRow(db, session)
          insertAuditRow(db, {
            actor: 'recallguard-server',
            action: 'session.created',
            entityType: 'research_session',
            entityId: session.id,
            provenance: session.provenance,
            details: { question: session.question }
          })
        }, (rollbackError) => this.onRollbackFailure(rollbackError))
        return true
      } catch (error) {
        // Server-side only: driver messages carry constraint/table detail,
        // never request data, secrets, or payloads. HTTP gets a stable code.
        this.lastError = error.message
        console.error(`[recallguard] persistSession failed: ${error.message}`)
        return false
      }
    },

    persistMemory(memory) {
      if (this.healthy === false) return false
      try {
        runTransaction(db, () => {
          insertMemoryRow(db, memory, { orIgnore: false })
          insertAuditRow(db, {
            actor: 'recallguard-server',
            action: 'memory.created',
            entityType: 'memory',
            entityId: memory.id,
            provenance: memory.provenance,
            details: { title: memory.title, storageStatus: memory.storageStatus }
          })
        }, (rollbackError) => this.onRollbackFailure(rollbackError))
        return true
      } catch (error) {
        // Server-side only: see persistSession.
        this.lastError = error.message
        console.error(`[recallguard] persistMemory failed: ${error.message}`)
        return false
      }
    },

    persistDecision(decision) {
      if (this.healthy === false) return false
      try {
        runTransaction(db, () => {
          insertDecisionRow(db, decision, { orIgnore: false })
          insertAuditRow(db, {
            actor: 'recallguard-server',
            action: 'decision.created',
            entityType: 'decision',
            entityId: decision.id,
            provenance: decision.provenance,
            details: { topic: decision.topic }
          })
        }, (rollbackError) => this.onRollbackFailure(rollbackError))
        return true
      } catch (error) {
        // Server-side only: see persistSession.
        this.lastError = error.message
        console.error(`[recallguard] persistDecision failed: ${error.message}`)
        return false
      }
    },

    persistCandidate(candidate) {
      if (this.healthy === false) return false
      try {
        runTransaction(db, () => {
          insertCandidateRow(db, candidate, { orIgnore: false })
          insertAuditRow(db, {
            actor: 'recallguard-server',
            action: 'revision_candidate.created',
            entityType: 'revision_candidate',
            entityId: candidate.id,
            provenance: candidate.provenance,
            details: {
              status: candidate.status,
              previousValue: candidate.previousValue,
              currentValue: candidate.currentValue
            }
          })
        }, (rollbackError) => this.onRollbackFailure(rollbackError))
        return true
      } catch (error) {
        // Server-side only: see persistSession.
        this.lastError = error.message
        console.error(`[recallguard] persistCandidate failed: ${error.message}`)
        return false
      }
    },

    // Atomic session+candidate write for the POST /sessions path. The
    // session row is inserted first so the candidate's foreign keys to
    // research_sessions resolve inside the same transaction; any failure
    // rolls back everything, leaving no phantom session, candidate,
    // evidence, or audit rows.
    persistSessionWithCandidate(session, candidate) {
      if (this.healthy === false) return false
      try {
        runTransaction(db, () => {
          insertSessionRow(db, session, { orIgnore: false })
          insertEvidenceRow(db, session)
          insertAuditRow(db, {
            actor: 'recallguard-server',
            action: 'session.created',
            entityType: 'research_session',
            entityId: session.id,
            provenance: session.provenance,
            details: { question: session.question }
          })
          if (candidate) {
            insertCandidateRow(db, candidate, { orIgnore: false })
            insertAuditRow(db, {
              actor: 'recallguard-server',
              action: 'revision_candidate.created',
              entityType: 'revision_candidate',
              entityId: candidate.id,
              provenance: candidate.provenance,
              details: {
                status: candidate.status,
                previousValue: candidate.previousValue,
                currentValue: candidate.currentValue
              }
            })
          }
        }, (rollbackError) => this.onRollbackFailure(rollbackError))
        return true
      } catch (error) {
        // Server-side only: see persistSession.
        this.lastError = error.message
        console.error(`[recallguard] persistSessionWithCandidate failed: ${error.message}`)
        return false
      }
    },

    // AI analysis write. Strict INSERT (UNIQUE(session_id) keeps one
    // analysis per session, so retried requests cannot duplicate rows).
    // Best-effort from the route's perspective: the deterministic session
    // is already durable, so a false return only changes the reported
    // aiStatus, never the session.
    persistAiAnalysis(record) {
      if (this.healthy === false) return false
      try {
        runTransaction(db, () => {
          db.prepare(
            `INSERT INTO ai_analyses
              (id, session_id, model, provider, prompt_version, status,
               analysis_json, latency_ms, error_code, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            record.id,
            record.sessionId,
            record.model,
            record.provider ?? 'meta',
            record.promptVersion,
            record.status ?? 'completed',
            toJson(record.analysis ?? null),
            record.latencyMs ?? null,
            record.errorCode ?? null,
            record.createdAt ?? new Date().toISOString()
          )
          insertAuditRow(db, {
            actor: 'recallguard-server',
            action: 'ai_analysis.created',
            entityType: 'ai_analysis',
            entityId: record.id,
            provenance: 'live_production',
            // Sanitized validation diagnostics only: the caller passes
            // field paths and rule names (never model text). Stored in
            // the existing free-form details JSON: no schema change.
            details: {
              sessionId: record.sessionId,
              model: record.model,
              provider: record.provider ?? 'meta',
              fallbackUsed: record.fallbackUsed ?? false,
              fallbackDisabled: record.fallbackDisabled ?? false,
              qwen: record.qwen ?? null,
              meta: record.meta ?? null,
              validationErrors: record.validationErrors ?? []
            }
          })
        }, (rollbackError) => this.onRollbackFailure(rollbackError))
        return true
      } catch (error) {
        // Server-side only: see persistSession.
        this.lastError = error.message
        console.error(`[recallguard] persistAiAnalysis failed: ${error.message}`)
        return false
      }
    },

    resolveCandidate(id, resolution) {
      try {
        const now = new Date().toISOString()
        const info = db
          .prepare(
            `UPDATE revision_candidates
             SET status = 'resolved', resolved_at = ?, resolution = ?
             WHERE id = ? AND status = 'pending_verification'`
          )
          .run(now, resolution, id)
        return info.changes > 0
      } catch (error) {
        // Server-side only: see persistSession.
        this.lastError = error.message
        console.error(`[recallguard] resolveCandidate failed: ${error.message}`)
        return false
      }
    },

    // Safe local backup. Writes a timestamped snapshot next to the live
    // database; never exposed as a public download by itself.
    backupDatabase(backupDir) {
      const dir = backupDir || path.join(path.dirname(this.dbPath), 'backups')
      mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const target = path.join(dir, `recallguard-${stamp}.db`)
      const escaped = target.replace(/'/g, "''")
      db.exec(`VACUUM INTO '${escaped}'`)
      const stats = statSync(target)
      insertAuditRow(db, {
        actor: 'recallguard-server',
        action: 'database.backup',
        entityType: 'database',
        entityId: null,
        provenance: null,
        details: { target, bytes: stats.size }
      })
      return { path: target, bytes: stats.size }
    },

    close() {
      db.close()
    },

    // Flush the WAL sidecar into the main database image. Safe to call
    // during graceful shutdown after the HTTP layer stopped accepting
    // requests: no new writes can arrive, in-flight ones already drained.
    // Never throws; reports success so the shutdown path can log safely
    // without raw driver detail.
    checkpoint() {
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        return true
      } catch (error) {
        console.error(`[recallguard] shutdown checkpoint failed: ${error.message}`)
        return false
      }
    }
  }
}

function degradedMemoryStore(reason) {
  const noop = () => false
  return {
    mode: 'memory',
    persistent: false,
    dbPath: null,
    lastError: null,
    getStatus() {
      return {
        mode: this.mode,
        persistent: false,
        dbPath: null,
        schemaVersion: SCHEMA_VERSION,
        reason,
        lastError: this.lastError
      }
    },
    listSessions: () => [],
    listMemories: () => [],
    listDecisions: () => [],
    listCandidates: () => [],
    listAiAnalysisBySession: () => [],
    listEvidence: () => [],
    listAudit: () => [],
    persistSession: noop,
    persistMemory: noop,
    persistDecision: noop,
    persistCandidate: noop,
    persistAiAnalysis: noop,
    resolveCandidate: () => false,
    backupDatabase: () => {
      throw new Error('Backups require SQLite file storage.')
    },
    checkpoint: () => false,
    close() {}
  }
}

/**
 * Initialize the store and reconcile it with the seeded runtime arrays.
 *
 * - Creates the database directory safely (recursive mkdir).
 * - Applies versioned schema, seeds demo rows once (INSERT OR IGNORE),
 *   migrates any live runtime records not yet stored (no overwrites).
 * - Returns fresh arrays loaded from the database so the DB is the
 *   source of truth at boot, plus the store handle.
 * - Falls back to an explicit non-persistent memory mode only when the
 *   database file cannot be opened at all (restricted preview): nothing
 *   pretends to be durable.
 * - Throws instead of falling back when a readable database fails
 *   validation or migration, so existing data is never silently hidden.
 */
export function initStore({ dbPath, sessions = [], memories = [], decisions = [], forceMemory = false } = {}) {
  const fallback = (reason) => ({
    store: degradedMemoryStore(reason),
    sessions: [...sessions],
    memories: [...memories],
    decisions: [...decisions],
    revisionCandidates: []
  })

  if (forceMemory || !dbPath) {
    return fallback(
      forceMemory
        ? 'Memory mode requested for this store instance.'
        : 'No database path configured; running without persistence.'
    )
  }

  let db
  try {
    mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true })
    db = new DatabaseSync(dbPath)
  } catch (error) {
    // Server-side only: OS errors may embed filesystem paths. The public
    // reason below stays static; raw detail goes to server logs.
    console.error(`[recallguard] SQLite file storage unavailable: ${error.message}`)
    return fallback(
      'SQLite file storage unavailable; running in degraded memory mode. Data will not survive restarts.'
    )
  }

  // From here the database file is open and readable, so failures must
  // never silently downgrade to degraded memory mode: that would hide the
  // existing database and its data behind seed-only in-memory arrays.
  // Validation and migration errors propagate to the caller instead.
  const resolvedPath = path.resolve(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  for (const statement of SCHEMA_STATEMENTS) db.exec(statement)
  for (const trigger of TRIGGER_STATEMENTS) db.exec(trigger)

  const versionRow = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get()
  if (!versionRow) {
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)"
    ).run(String(SCHEMA_VERSION))
  } else {
    const found = Number.parseInt(versionRow.value, 10)
    if (!Number.isInteger(found) || found < 1) {
      throw new Error(
        `Unrecognized database schema version '${versionRow.value}' at ${resolvedPath}; refusing to open so existing data is never hidden or misread.`
      )
    }
    if (found > SCHEMA_VERSION) {
      throw new Error(
        `Unsupported database schema version ${found} at ${resolvedPath} (this build supports schema version ${SCHEMA_VERSION}); refusing to open so existing data is never hidden or misread.`
      )
    }
    let current = found
    while (current < SCHEMA_VERSION) {
      const migrate = MIGRATIONS[current]
      if (typeof migrate !== 'function') {
        throw new Error(
          `No migration path from schema version ${current} to ${current + 1} at ${resolvedPath}; refusing to open so existing data is never hidden or misread.`
        )
      }
      migrate(db)
      current += 1
      db.prepare(
        "UPDATE schema_meta SET value = ? WHERE key = 'schema_version'"
      ).run(String(current))
    }
  }

  // Seed demo data once; migrate any live runtime records by id.
  runTransaction(db, () => {
    for (const session of sessions) {
      if (session.provenance === 'demo_seed') insertSessionRow(db, session)
    }
    for (const memory of memories) {
      if (memory.provenance === 'demo_seed') insertMemoryRow(db, memory)
    }
    for (const decision of decisions) {
      if (decision.provenance === 'demo_seed') insertDecisionRow(db, decision)
    }
    for (const session of sessions) {
      if (session.provenance !== 'demo_seed') insertSessionRow(db, session)
    }
    for (const memory of memories) {
      if (memory.provenance !== 'demo_seed') insertMemoryRow(db, memory)
    }
    for (const decision of decisions) {
      if (decision.provenance !== 'demo_seed') insertDecisionRow(db, decision)
    }
  })

  const loaded = loadAll(db)
  return { store: memoryStore(db, resolvedPath), ...loaded }
}
