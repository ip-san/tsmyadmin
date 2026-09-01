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

/** Logs in through the UI form. */
export async function login(page: Page, t: Target): Promise<void> {
  await page.goto('/login')
  // The E2E server defines presets; switch to manual entry so the helper controls every field.
  await page.getByLabel('接続先').selectOption('')
  await page.getByLabel('サーバー種別').selectOption(t.dialect)
  await page.getByLabel('ホスト').fill(t.host)
  await page.getByLabel('ポート').fill(String(t.port))
  await page.getByLabel('ユーザー名').fill(t.user)
  await page.getByLabel('パスワード').fill(t.password)
  await page.getByLabel('データベース').fill(t.database)
  await page.getByRole('button', { name: '接続' }).click()
  await expect(page.getByRole('heading', { name: 'サーバー' })).toBeVisible()
}

export function tableUrl(t: Target, table: string, sub = ''): string {
  const base = `/db/${t.database}/table/${table}${sub}`
  return t.schema ? `${base}?schema=${t.schema}` : base
}
