import { type APIRequestContext, expect, request } from '@playwright/test'
import { login, TARGETS, test } from './helpers.ts'

const TABLES = 1500

/** Large-schema behaviour: the sidebar must virtualize and stay responsive (PostgreSQL schema, self-cleaning). */
test.describe('sidebar at scale', () => {
  const t = TARGETS[1]
  if (!t) throw new Error('no postgres target')
  const schema = `many_${Date.now().toString(36)}`
  // Hook fixtures get a fresh (logged-out) request context, so setup and teardown each log in through the API.
  const authenticated = async (baseURL: string | undefined): Promise<APIRequestContext> => {
    const api = await request.newContext(baseURL ? { baseURL } : {})
    const res = await api.post('/api/session', {
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
    return api
  }

  test.beforeAll(async ({ baseURL }) => {
    // 1,500 CREATE TABLE statements: the default 30 s hook timeout is too tight on a slow CI runner.
    test.setTimeout(120_000)
    const api = await authenticated(baseURL)
    const body = Array.from(
      { length: TABLES },
      (_, i) => `CREATE TABLE ${schema}.t_${String(i + 1).padStart(4, '0')} (id int)`
    ).join(';\n')
    const created = await api.post(`/api/databases/${t.database}/sql`, {
      data: { sql: `CREATE SCHEMA ${schema};\n${body}`, timeoutMs: 120_000 },
    })
    expect(created.ok()).toBe(true)
    // 200 only means the script ran; every statement must have succeeded.
    const events = (await created.json()) as { kind: string; message?: string }[]
    expect(events.filter((e) => e.kind === 'error').map((e) => e.message)).toEqual([])
    await api.dispose()
  })

  test.afterAll(async ({ baseURL }) => {
    // A fresh login: the setup session may have been evicted or expired by the time the suite ends.
    const api = await authenticated(baseURL)
    const dropped = await api.post(`/api/databases/${t.database}/sql`, {
      data: { sql: `DROP SCHEMA ${schema} CASCADE` },
    })
    expect(dropped.ok()).toBe(true)
    await api.dispose()
  })

  test(`renders only the visible rows of ${TABLES} tables and filters with a count`, async ({ page }) => {
    await login(page, t)
    await page.goto(`/db/${t.database}?schema=${schema}`)
    await page.getByRole('button', { name: `${schema} を展開` }).click()
    const aside = page.locator('aside')
    await expect(aside.getByRole('link', { name: 't_0001' })).toBeVisible()
    const rendered = await aside.locator('a[href*="/table/"]').count()
    expect(rendered).toBeLessThan(120)
    // The aside is the scroll container: scrolling to the bottom must materialise the last rows.
    await aside.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await expect(aside.getByRole('link', { name: 't_1500' })).toBeVisible()
    expect(await aside.locator('a[href*="/table/"]').count()).toBeLessThan(120)
    await aside.evaluate((el) => {
      el.scrollTop = 0
    })
    await page.getByLabel('テーブルを絞り込む').fill('t_14')
    await expect(page.getByText('1,500 件中 100 件')).toBeVisible()
    await expect(aside.getByRole('link', { name: 't_1400' })).toBeVisible()
    await page.getByLabel('テーブルを絞り込む').fill('t_1499')
    await expect(page.getByText('1,500 件中 1 件')).toBeVisible()
  })
})
