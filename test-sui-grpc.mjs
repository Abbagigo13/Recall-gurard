// Load .env before initializing the Sui client.
import './server/env-bootstrap.mjs'

import {
  getSuiNetworkStatus
} from './server/sui-grpc-client.mjs'

try {
  const result = await getSuiNetworkStatus('mainnet')
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error('Sui gRPC test failed:', error.message)
  process.exitCode = 1
}