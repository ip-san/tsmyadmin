#!/usr/bin/env node
/**
 * Daily quality gate: typecheck + lint + unit tests in parallel, then type-coverage.
 * Unlike `a & b & wait`, a failure in any step fails the gate.
 */
import { spawn } from 'node:child_process'

const steps = [
  ['typecheck', ['bun', 'run', 'typecheck']],
  ['lint', ['bun', 'run', 'lint']],
  ['test', ['bun', 'run', 'test']],
]

const run = ([name, cmd]) =>
  new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ name, code, out, ms: Date.now() - started }))
  })

const results = await Promise.all(steps.map(run))
let failed = false
for (const r of results) {
  if (r.code === 0) console.log(`✓ ${r.name} (${(r.ms / 1000).toFixed(1)}s)`)
  else {
    failed = true
    console.error(`✗ ${r.name} (${(r.ms / 1000).toFixed(1)}s)\n${r.out.trim()}\n`)
  }
}
if (failed) process.exit(1)

const tc = await run(['type-coverage', ['bun', 'run', 'type-coverage']])
if (tc.code !== 0) {
  console.error(`✗ type-coverage\n${tc.out.trim()}`)
  process.exit(1)
}
console.log(`✓ type-coverage (${(tc.ms / 1000).toFixed(1)}s)`)
