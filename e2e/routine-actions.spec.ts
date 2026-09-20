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

    test('edits a function’s parameters and body, a trigger’s event and an event’s schedule in the create form', async ({
      page,
    }) => {
      test.setTimeout(90_000)
      const id = Date.now().toString(36)
      const fn = `e2e_edit_${id}`
      const table = `e2e_edtt_${id}`
      const trg = `e2e_edtg_${id}`
      const ev = `e2e_edev_${id}`
      const mysql = t.dialect === 'mysql'
      await sql(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, s VARCHAR(20))`)
      await sql(
        page,
        t,
        mysql
          ? `CREATE FUNCTION ${fn}(a INT) RETURNS INT DETERMINISTIC RETURN a + 1`
          : `CREATE FUNCTION ${fn}(a integer) RETURNS integer LANGUAGE sql AS 'SELECT a + 1'`
      )
      await sql(
        page,
        t,
        mysql
          ? `CREATE TRIGGER ${trg} BEFORE INSERT ON ${table} FOR EACH ROW SET NEW.s = 'x'`
          : `CREATE FUNCTION ${trg}_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.s := 'x'; RETURN NEW; END $$`
      )
      if (!mysql)
        await sql(page, t, `CREATE TRIGGER ${trg} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${trg}_fn()`)
      if (mysql)
        await sql(
          page,
          t,
          `CREATE EVENT ${ev} ON SCHEDULE EVERY 1 DAY STARTS '2031-01-01 00:00:00' DISABLE DO SET @e2e = 1`
        )
      try {
        // The function: a second parameter and a new body, through the same form as "create".
        await page.goto(dbUrl(t, '/routines'))
        await page.getByRole('button', { name: `${fn}: 編集`, exact: true }).click()
        const dialog = page.getByRole('dialog')
        await expect(dialog.getByLabel('名前', { exact: true })).toHaveValue(fn)
        await dialog.getByRole('button', { name: /引数を追加/ }).click()
        await dialog.getByLabel('引数 2 の名前').fill('b')
        await dialog.getByLabel('本体').fill(mysql ? 'RETURN a + b' : 'BEGIN RETURN a + b; END')
        if (!mysql) await dialog.getByLabel('言語').selectOption('plpgsql')
        await dialog.getByRole('button', { name: /確認/ }).click()
        await confirmPreview(
          page,
          mysql ? /DROP FUNCTION[\s\S]*CREATE[\s\S]*`b` INT/ : /DROP FUNCTION[\s\S]*CREATE FUNCTION/
        )
        await page.getByRole('button', { name: `${fn}: 編集`, exact: true }).click()
        await expect(page.getByRole('dialog').getByLabel('引数 2 の名前')).toHaveValue('b')
        await page.getByRole('dialog').getByRole('button', { name: 'キャンセル' }).click()

        // The trigger: the event changes from INSERT to UPDATE.
        await page.goto(dbUrl(t, '/triggers'))
        await page.getByRole('button', { name: `${trg}: 編集`, exact: true }).click()
        await page.getByRole('dialog').getByLabel('イベント').selectOption('UPDATE')
        await page.getByRole('dialog').getByRole('button', { name: /確認/ }).click()
        await confirmPreview(page, /DROP TRIGGER[\s\S]*UPDATE/)
        await expect(page.getByRole('row', { name: new RegExp(trg) })).toContainText('UPDATE')

        if (mysql) {
          await page.goto(dbUrl(t, '/events'))
          await page.getByRole('button', { name: `${ev}: 編集`, exact: true }).click()
          await page.getByRole('dialog').getByLabel('間隔').fill('3')
          await page.getByRole('dialog').getByRole('button', { name: /確認/ }).click()
          await confirmPreview(page, /DROP EVENT[\s\S]*EVERY 3 DAY/)
          await expect(page.getByRole('row', { name: new RegExp(ev) })).toContainText('EVERY 3 DAY')
        }
      } finally {
        await sql(page, t, `DROP TABLE IF EXISTS ${table}`)
        if (mysql) await sql(page, t, `DROP EVENT IF EXISTS ${ev}`)
        else await sql(page, t, `DROP FUNCTION IF EXISTS ${trg}_fn()`)
        await sql(page, t, `DROP FUNCTION IF EXISTS ${fn}${mysql ? '' : '(integer)'}`)
        if (!mysql) await sql(page, t, `DROP FUNCTION IF EXISTS ${fn}(integer, integer)`)
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
