import { expect, test } from '@playwright/test'
import { login, TARGETS } from './helpers.ts'

const TABLES = 1500

/** Large-schema behaviour: the sidebar must virtualize and stay responsive (PostgreSQL schema, self-cleaning). */
test.describe('sidebar at scale', () => {
  const t = TARGETS[1]
  if (!t) throw new Error('no postgres target')
  const schema = `many_${Date.now().toString(36)}`

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/session', {
      data: {
        dialect: t.dialect,
        host: t.host,
        port: t.port,
        user: t.user,
        password: t.password,
        database: t.database,
      },
    })
    expect(res.ok()).toBe(true)
    const body = Array.from(
      { length: TABLES },
      (_, i) => `CREATE TABLE ${schema}.t_${String(i + 1).padStart(4, '0')} (id int)`
    ).join(';\n')
    const created = await request.post(`/api/databases/${t.database}/sql`, {
      data: { sql: `CREATE SCHEMA ${schema};\n${body}`, timeoutMs: 120_000 },
    })
    expect(created.ok()).toBe(true)
  })

  test.afterAll(async ({ request }) => {
    await request.post(`/api/databases/${t.database}/sql`, { data: { sql: `DROP SCHEMA ${schema} CASCADE` } })
  })

  test(`renders only the visible rows of ${TABLES} tables and filters with a count`, async ({ page }) => {
    await login(page, t)
    await page.goto(`/db/${t.database}?schema=${schema}`)
    await page.getByRole('button', { name: schema, exact: true }).click()
    await expect(page.getByRole('link', { name: 't_0001' })).toBeVisible()
    const rendered = await page.locator('aside a[href*="/table/"]').count()
    expect(rendered).toBeLessThan(120)
    await page.getByLabel('テーブルを絞り込む').fill('t_14')
    await expect(page.getByText('1,500 件中 100 件')).toBeVisible()
    await expect(page.getByRole('link', { name: 't_1400' })).toBeVisible()
    await page.getByLabel('テーブルを絞り込む').fill('t_1499')
    await expect(page.getByText('1,500 件中 1 件')).toBeVisible()
  })
})
