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

/** Hash of the source as bytes, so a CRLF / LF difference is a real difference rather than a silent pass. */
const digest = (text) => createHash('sha256').update(text).digest('hex')

/**
 * The whole rule, as a pure function so `--self-test` can exercise it: returns `null` when the translation is up
 * to date, otherwise the reason. `translation` is null when the file does not exist.
 */
function checkPair(source, translation, sourceText, translationText) {
  if (translationText === null) return `${translation} is missing (translation of ${source})`
  const found = MARKER.exec(translationText)
  if (!found) {
    return `${translation}: no marker — add <!-- translated-from: ${source} sha256:… --> and run docs:sync`
  }
  if (found[1] !== source) return `${translation}: marker names ${found[1]}, expected ${source}`
  if (found[2] !== digest(sourceText)) {
    return `${source} changed since ${translation} was written — translate the change, then run \`bun run docs:sync\``
  }
  return null
}

const SELF_TEST = [
  { name: 'up to date', ok: true, src: 'ねこ', out: `<!-- translated-from: a.md sha256:${digest('ねこ')} -->\ncat` },
  { name: 'source edited', ok: false, src: 'いぬ', out: `<!-- translated-from: a.md sha256:${digest('ねこ')} -->` },
  { name: 'no marker', ok: false, src: 'ねこ', out: '# Cat\n' },
  {
    name: 'marker names another source',
    ok: false,
    src: 'ねこ',
    out: `<!-- translated-from: b.md sha256:${digest('ねこ')} -->`,
  },
  { name: 'short hash', ok: false, src: 'ねこ', out: '<!-- translated-from: a.md sha256:abc -->' },
  // Bytes, not characters: the same text with CRLF line endings is a different source.
  { name: 'CRLF source', ok: false, src: 'a\r\nb', out: `<!-- translated-from: a.md sha256:${digest('a\nb')} -->` },
  { name: 'missing file', ok: false, src: 'ねこ', out: null },
]

if (process.argv.includes('--self-test')) {
  const failed = SELF_TEST.filter((c) => (checkPair('a.md', 'a.en.md', c.src, c.out) === null) !== c.ok)
  for (const c of failed) console.error(`  - ${c.ok ? 'false positive' : 'missed'}: ${c.name}`)
  if (failed.length) {
    console.error('✗ docs:i18n self-test FAILED')
    process.exit(1)
  }
  console.log(`✓ docs:i18n self-test passed (${SELF_TEST.length} cases)`)
  process.exit(0)
}

const read = (path) => {
  try {
    return readFileSync(join(ROOT, path), 'utf8')
  } catch {
    return null
  }
}

const sync = process.argv.includes('--sync')
let failed = false
const stamped = []
for (const [source, translation] of PAIRS) {
  const sourceText = read(source)
  if (sourceText === null) {
    console.error(`✗ ${source} is missing (the original of ${translation})`)
    failed = true
    continue
  }
  const translationText = read(translation)
  const reason = checkPair(source, translation, sourceText, translationText)
  if (!reason) continue
  // --sync only ever re-stamps a marker that is present and names the right source; a missing file or a broken
  // marker still fails, so it cannot conjure a translation into existence.
  if (sync && translationText !== null && MARKER.exec(translationText)?.[1] === source) {
    writeFileSync(
      join(ROOT, translation),
      translationText.replace(MARKER, `<!-- translated-from: ${source} sha256:${digest(sourceText)} -->`)
    )
    stamped.push(translation)
    continue
  }
  console.error(`✗ ${reason}`)
  failed = true
}

if (sync) {
  console.log(stamped.length ? `✓ docs:sync stamped ${stamped.join(', ')}` : '✓ docs:sync: nothing to stamp')
  process.exit(failed ? 1 : 0)
}
if (failed) process.exit(1)
console.log(`✓ docs:i18n passed (${PAIRS.length} translations up to date)`)
