
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'

// Resolve .env relative to the project, not the terminal's working directory.
const envPath = fileURLToPath(new URL('../.env', import.meta.url))

try {
  loadEnvFile(envPath)
  console.log('[env] Local .env loaded')
} catch (error) {
  if (error.code === 'ENOENT') {
    console.log('[env] No local .env file; using supplied environment')
  } else {
    throw error
  }
}
