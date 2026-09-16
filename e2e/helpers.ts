import { test as base, expect, type Page } from '@playwright/test'

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

/**
 * `test` with an automatic logout: contexts are just closed otherwise, and each UI login leaves a server session
 * (with its connection pool) alive until the TTL sweep — dozens per local run with parallel workers.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: Playwright's documented type for an auto fixture without a value
export const test = base.extend<{ autoLogout: void }>({
  autoLogout: [
    async ({ page, baseURL }, use) => {
      // The app navigates by itself after a preview or a login redirect. A goto that starts while such a
      // client-side navigation is in flight is aborted (WebKit reports it as an error, Chromium swallows it):
      // the test's destination is what matters, so it is retried once.
      const goto = page.goto.bind(page)
      page.goto = async (url, options) => {
        try {
          return await goto(url, options)
        } catch (err) {
          if (!String(err).includes('interrupted by another navigation')) throw err
          return await goto(url, options)
        }
      }
      await use()
      // Same-origin Origin header, as a browser would send: the request context sends none by itself.
      await page.request.delete('/api/session', { headers: { origin: baseURL ?? '' } }).catch(() => undefined)
    },
    { auto: true },
  ],
})

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
  // Wait for the form to be on screen before touching it. Playwright will happily set a <select> the moment it
  // exists in the DOM, which can be before React has attached its listener: the change is then lost and the
  // next render puts the controlled value back, leaving the form half-filled and the login silently stuck.
  await page.getByRole('button', { name: '接続' }).waitFor()
  // …and that the preset really switched. Setting a <select> that React has only just rendered can land before
  // the listener does: the DOM changes, the state does not, and the next render puts the old value back — the
  // form then looks half-filled and the login silently never happens.
  const presetSelect = page.getByLabel('接続先')
  await presetSelect.selectOption('')
  await expect(presetSelect).toHaveValue('')
  await page.getByLabel('サーバー種別').selectOption(t.dialect)
  await page.getByLabel('ホスト').fill(t.host)
  await page.getByLabel('ポート').fill(String(t.port))
  await page.getByLabel('ユーザー名').fill(t.user)
  await page.getByLabel('パスワード').fill(t.password)
  await page.getByLabel('データベース').fill(t.database)
  await page.getByRole('button', { name: '接続' }).click()
  // Exact: the login card's own heading is 「サーバーに接続」, which a substring match would satisfy — the
  // helper would then return without having logged in at all, and every later step would fail somewhere else.
  if (!fromCurrentPage) await expect(page.getByRole('heading', { name: 'サーバー', exact: true })).toBeVisible()
}

/**
 * The second E2E server, running on the persistent session store (see playwright.config.ts). Saved queries are
 * kept with the account only where such a store exists, so that spec points itself here.
 */
export const PERSISTENT_BASE_URL = `http://127.0.0.1:${Number(process.env.E2E_PORT ?? 3199) - 1}`

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
