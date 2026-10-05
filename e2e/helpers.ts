import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { test as base, expect, type Locator, type Page } from '@playwright/test'

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

/** Where each test of a coverage run leaves the code it ran (merged by scripts/e2e-coverage.mjs). */
export const E2E_COVERAGE_DIR = 'node_modules/.cache/e2e-coverage'

/**
 * `test` with an automatic logout: contexts are just closed otherwise, and each UI login leaves a server session
 * (with its connection pool) alive until the TTL sweep — dozens per local run with parallel workers. And, when a
 * coverage run asks for it, a record of the app's code the test ran.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: Playwright's documented type for an auto fixture without a value
export const test = base.extend<{ autoLogout: void; webCoverage: void }>({
  // With E2E_COVERAGE set, records which of the app's scripts each Chromium test ran (V8 block coverage). Other
  // browsers have no such API, and a normal run does not pay for it.
  webCoverage: [
    async ({ page, browserName }, use, testInfo) => {
      if (!process.env.E2E_COVERAGE || browserName !== 'chromium') {
        await use()
        return
      }
      const recorded: { file: string | undefined; length: number; functions: unknown }[] = []
      const begin = () => page.coverage.startJSCoverage({ resetOnNavigation: false })
      const collect = async () => {
        for (const e of await page.coverage.stopJSCoverage().catch(() => [])) {
          if (/\/assets\/[^/]+\.js$/.test(new URL(e.url).pathname)) {
            recorded.push({
              file: new URL(e.url).pathname.split('/').pop(),
              length: e.source?.length ?? 0,
              functions: e.functions,
            })
          }
        }
      }
      await begin()
      // A full navigation destroys the page's scripts, and V8 drops what they ran along with them: whatever the
      // page ran is taken out before the test leaves it, or only the last page of a test would be counted.
      for (const method of ['goto', 'reload'] as const) {
        const original = page[method].bind(page) as (...args: unknown[]) => Promise<unknown>
        page[method] = (async (...args: unknown[]) => {
          await collect()
          await begin()
          return original(...args)
        }) as never
      }
      await use()
      await collect()
      await mkdir(E2E_COVERAGE_DIR, { recursive: true })
      await writeFile(`${E2E_COVERAGE_DIR}/${testInfo.testId}-${testInfo.retry}.json`, JSON.stringify(recorded))
    },
    { auto: true },
  ],
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

const LOCK_DIR = 'node_modules/.cache/e2e-locks'

/**
 * A lock shared by every worker, for specs that change the same catalog row: PostgreSQL refuses two concurrent
 * GRANTs on one database with `tuple concurrently updated`, which is the database's answer, not the app's. A lock
 * left by a worker that died is taken over once it is older than any test could hold it.
 */
export async function acquireLock(name: string, staleMs = 120_000): Promise<() => Promise<void>> {
  const path = `${LOCK_DIR}/${name}`
  await mkdir(LOCK_DIR, { recursive: true })
  for (;;) {
    try {
      await mkdir(path)
      return () => rm(path, { recursive: true, force: true })
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err
      const held = await stat(path).catch(() => null)
      if (held && Date.now() - held.mtimeMs > staleMs) await rm(path, { recursive: true, force: true })
      else await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}

/**
 * Serialises the specs that grant and revoke on the fixture database itself — on PostgreSQL only, where they
 * collide. The time spent waiting is added to the test's budget: queueing behind another spec is not slowness.
 */
export function lockDatabaseGrants(dialect: Target['dialect']): void {
  if (dialect !== 'postgres') return
  let release: (() => Promise<void>) | undefined
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires the fixtures argument to be destructured
  test.beforeEach(async ({}, testInfo) => {
    const started = Date.now()
    release = await acquireLock('database-grants')
    testInfo.setTimeout(testInfo.timeout + (Date.now() - started))
  })
  test.afterEach(async () => {
    await release?.()
  })
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
/**
 * The same server by host name: browsers refuse an IP address as a passkey's relying party, so the passkey spec
 * goes through `localhost` (the server's TSMYADMIN_PASSKEY_ORIGIN).
 */
export const PASSKEY_BASE_URL = PERSISTENT_BASE_URL.replace('127.0.0.1', 'localhost')

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

/** Sets a data type such as `VARCHAR(50)`: the name in the dropdown (either dialect's casing), the rest in the field beside it. */
export async function fillType(scope: Page | Locator, dataType: string, row?: number): Promise<void> {
  const [, name = '', rest = ''] = /^([A-Za-z_]+)(.*)$/.exec(dataType) ?? []
  const suffix = row === undefined ? '' : ` ${row}`
  const select = scope.getByLabel(`型${suffix}`, { exact: true })
  const options = await select.locator('option').allTextContents()
  // PostgreSQL lists `integer`, not its alias `INT`.
  const wanted = name.toLowerCase() === 'int' && options.includes('integer') ? 'integer' : name.toLowerCase()
  const label = options.find((o) => o.toLowerCase() === wanted)
  if (!label) throw new Error(`no type option for ${dataType}`)
  await select.selectOption({ label })
  await scope.getByLabel(`長さ・値・属性${suffix}`, { exact: true }).fill(rest)
}
