// Standalone production build config. The development server
// (server/index.mjs) uses configFile: false with its own inline setup, so
// this file affects `vite build` only and never changes dev behavior.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist'
  }
})
