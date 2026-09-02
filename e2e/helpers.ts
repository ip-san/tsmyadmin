import { expect, type Page } from '@playwright/test'

export interface Target {
  dialect: 'mysql' | 'postgres'
  host: string
  port: number
  user: string
  password: string
  database: string
  /** Sidebar/tab search param for PostgreSQL. */
  schema?: string
}

function fromUrl(dialect: Target['dialect'], url: string, schema?: string): Target {
  const u = new URL(url)
  return {
    dialect,
    host: u.hostname,
    port: Number(u.port),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
    ...(schema ? { schema } : {}),
  }
}

export const TARGETS: Target[] = [
  fromUrl('mysql', process.env.TEST_MYSQL_URL ?? 'mysql://tsmyadmin:tsmyadmin@127.0.0.1:13306/tsmyadmin_test'),
  fromUrl(
    'postgres',
    process.env.TEST_PG_URL ?? 'postgres://tsmyadmin:tsmyadmin@127.0.0.1:15433/tsmyadmin_test',
    'public'
  ),
]

/** Logs in through the UI form (from `/login`, or from the current page when already on a login URL). */
export async function login(page: Page, t: Target, { fromCurrentPage = false } = {}): Promise<void> {
  if (!fromCurrentPage) await page.goto('/login')
  // The E2E server defines presets; switch to manual entry so the helper controls every field.
  await page.getByLabel('接続先').selectOption('')
  await page.getByLabel('サーバー種別').selectOption(t.dialect)
  await page.getByLabel('ホスト').fill(t.host)
  await page.getByLabel('ポート').fill(String(t.port))
  await page.getByLabel('ユーザー名').fill(t.user)
  await page.getByLabel('パスワード').fill(t.password)
  await page.getByLabel('データベース').fill(t.database)
  await page.getByRole('button', { name: '接続' }).click()
  if (!fromCurrentPage) await expect(page.getByRole('heading', { name: 'サーバー' })).toBeVisible()
}

export function tableUrl(t: Target, table: string, sub = ''): string {
  const base = `/db/${t.database}/table/${table}${sub}`
  return t.schema ? `${base}?schema=${t.schema}` : base
}

/** A read-only statement that runs for seconds and can be interrupted (see the adapter conformance fixtures). */
export function slowSql(dialect: Target['dialect']): string {
  if (dialect === 'postgres') return 'SELECT pg_sleep(20)'
  // SLEEP() returns 1 instead of failing when interrupted, and a bare cross join is optimised away,
  // so use a cross join with a WHERE clause that must be evaluated per row.
  const tables = Array.from({ length: 12 }, (_, i) => `users u${i}`).join(', ')
  const cond = Array.from({ length: 12 }, (_, i) => `u${i}.id`).join(' + ')
  return `SELECT COUNT(*) FROM ${tables} WHERE ${cond} > 0`
}

/**
 * Confirms the SQL preview dialog. Irreversible ops (DROP/TRUNCATE TABLE, DROP DATABASE, DROP USER) additionally
 * require retyping the object name; pass it as `confirmName`.
 */
export async function confirmPreview(page: Page, expectSql: RegExp, confirmName?: string): Promise<void> {
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('SQL')).toContainText(expectSql)
  if (confirmName !== undefined) {
    const run = dialog.getByRole('button', { name: '実行する' })
    await expect(run).toBeDisabled()
    await dialog.getByLabel(`続行するには「${confirmName}」と入力してください`).fill(confirmName)
  }
  await dialog.getByRole('button', { name: '実行する' }).click()
  await expect(dialog).toBeHidden()
}
