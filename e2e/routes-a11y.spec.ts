import { readFileSync } from 'node:fs'
import { expect } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'
import { pageProblems } from './scan.ts'

/**
 * Every screen of the application, taken from the generated route tree, opened in its first state and scanned for
 * accessibility and layout problems. A screen added later is covered without anyone remembering to list it; the
 * screens that need a particular state (open dialogs, results, enrolment) are scanned by a11y.spec.ts as well.
 */
function routePaths(): string[] {
  const tree = readFileSync(new URL('../apps/web/src/routeTree.gen.ts', import.meta.url), 'utf8')
  const from = tree.indexOf('fullPaths:')
  if (from === -1) throw new Error('the route tree has no fullPaths: the generated file changed shape')
  const paths: string[] = []
  for (const line of tree.slice(from).split('\n').slice(1)) {
    const m = /^\s*\|\s*'([^']+)'/.exec(line)
    if (!m?.[1]) break
    paths.push(m[1])
  }
  return [...new Set(paths.map((p) => (p.length > 1 ? p.replace(/\/$/, '') : p)))].filter((p) => p !== '/login')
}

const ROUTES = routePaths()

test.describe('accessibility of every screen (axe-core)', () => {
  test('the route tree was read', () => {
    expect(ROUTES.length).toBeGreaterThan(40)
  })

  for (const t of TARGETS) {
    test(`${t.dialect}: each screen opens without problems`, async ({ page }) => {
      test.setTimeout(300_000)
      await login(page, t)
      const problems: string[] = []
      for (const route of ROUTES) {
        const path = route.replace('$db', encodeURIComponent(t.database)).replace('$table', 'users')
        const schema = t.schema && route.startsWith('/db/') ? `?schema=${t.schema}` : ''
        await page.goto(`${path}${schema}`)
        await page.getByRole('heading').first().waitFor()
        // The data a screen shows arrives after the heading: a scan of the spinner would prove nothing.
        await page.waitForLoadState('networkidle')
        const found = await pageProblems(page)
        for (const v of found.axe as { id: string; help: string; nodes: { target: unknown[] }[] }[]) {
          problems.push(`${route}: axe ${v.id} (${v.help}) at ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)
        }
        for (const l of found.layout) problems.push(`${route}: ${l}`)
      }
      expect(problems).toEqual([])
    })
  }
})
