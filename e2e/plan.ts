import type { Page } from '@playwright/test'
import { cleanUp, login, scratchName, sqlOn, type Target } from './helpers.ts'

const JOIN = "SELECT p.title, u.name FROM posts p JOIN users u ON u.id = p.user_id WHERE u.email = 'alice@example.com'"

/** Opens the SQL tab of `t`, types a join of the fixtures and draws its plan (motion reduced: every step shown). */
export async function openPlan(page: Page, t: Target) {
  // The whole story at once: the steps do not move on their own, so what is shown can be checked.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page, t)
  await page.goto(t.schema ? `/db/${t.database}/sql?schema=${t.schema}` : `/db/${t.database}/sql`)
  const editor = page.getByRole('textbox', { name: 'SQL エディタ' })
  await editor.click()
  await page.keyboard.type(JOIN)
  await page.getByRole('button', { name: '図で見る', exact: true }).click()
  const plan = page.getByRole('region', { name: '実行計画', exact: true })
  await plan.getByRole('img', { name: '実行計画で読むテーブルの図' }).waitFor()
  return plan
}

/**
 * A table of its own with a condition on a column no index has, its plan drawn and measured: the plan suggests an
 * index on that column. `drop` takes the table away (and the index with it), and runs even after a failed step.
 */
export async function trialPlan(page: Page, t: Target) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await login(page, t)
  const table = scratchName('e2e_trial')
  const drop = () => cleanUp(page, t, `DROP TABLE IF EXISTS ${table}`)
  await sqlOn(page, t, `CREATE TABLE ${table} (id INT PRIMARY KEY, level INT NOT NULL)`)
  const values = Array.from({ length: 200 }, (_, i) => `(${i + 1}, ${i % 50})`).join(', ')
  await sqlOn(page, t, `INSERT INTO ${table} (id, level) VALUES ${values}`)
  await page.goto(t.schema ? `/db/${t.database}/sql?schema=${t.schema}` : `/db/${t.database}/sql`)
  await page.getByRole('textbox', { name: 'SQL エディタ' }).click()
  await page.keyboard.type(`SELECT id FROM ${table} WHERE level = 3`)
  await page.getByRole('button', { name: '図で見る', exact: true }).click()
  const plan = page.getByRole('region', { name: '実行計画', exact: true })
  await plan.getByRole('button', { name: '実際に実行して測る' }).click()
  await plan.getByRole('button', { name: '実行して測る', exact: true }).click()
  const trial = plan.getByRole('region', { name: 'インデックスを試す' })
  await trial.waitFor()
  return { plan, trial, table, index: `idx_${table}_level`, drop }
}
