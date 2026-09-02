#!/usr/bin/env node
/**
 * Initial JS budget: everything index.html loads before the app can render (the entry script and every
 * modulepreload), brotli-compressed. A budget on the entry chunk alone would miss shared chunks Vite splits out.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'

const DIST = join(process.cwd(), 'apps/web/dist')
const LIMIT_KB = 150

const html = readFileSync(join(DIST, 'index.html'), 'utf8')
const assets = [...html.matchAll(/<(?:script[^>]*src|link[^>]*rel="modulepreload"[^>]*href)="([^"]+\.js)"/g)].map(
  (m) => m[1]
)
if (assets.length === 0) {
  console.error('✗ bundle size: no script tags found in apps/web/dist/index.html (run `bun run build`)')
  process.exit(1)
}
let total = 0
const rows = []
for (const asset of assets) {
  const size = brotliCompressSync(readFileSync(join(DIST, asset))).length
  total += size
  rows.push(`  ${(size / 1024).toFixed(1).padStart(7)} kB  ${asset}`)
}
console.log(rows.join('\n'))
const totalKb = total / 1024
console.log(`Initial JS (brotli, ${assets.length} files): ${totalKb.toFixed(1)} kB / ${LIMIT_KB} kB`)
if (totalKb > LIMIT_KB) {
  console.error(`✗ bundle size exceeds the ${LIMIT_KB} kB budget`)
  process.exit(1)
}
console.log('✓ bundle size within budget')
