import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MissingApiKeyError } from './tatum-client.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PROTO_ROOT = path.join(__dirname, 'proto')
const LEDGER_PROTO = path.join(
  PROTO_ROOT,
  'sui',
  'rpc',
  'v2',
  'ledger_service.proto'
)

const packageDefinition = protoLoader.loadSync(LEDGER_PROTO, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTO_ROOT]
})

const sui = grpc.loadPackageDefinition(packageDefinition).sui.rpc.v2

const NETWORKS = {
  mainnet: 'sui-mainnet-grpc',
  testnet: 'sui-testnet-grpc'
}

function getTarget(network) {
  const prefix = NETWORKS[network]

  if (!prefix) {
    throw new Error('Unsupported Sui network. Use mainnet or testnet.')
  }

  const apiBase = process.env.TATUM_API_BASE || 'https://api.tatum.io'
  const domain = new URL(apiBase).hostname.replace(/^api\./, '')

  return `${prefix}.gateway.${domain}:443`
}

function getMetadata() {
  const key = process.env.TATUM_API_KEY

  if (!key) {
    throw new MissingApiKeyError()
  }

  const metadata = new grpc.Metadata()
  metadata.set('x-api-key', key)

  return metadata
}

function createClient(network) {
  return new sui.LedgerService(
    getTarget(network),
    grpc.credentials.createSsl()
  )
}

function callGrpc(client, method, request, metadata, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = new Date(Date.now() + timeoutMs)

    client[method](
      request,
      metadata,
      { deadline },
      (error, response) => {
        if (error) {
          const safeError = new Error(error.details || 'Sui gRPC request failed')
          safeError.code = error.code
          return reject(safeError)
        }

        resolve(response)
      }
    )
  })
}

/**
 * Retrieve Tatum's Sui service information.
 * This includes current checkpoint height and available history range.
 */
export async function getSuiServiceInfo(network = 'mainnet') {
  const metadata = getMetadata()
  const client = createClient(network)

  try {
    return await callGrpc(
      client,
      'getServiceInfo',
      {},
      metadata
    )
  } finally {
    client.close()
  }
}

/**
 * Retrieve a specific Sui checkpoint.
 * If no sequence is supplied, the latest reported height is used.
 */
export async function getSuiCheckpoint(network = 'mainnet', sequenceNumber) {
  const metadata = getMetadata()
  const client = createClient(network)

  try {
    let sequence = sequenceNumber

    if (sequence === undefined || sequence === null) {
      const info = await callGrpc(
        client,
        'getServiceInfo',
        {},
        metadata
      )

      sequence = info.checkpointHeight
    }

    if (!/^\d+$/.test(String(sequence))) {
      throw new Error('Invalid checkpoint sequence number.')
    }

    const checkpoint = await callGrpc(
      client,
      'getCheckpoint',
      {
        sequenceNumber: String(sequence),
        readMask: {
          paths: ['sequence_number', 'digest', 'summary']
        }
      },
      metadata
    )

    return {
      network,
      provider: 'Tatum Sui gRPC',
      retrievedAt: new Date().toISOString(),
      sequenceNumber: String(sequence),
      checkpoint: checkpoint.checkpoint,
      evidenceStatus: 'retrieved_from_tatum',
      cryptographicallyVerified: false
    }
  } finally {
    client.close()
  }
}

/**
 * Combined read-only health and checkpoint query.
 */
export async function getSuiNetworkStatus(network = 'mainnet') {
  const serviceInfo = await getSuiServiceInfo(network)

  const checkpoint = await getSuiCheckpoint(
    network,
    serviceInfo.checkpointHeight
  )

  return {
    network,
    provider: 'Tatum Sui gRPC',
    serviceInfo,
    checkpoint,
    status: 'connected',
    retrievedAt: new Date().toISOString()
  }
}



export async function getSuiObject(
  network = 'mainnet',
  objectId,
  options = {}
) {
  if (
    typeof objectId !== 'string' ||
    !/^0x[0-9a-fA-F]+$/.test(objectId)
  ) {
    throw new Error('A valid Sui object ID is required.')
  }

  const metadata = getMetadata()
  const client = createClient(network)

  try {
    const paths = [
      'object_id',
      'version',
      'digest',
      'owner',
      'object_type',
      'previous_transaction',
      'storage_rebate',
      'contents',
      'json',
      'balance',
      'display'
    ]

    const request = {
      objectId,
      readMask: {
        paths
      }
    }

    if (options.version !== undefined && options.version !== null) {
      if (!/^\d+$/.test(String(options.version))) {
        throw new Error('Invalid object version.')
      }

      request.version = String(options.version)
    }

    return await callGrpc(
      client,
      'getObject',
      request,
      metadata
    )
  } finally {
    client.close()
  }
}
