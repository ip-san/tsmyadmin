import { expect, type Page } from '@playwright/test'
import { confirmPreview, login, TARGETS, type Target, test } from './helpers.ts'

const dbUrl = (t: Target, sub = '') => {
  const base = `/db/${t.database}${sub}`
  return t.schema ? `${base}?schema=${t.schema}` : base
}

/** Drops what a test created, whatever state it stopped in (the statements tolerate objects that are not there). */
async function cleanUp(page: Page, t: Target, statements: string[]) {
  for (const sql of statements) {
    await page.request
      .post(`/api/databases/${t.database}/sql`, { data: { sql, ...(t.schema ? { schema: t.schema } : {}) } })
      .catch(() => undefined)
  }
}

for (const t of TARGETS) {
  test.describe(`create objects (${t.dialect})`, () => {
    test.beforeEach(async ({ page }) => {
      await login(page, t)
    })

    test('creates a view, a procedure and a trigger from their forms', async ({ page }) => {
      const suffix = Date.now().toString(36)
      const view = `e2e_v_${suffix}`
      const proc = `e2e_p_${suffix}`
      const trigger = `e2e_t_${suffix}`
      const table = `e2e_trg_${suffix}`
      try {
        // A view over a SELECT, from the database structure page.
        await page.goto(dbUrl(t))
        await page.getByText('ビューを作成', { exact: true }).click()
        await page.getByLabel('名前').fill(view)
        await page.getByLabel('SELECT 文').fill('SELECT id, name FROM users')
        await page.getByRole('button', { name: 'ビューを作成: SQL を確認' }).click()
        await confirmPreview(page, /CREATE VIEW/)
        await expect(page.getByRole('link', { name: view, exact: true }).first()).toBeVisible()

        // A procedure whose body holds statements of its own (MySQL needs no DELIMITER from the user).
        await page.goto(dbUrl(t, '/routines'))
        await page.getByText('ルーチンを作成', { exact: true }).click()
        await page.getByLabel('名前').fill(proc)
        await page
          .getByLabel('本体')
          .fill(
            t.dialect === 'mysql'
              ? 'BEGIN\n  SET @e2e = 1;\n  SELECT @e2e;\nEND'
              : "BEGIN\n  RAISE NOTICE 'one';\n  RAISE NOTICE 'two';\nEND"
          )
        await page.getByRole('button', { name: 'ルーチンを作成: SQL を確認' }).click()
        await confirmPreview(page, /CREATE PROCEDURE/)
        await expect(page.getByRole('cell', { name: proc, exact: true })).toBeVisible()

        // A trigger on a table of its own, from that table's trigger tab.
        await cleanUp(page, t, [`CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(20))`])
        const tableTriggers = `/db/${t.database}/table/${table}/triggers${t.schema ? `?schema=${t.schema}` : ''}`
        await page.goto(tableTriggers)
        await page.getByText('トリガーを作成', { exact: true }).click()
        await page.getByLabel('名前').fill(trigger)
        await page
          .getByLabel('本体')
          .fill(
            t.dialect === 'mysql'
              ? 'BEGIN\n  SET NEW.name = UPPER(NEW.name);\nEND'
              : 'BEGIN\n  NEW.name := UPPER(NEW.name);\n  RETURN NEW;\nEND'
          )
        await page.getByRole('button', { name: 'トリガーを作成: SQL を確認' }).click()
        await confirmPreview(page, /CREATE TRIGGER/)
        await expect(page.getByRole('cell', { name: trigger, exact: true })).toBeVisible()
      } finally {
        await cleanUp(page, t, [
          `DROP VIEW IF EXISTS ${view}`,
          `DROP PROCEDURE IF EXISTS ${proc}`,
          `DROP TABLE IF EXISTS ${table}`,
          ...(t.dialect === 'postgres' ? [`DROP FUNCTION IF EXISTS ${trigger}_fn()`] : []),
        ])
      }
    })

    test('creates an event on a schedule (MySQL)', async ({ page }) => {
      test.skip(t.dialect !== 'mysql', 'PostgreSQL has no event scheduler')
      const event = `e2e_ev_${Date.now().toString(36)}`
      try {
        await page.goto(dbUrl(t, '/events'))
        await page.getByText('イベントを作成', { exact: true }).click()
        await page.getByLabel('名前').fill(event)
        await page.getByLabel('有効にする').uncheck()
        await page.getByRole('button', { name: 'イベントを作成: SQL を確認' }).click()
        await confirmPreview(page, /CREATE EVENT .* ON SCHEDULE EVERY 1 DAY/)
        await expect(page.getByRole('cell', { name: event, exact: true })).toBeVisible()
      } finally {
        await cleanUp(page, t, [`DROP EVENT IF EXISTS ${event}`])
      }
    })
  })
}
