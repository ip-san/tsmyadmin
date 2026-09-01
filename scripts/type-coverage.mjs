#!/usr/bin/env node
/** Runs type-coverage (strict, ≥ 99%) for every workspace project in parallel. */
import { spawn } from 'node:child_process'

// apps/web uses a dedicated tsconfig: type-coverage only resolves the "@/" alias with baseUrl,
// which TypeScript 6 deprecates for regular builds.
const projects = ['packages/shared', 'packages/adapter', 'apps/api', 'apps/web/tsconfig.type-coverage.json']
const args = [
  'type-coverage',
  '--strict',
  '--at-least',
  '99',
  '--ignore-files',
  '**/*.test.*',
  '--ignore-files',
  '**/*.integration.test.*',
]

const run = (p) =>
  new Promise((resolve) => {
    const child = spawn('bunx', [...args, '-p', p], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ p, code, out: out.trim() }))
  })

const results = await Promise.all(projects.map(run))
let failed = false
for (const r of results) {
  const summary = r.out.split('\n').slice(-2).join(' ')
  if (r.code !== 0) {
    failed = true
    console.error(`✗ ${r.p}\n${r.out}`)
  } else console.log(`✓ ${r.p}: ${summary}`)
}
process.exit(failed ? 1 : 0)
