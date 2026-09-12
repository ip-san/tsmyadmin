#!/usr/bin/env node
/**
 * Keeps the English documentation in step with the Japanese originals.
 *
 * Each translated file records the SHA-256 of the source it was written from:
 *
 *   <!-- translated-from: docs/user-guide.md sha256:… -->
 *
 * Editing the Japanese file changes its hash and fails this check, so a change cannot ship with a stale
 * translation. `--sync` stamps the current hashes and is the last step of translating — never a way to make the
 * check pass without touching the English text (this is why `docs:validate --fix`, which pre-commit runs and
 * stages automatically, does not touch these markers).
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const sync = process.argv.includes('--sync')

/** Japanese original → English translation. */
const PAIRS = [
  ['README.md', 'README.en.md'],
  ['docs/user-guide.md', 'docs/en/user-guide.md'],
  ['docs/deployment.md', 'docs/en/deployment.md'],
  ['docs/security.md', 'docs/en/security.md'],
  ['docs/operations.md', 'docs/en/operations.md'],
  ['docs/architecture.md', 'docs/en/architecture.md'],
]

const MARKER = /<!-- translated-from: (\S+) sha256:([0-9a-f]{64}) -->/

const digest = (path) =>
  createHash('sha256')
    .update(readFileSync(join(ROOT, path)))
    .digest('hex')

let failed = false
const stamped = []
for (const [source, translation] of PAIRS) {
  let text
  try {
    text = readFileSync(join(ROOT, translation), 'utf8')
  } catch {
    console.error(`✗ ${translation} is missing (translation of ${source})`)
    failed = true
    continue
  }
  const found = MARKER.exec(text)
  if (!found) {
    console.error(`✗ ${translation}: no marker — add <!-- translated-from: ${source} sha256:… --> and run docs:sync`)
    failed = true
    continue
  }
  if (found[1] !== source) {
    console.error(`✗ ${translation}: marker names ${found[1]}, expected ${source}`)
    failed = true
    continue
  }
  const current = digest(source)
  if (found[2] === current) continue
  if (!sync) {
    console.error(
      `✗ ${source} changed since ${translation} was written — translate the change, then run \`bun run docs:sync\``
    )
    failed = true
    continue
  }
  stamped.push(translation)
  writeFileSync(join(ROOT, translation), text.replace(MARKER, `<!-- translated-from: ${source} sha256:${current} -->`))
}

if (sync) {
  console.log(stamped.length ? `✓ docs:sync stamped ${stamped.join(', ')}` : '✓ docs:sync: nothing to stamp')
  process.exit(failed ? 1 : 0)
}
if (failed) process.exit(1)
console.log(`✓ docs:i18n passed (${PAIRS.length} translations up to date)`)
