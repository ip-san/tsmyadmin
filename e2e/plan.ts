import type { Page } from '@playwright/test'
import { login, type Target } from './helpers.ts'

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
