import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, TARGETS, type Target, tableUrl, test } from './helpers.ts'

const dbUrl = (t: Target, sub = '') => {
  const base = `/db/${t.database}${sub}`
  return t.schema ? `${base}?schema=${t.schema}` : base
}

async function sql(page: Page, t: Target, statement: string) {
  const res = await page.request.post(`/api/databases/${t.database}/sql`, {
    data: { sql: statement, ...(t.schema ? { schema: t.schema } : {}) },
  })
  return res.json()
}

for (const t of TARGETS) {
  test.describe(`routine, trigger and view actions (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('runs a function from a form, changes its characteristics, downloads it and deletes it', async ({ page }) => {
      test.setTimeout(60_000)
      const fn = `e2e_fn_${Date.now().toString(36)}`
      await sql(
        page,
        t,
        t.dialect === 'mysql'
          ? `CREATE FUNCTION ${fn}(a INT) RETURNS INT DETERMINISTIC RETURN a + 1`
          : `CREATE FUNCTION ${fn}(a integer) RETURNS integer LANGUAGE sql AS 'SELECT a + 1'`
      )
      try {
        await page.goto(dbUrl(t, '/routines'))

        await page.getByRole('button', { name: `${fn}: 実行` }).click()
        await page.getByLabel('a (int)').or(page.getByLabel('a (integer)')).fill('41')
        await page.getByRole('button', { name: 'SQL タブで開く' }).click()
        await expect(page).toHaveURL(/\/sql/)
        await expect(page.locator('.cm-content')).toContainText(new RegExp(`SELECT .?${fn}.?\\(41\\)`))

        await page.goto(dbUrl(t, '/routines'))
        await page.getByRole('button', { name: `${fn}: 特性を変更` }).click()
        await page.getByLabel('SQL SECURITY').selectOption('INVOKER')
        await page.getByLabel('コメント').fill('e2e comment')
        await page
          .getByRole('form', { name: `${fn}: 特性を変更` })
          .getByRole('button', { name: 'SQL を確認' })
          .click()
        await confirmPreview(page, t.dialect === 'mysql' ? /SQL SECURITY INVOKER/ : /SECURITY INVOKER/)
        await expect(page.getByRole('cell', { name: 'e2e comment', exact: true })).toBeVisible()

        await page.getByRole('button', { name: `${fn}: 定義を表示` }).click()
        const download = page.waitForEvent('download')
        await page.getByRole('button', { name: 'SQL をダウンロード' }).click()
        expect((await download).suggestedFilename()).toBe(`${fn}.sql`)

        await page.getByRole('button', { name: `${fn}: 削除` }).click()
        await confirmPreview(page, /DROP FUNCTION/)
        await expect(page.getByRole('cell', { name: fn, exact: true })).toHaveCount(0)
      } finally {
        await sql(page, t, `DROP FUNCTION IF EXISTS ${fn}${t.dialect === 'postgres' ? '(integer)' : ''}`).catch(
          () => undefined
        )
      }
    })

    test('deletes a trigger from its list', async ({ page }) => {
      const suffix = Date.now().toString(36)
      const table = `e2e_trgd_${suffix}`
      const trigger = `e2e_td_${suffix}`
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(20))`)
      await sql(
        page,
        t,
        t.dialect === 'mysql'
          ? `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW SET NEW.name = UPPER(NEW.name)`
          : `CREATE FUNCTION ${trigger}_fn() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN NEW.name := UPPER(NEW.name); RETURN NEW; END'; CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${trigger}_fn()`
      )
      try {
        await page.goto(tableUrl(t, table, '/triggers'))
        await page.getByRole('button', { name: `${trigger}: 削除` }).click()
        await confirmPreview(page, /DROP TRIGGER/)
        await expect(page.getByRole('cell', { name: trigger, exact: true })).toHaveCount(0)
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
        if (t.dialect === 'postgres') await sql(page, t, `DROP FUNCTION IF EXISTS ${trigger}_fn()`)
      }
    })

    test('edits a view’s SELECT and options from its operations tab', async ({ page }) => {
      const view = `e2e_ve_${Date.now().toString(36)}`
      await sql(page, t, `CREATE VIEW ${view} AS SELECT id FROM users`)
      try {
        await page.goto(tableUrl(t, view, '/operations'))
        const form = page.getByRole('form', { name: 'ビューの定義を変更' })
        await expect(form.getByLabel('SELECT 文')).toHaveValue(/select/i)
        await expect(form.getByLabel('名前', { exact: true })).toHaveValue(view)
        await form.getByLabel('SELECT 文').fill('SELECT id, name FROM users')
        await form.getByRole('button', { name: 'SQL を確認' }).click()
        await confirmPreview(page, /CREATE OR REPLACE .*VIEW/)
        const structure = await (
          await page.request.get(
            `/api/databases/${t.database}/tables/${view}/structure${t.schema ? `?schema=${t.schema}` : ''}`
          )
        ).json()
        expect(structure.columns.map((c: { name: string }) => c.name)).toEqual(['id', 'name'])
      } finally {
        await sql(page, t, `DROP VIEW IF EXISTS ${view}`)
      }
    })
  })
}
