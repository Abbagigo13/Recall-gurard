# RecallGuard

> Autonomous AI Research Agent with Persistent Memory & Verifiable Sui Blockchain Truth
> Built for the **Tatum × Walrus Total Recall Hackathon**

---

## 1. Executive Summary

RecallGuard is a production-grade AI research engine that learns across iterative research sessions, preserves evidence in persistent decentralized memory, and dynamically refines its conclusions when verifiable on-chain facts contradict prior assumptions.

Unlike typical stateless AI agents that hallucinate or repeat obsolete claims, RecallGuard:

1. **Remembers** past claims, hypotheses, and evidence vectors using decentralized persistent memory specifications (compatible with the official Walrus Memory Python SDK `memwal`).
2. **Verifies** on-chain facts directly through Tatum's managed Sui JSON-RPC gateway without requesting wallet transactions or exposing private keys.
3. **Evolves transparently** through an empirical Learning Engine that logs epistemic shifts, explains why prior conclusions were superseded, and measures performance without fabricating metrics.

---

## 2. Architecture & Core Modules

```
                        ┌───────────────────────────────────────────────┐
                        │             RecallGuard Dashboard             │
                        │      (React + TypeScript + Tatum Design)      │
                        └──────────────────────┬────────────────────────┘
                                               │ /api/recallguard/*
                                               ▼
                        ┌───────────────────────────────────────────────┐
                        │               Express Server                  │
                        │       (server/routes/recallguard.mjs)         │
                        └──────┬────────────────────────────────┬───────┘
                               │                                │
                 Read-Only Sui │                                │ Persistent
                 JSON-RPC      ▼                                ▼ Memory Blobs
                  ┌─────────────────────────┐      ┌─────────────────────────┐
                  │    Tatum Gateway        │      │      Walrus Memory      │
                  │  (Sui Mainnet / Testnet)│      │  (memwal Python SDK /   │
                  │   sui_getLatest...      │      │   Aggregator RedStuff)  │
                  └─────────────────────────┘      └─────────────────────────┘
```

### Module Breakdown

- **Research Workspace**: User-facing inquiry cockpit. Runs semantic retrieval against past memories and evaluates claims categorized into:
  - `Verified Facts`: Cryptographically provable data anchored via Tatum Sui RPC.
  - `Unverified Claims`: Speculative or third-party web community assertions.
  - `AI-Generated Interpretations`: Epistemic inferences synthesized from recalled memories.
- **Persistent Memory Explorer**: Searchable memory index with categorical filtering, source references, reliability scores, and Walrus blob identifiers.
- **Evidence Verification (Tatum Sui RPC)**: Direct interactive read-only console executing standard Sui JSON-RPC methods (`sui_getLatestCheckpointSequenceNumber`, `suix_getReferenceGasPrice`, `sui_getObject`, etc.).
- **Learning Engine**: Auditable log of hypothesis adjustments and Bayesian-style belief revision, recording why stance changes occurred.
- **Audit Timeline**: End-to-end provenance visualizer tracing session inquiries, recalled memories, and state adjustments.

---

## 3. Walrus Memory Integration (`memwal`)

RecallGuard implements memory integration tailored for the official Walrus Memory Python SDK (`memwal`):

- **Data Redundancy**: 2D Reed-Solomon encoding (`RedStuff`) providing $3f + 1$ Byzantine fault tolerance.
- **Adapter Specs**: The server provides an interactive SDK inspection endpoint (`/api/recallguard/walrus/sdk-spec`) detailing the exact Python integration patterns for autonomous daemons.
- **Honest States**: If an external node or API key is not configured, RecallGuard displays explicit configuration notices rather than inventing falsified storage responses.

---

## 4. Getting Started

### Prerequisites

- Node.js 18+
- Tatum API Key (from [co.tatum.io](https://co.tatum.io))

### Setup Instructions

1. **Clone and Install Dependencies**:

   ```bash
   git clone <repo-url>
   cd recallguard
   npm install
   ```

2. **Configure Environment Variables**:

   ```bash
   cp .env.example .env
   ```

   Add your Tatum API key:

   ```env
   TATUM_API_KEY=your_tatum_api_key_here
   ```

3. **Run the Application**:

   ```bash
   npm run dev
   # or node server/index.mjs
   ```

   Access the dashboard at `http://localhost:3000`.

---

## 5. Security & Read-Only Guarantees

- **No Private Key Ingestion**: RecallGuard enforces zero transaction signing and read-only Sui queries.
- **Credential Protection**: `TATUM_API_KEY` stays on the server side and is scrubbed by `credentialGuard` middleware before any response reaches the browser.
