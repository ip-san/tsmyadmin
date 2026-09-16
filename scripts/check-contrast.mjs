#!/usr/bin/env node
/**
 * WCAG contrast of the design tokens, read straight out of `apps/web/src/index.css`.
 *
 * The axe gate in the E2E suite only judges *text* contrast, and only for the combinations a test happens to
 * render. This checks every combination the tokens allow, including the non-text rule (1.4.11) for the border
 * that identifies a control — which is how a control border once shipped at 1.7:1 against white, weaker than
 * the colour it replaced, with every automated check still green.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

/** Relative luminance, per WCAG 2.x. */
function luminance(hex) {
  const v = hex.replace('#', '')
  const channels = [0, 2, 4].map((i) => {
    const c = Number.parseInt(v.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Backgrounds a token can sit on, and what may sit on them. */
const SURFACES = ['canvas', 'surface', 'surface-sub', 'critical-sub']
const TEXT = ['ink', 'ink-sub', 'ink-faint', 'brand', 'critical']
/**
 * 1.4.11 covers the boundary that identifies a control. `line-strong` is that boundary (inputs, buttons, the
 * editor frame); `line` draws dividers and the outline of non-interactive containers, which the rule does not
 * cover, so it is deliberately quieter and not checked.
 */
const CONTROL_BORDER = 'line-strong'
const TEXT_MIN = 4.5
const NON_TEXT_MIN = 3

function parseThemes(css) {
  const read = (selector) => {
    const m = new RegExp(`${selector}\\s*\\{(.*?)\\n\\}`, 's').exec(css)
    if (!m) throw new Error(`no ${selector} block in index.css`)
    return Object.fromEntries([...m[1].matchAll(/--c-([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map((x) => [x[1], x[2]]))
  }
  return { light: read(':root'), dark: read('html\\.dark') }
}

export function check(themes) {
  const problems = []
  for (const [theme, t] of Object.entries(themes)) {
    for (const name of [...SURFACES, ...TEXT, CONTROL_BORDER]) {
      if (!t[name]) problems.push(`${theme}: token --c-${name} is not defined`)
    }
    for (const bg of SURFACES) {
      for (const fg of TEXT) {
        if (!t[bg] || !t[fg]) continue
        const r = contrast(t[fg], t[bg])
        if (r < TEXT_MIN) problems.push(`${theme}: text ${fg} on ${bg} is ${r.toFixed(2)}:1 (needs ${TEXT_MIN})`)
      }
      if (!t[bg] || !t[CONTROL_BORDER]) continue
      const r = contrast(t[CONTROL_BORDER], t[bg])
      if (r < NON_TEXT_MIN) {
        problems.push(`${theme}: control border on ${bg} is ${r.toFixed(2)}:1 (needs ${NON_TEXT_MIN})`)
      }
    }
    // The primary button: its label sits on the brand, which is light in dark mode.
    for (const bg of ['brand', 'brand-hover']) {
      if (!t['brand-ink'] || !t[bg]) continue
      const r = contrast(t['brand-ink'], t[bg])
      if (r < TEXT_MIN) problems.push(`${theme}: brand-ink on ${bg} is ${r.toFixed(2)}:1 (needs ${TEXT_MIN})`)
    }
  }
  return problems
}

const SELF_TEST = [
  { name: 'a passing pair', ok: true, fg: '#1a1c1f', bg: '#ffffff', min: TEXT_MIN },
  { name: 'grey on white below AA', ok: false, fg: '#8b919b', bg: '#f4f5f7', min: TEXT_MIN },
  { name: 'white on a light brand', ok: false, fg: '#ffffff', bg: '#818cf8', min: TEXT_MIN },
  { name: 'a faint control border', ok: false, fg: '#c3c7cd', bg: '#ffffff', min: NON_TEXT_MIN },
  { name: 'a control border that holds up', ok: true, fg: '#83898f', bg: '#ffffff', min: NON_TEXT_MIN },
]

if (process.argv.includes('--self-test')) {
  const failed = SELF_TEST.filter((c) => contrast(c.fg, c.bg) >= c.min !== c.ok)
  for (const c of failed) console.error(`  - ${c.name}: ${contrast(c.fg, c.bg).toFixed(2)}:1`)
  if (failed.length) {
    console.error('✗ contrast self-test FAILED')
    process.exit(1)
  }
  console.log(`✓ contrast self-test passed (${SELF_TEST.length} cases)`)
  process.exit(0)
}

const themes = parseThemes(readFileSync(join(ROOT, 'apps/web/src/index.css'), 'utf8'))
const problems = check(themes)
for (const p of problems) console.error(`✗ ${p}`)
if (problems.length) {
  console.error('✗ contrast check FAILED')
  process.exit(1)
}
const combos = Object.keys(themes).length * (SURFACES.length * (TEXT.length + 1) + 2)
console.log(`✓ contrast check passed (${combos} token combinations)`)
