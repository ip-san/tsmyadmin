#!/usr/bin/env node
/**
 * Starts the API (bun --hot) and the web dev server (vite) side by side with prefixed output.
 * `bun run --filter '*' dev` cannot be used: it runs scripts in dependency order and web depends
 * on api for its types, so vite would wait for the API process to exit.
 */
import { spawn } from 'node:child_process'

const procs = [
  { name: 'api', cwd: 'apps/api', color: '\x1b[36m' },
  { name: 'web', cwd: 'apps/web', color: '\x1b[35m' },
].map(({ name, cwd, color }) => {
  const child = spawn('bun', ['run', 'dev'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  const prefix = (chunk) => {
    for (const line of chunk.toString().split('\n'))
      if (line.trim()) process.stdout.write(`${color}[${name}]\x1b[0m ${line}\n`)
  }
  child.stdout.on('data', prefix)
  child.stderr.on('data', prefix)
  child.on('exit', (code) => {
    process.stdout.write(`[${name}] exited with ${code}\n`)
    shutdown(code ?? 1)
  })
  return child
})

function shutdown(code = 0) {
  for (const p of procs) if (p.exitCode === null) p.kill('SIGTERM')
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
