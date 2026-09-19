import { expect, type Page } from '@playwright/test'
import { login, PERSISTENT_BASE_URL, TARGETS, type Target, tableUrl, test } from './helpers.ts'

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

const dbUrl = (t: Target, sub: string) => `/db/${t.database}${sub}${t.schema ? `?schema=${t.schema}` : ''}`

/** Define one by hand and take one from a table, then start a new column from each. */
async function exercise(page: Page, t: Target) {
  const table = `e2e_central_${Date.now().toString(36)}`
  await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY)`)
  try {
    await page.goto(dbUrl(t, '/central'))
    const add = page.locator('form').filter({ has: page.getByRole('button', { name: '追加する' }) })
    await add.getByLabel('カラム名').fill('status')
    await add.getByLabel('型', { exact: true }).fill('VARCHAR(20)')
    await add.getByLabel('既定値', { exact: true }).fill('new')
    await add.getByRole('button', { name: '追加する' }).click()
    const list = page.getByRole('table', { name: 'セントラルカラム' })
    await expect(list.getByRole('row', { name: /status/ })).toContainText('VARCHAR(20)')

    // Taken from the fixture table: its definition, not typed again.
    await page.getByLabel('テーブル', { exact: true }).selectOption('users')
    await page.getByRole('checkbox', { name: 'email' }).check()
    await page.getByRole('checkbox', { name: 'name', exact: true }).check()
    await page.getByRole('button', { name: '選んだカラムを取り込む' }).click()
    await expect(list.getByRole('row', { name: /email/ })).toBeVisible()
    await expect(list.getByRole('row', { name: /^name/ })).toBeVisible()

    await page.goto(tableUrl(t, table, '/structure'))
    await page.getByRole('button', { name: 'カラムを追加' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('セントラルカラムから入力').selectOption('status')
    await expect(dialog.getByLabel('カラム名')).toHaveValue('status')
    await expect(dialog.getByLabel('型', { exact: true })).toHaveValue('VARCHAR(20)')
    await dialog.getByRole('button', { name: /SQL を確認|次へ/ }).click()
    await expect(page.getByRole('dialog').getByLabel('SQL')).toContainText(/status.*VARCHAR\(20\).*DEFAULT 'new'/is)
  } finally {
    await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
  }
}

for (const t of TARGETS) {
  test.describe(`central columns (${t.dialect})`, () => {
    test('kept in the browser: define, take from a table, and start a column from one', async ({ page }) => {
      await login(page, t)
      await exercise(page, t)
    })
  })
}

test.describe('central columns kept with the account', () => {
  test.use({ baseURL: PERSISTENT_BASE_URL })
  const t = TARGETS[0] as Target

  test('are stored on the server and removed from there', async ({ page }) => {
    await login(page, t)
    const clear = async () => {
      const all = (await (await page.request.get('/api/central-columns')).json()) as { id: string; database: string }[]
      for (const c of all.filter((x) => x.database === t.database))
        await page.request.delete(`/api/central-columns/${c.id}`)
    }
    await clear()
    try {
      await exercise(page, t)
      const stored = (await (await page.request.get('/api/central-columns')).json()) as { name: string }[]
      expect(stored.map((c) => c.name).sort()).toEqual(['email', 'name', 'status'])
      await page.goto(dbUrl(t, '/central'))
      await page.getByRole('button', { name: 'status: 削除' }).click()
      await expect(page.getByRole('button', { name: 'status: 削除' })).toBeHidden()
      expect(((await (await page.request.get('/api/central-columns')).json()) as unknown[]).length).toBe(2)
    } finally {
      await clear()
    }
  })
})
