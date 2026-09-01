#!/usr/bin/env node
/** Type-checks every workspace project in parallel (no project references → no emit needed). */
import { spawn } from 'node:child_process'

const projects = ['packages/shared', 'packages/adapter', 'apps/api', 'apps/web', 'tsconfig.tools.json']
const only = process.argv.slice(2)
const targets = only.length > 0 ? projects.filter((p) => only.some((o) => p.includes(o))) : projects

const run = (project) =>
  new Promise((resolve) => {
    const child = spawn('bunx', ['tsc', '--noEmit', '-p', project], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ project, code, out }))
  })

const results = await Promise.all(targets.map(run))
let failed = false
for (const r of results) {
  if (r.code !== 0) {
    failed = true
    console.error(`✗ ${r.project}\n${r.out}`)
  } else {
    console.log(`✓ ${r.project}`)
  }
}
process.exit(failed ? 1 : 0)
