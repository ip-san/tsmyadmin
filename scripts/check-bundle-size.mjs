#!/usr/bin/env node
/**
 * Initial JS budget: everything the page must download before the app can render, brotli-compressed.
 *
 * The entry (main.tsx) loads the page's language and then the app (app.tsx) with dynamic imports, so index.html
 * alone names only the entry. The chain is followed through Vite's manifest instead: the entry and what it imports,
 * the app chunk and what it imports, and the larger of the language chunks (only one is fetched, but which one
 * depends on the user). Route chunks the router loads on navigation are not counted, as before.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'

const DIST = join(process.cwd(), 'apps/web/dist')
/**
 * 160: raised from 150 when the phpMyAdmin-parity work (export / import, settings, server tools) took the initial
 * download to the old limit. Most of the growth is the language file (about a quarter of the total, one file per
 * language because every string is read once at load); the screens themselves are route chunks and are not counted.
 *
 * 170: raised from 160 at 159.9, rather than trimmed. Measured (initial JS, minified): react-dom 33%, zod 17%, the
 * language file 13%, TanStack Router and Query about 18%, the shared schemas about 7%. zod is not removable from the
 * first paint: the route definitions validate their search parameters with it, and every `readPreference` takes a zod
 * schema. The one lever that matters is the language file, up to about 20 kB of it by loading each screen's strings
 * with the screen; that touches all 208 files that read `locale.` (53 capture a section at module level), and a
 * section missed shows only at run time, as `undefined` on the screen that needs it. Not worth it at this size: do it
 * when the budget is next exceeded, with `docs/dev-environment.md` ("Initial JS budget") as the starting point.
 */
const LIMIT_KB = 170

let manifest
try {
  manifest = JSON.parse(readFileSync(join(DIST, '.vite/manifest.json'), 'utf8'))
} catch {
  console.error('✗ bundle size: apps/web/dist/.vite/manifest.json not found (run `bun run build`)')
  process.exit(1)
}

const size = (file) => brotliCompressSync(readFileSync(join(DIST, file))).length
/** A chunk and everything it imports statically. */
function closure(key, into = new Set()) {
  const chunk = manifest[key]
  if (!chunk || into.has(key)) return into
  into.add(key)
  for (const dep of chunk.imports ?? []) closure(dep, into)
  return into
}

const entry = Object.keys(manifest).find((k) => manifest[k].isEntry)
const app = Object.keys(manifest).find((k) => k.endsWith('src/app.tsx'))
const languages = Object.keys(manifest).filter((k) => /src\/config\/locales\/[a-z]+\.ts$/.test(k))
if (!entry || !app || languages.length === 0) {
  console.error('✗ bundle size: entry, app or language chunks missing from the manifest')
  process.exit(1)
}
const keys = new Set([...closure(entry), ...closure(app)])
// Only one language is fetched; the budget holds for the larger.
const language = languages.map((k) => ({ k, s: size(manifest[k].file) })).sort((a, b) => b.s - a.s)[0]
keys.add(language.k)

let total = 0
const rows = []
for (const key of keys) {
  const file = manifest[key].file
  const bytes = key === language.k ? language.s : size(file)
  total += bytes
  rows.push(`  ${(bytes / 1024).toFixed(1).padStart(7)} kB  /${file}`)
}
console.log(rows.join('\n'))
const totalKb = total / 1024
console.log(`Initial JS (brotli, ${keys.size} files): ${totalKb.toFixed(1)} kB / ${LIMIT_KB} kB`)
if (totalKb > LIMIT_KB) {
  console.error(`✗ bundle size exceeds the ${LIMIT_KB} kB budget`)
  process.exit(1)
}
console.log('✓ bundle size within budget')
