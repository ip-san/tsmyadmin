#!/usr/bin/env node
/**
 * Doc comments that sit on the wrong declaration.
 *
 * A `/** … *\/` block whose next line is another `/** … *\/` block cannot describe both: one of them was left
 * behind when the declaration it belonged to moved, so the editor's hover shows a wrong description on the one
 * below it. 27 of these were found by hand in this repository, 13 of them in `types.ts` and `base.ts`, the first
 * files a newcomer reads.
 *
 * Only the adjacent shape is checked. A block, a blank line and then another block is the usual way to write a
 * file's header above the first declaration's own comment, and would be reported wrongly. So a stray comment with a
 * blank line after it is not caught: the check trades those few for never raising a false alarm.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'test-results', 'playwright-report', 'coverage'])
const SKIP_FILES = new Set(['routeTree.gen.ts'])
const EXTENSIONS = ['.ts', '.tsx', '.mjs']

/**
 * Line numbers (1-based) of every doc block whose next line starts another doc block.
 * @param {string} source
 * @returns {number[]}
 */
export function stackedDocs(source) {
  const lines = source.split('\n')
  const found = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trimStart().startsWith('/**')) continue
    // The block ends on the first line holding `*/` (the opening line itself, for a one-line comment).
    let end = i
    while (end < lines.length && !lines[end].includes('*/')) end++
    if (end >= lines.length) break
    if (lines[end + 1]?.trimStart().startsWith('/**')) found.push(i + 1)
    i = end
  }
  return found
}

const SELF_TEST = [
  {
    name: 'a doc left above another doc (the shape found in types.ts)',
    source:
      '/** Renders dialect-specific SQL for dumps. */\n/** One program object for the dump. */\nexport type DropTarget = string\n',
    expect: [1],
  },
  {
    name: 'a multi-line block directly above another block',
    source: '/**\n * The class.\n */\n/** A constant. */\nconst A = 1\n',
    expect: [1],
  },
  {
    name: 'two blocks with a blank line between (a file header above the first declaration)',
    source: '/**\n * The file.\n */\n\n/** The first declaration. */\nexport const A = 1\n',
    expect: [],
  },
  {
    name: 'a doc above its declaration',
    source: '/** A. */\nexport const A = 1\n/** B. */\nexport const B = 2\n',
    expect: [],
  },
  { name: 'a doc then a line comment', source: '/** A. */\n// note\nexport const A = 1\n', expect: [] },
  {
    name: 'three in a row reports the first two',
    source: '/** a */\n/** b */\n/** c */\nexport const A = 1\n',
    expect: [1, 2],
  },
  { name: 'an unterminated block is not a crash', source: '/** a\n * b\n', expect: [] },
]

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.claude') continue
    if (SKIP_DIRS.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (EXTENSIONS.some((x) => e.name.endsWith(x)) && !SKIP_FILES.has(e.name)) out.push(full)
  }
  return out
}

function main() {
  if (process.argv.includes('--self-test')) {
    const failed = SELF_TEST.filter((c) => JSON.stringify(stackedDocs(c.source)) !== JSON.stringify(c.expect))
    for (const c of failed) console.error(`  - ${c.name}: got ${JSON.stringify(stackedDocs(c.source))}`)
    if (failed.length) {
      console.error('✗ doc-comments self-test FAILED')
      process.exit(1)
    }
    console.log(`✓ doc-comments self-test passed (${SELF_TEST.length} cases)`)
    return
  }
  const root = process.cwd()
  const files = walk(root)
  const problems = []
  for (const file of files) {
    for (const line of stackedDocs(readFileSync(file, 'utf8'))) {
      problems.push(`${relative(root, file)}:${line} — a doc comment is followed directly by another one`)
    }
  }
  for (const p of problems) console.error(`✗ ${p}`)
  if (problems.length) {
    console.error(
      `✗ doc-comments check FAILED (${problems.length}). Move each comment to the declaration it describes.`
    )
    process.exit(1)
  }
  console.log(`✓ doc-comments check passed (${files.length} files)`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
