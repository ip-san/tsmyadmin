import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import pkg from './package.json' with { type: 'json' }

const apiPort = process.env.API_PORT ?? '3100'

export default defineConfig({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // The size check follows the startup chain through it (scripts/check-bundle-size.mjs).
  // Source maps only when the E2E run measures coverage (bun run test:e2e:coverage): they map the code a test ran
  // back to the files it came from (scripts/e2e-coverage.mjs). The production build stays without them.
  build: { manifest: true, sourcemap: Boolean(process.env.E2E_COVERAGE) },
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5175),
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
  },
  preview: { host: '127.0.0.1', port: Number(process.env.WEB_PORT ?? 5175) },
})
