import { FakeAdapter } from '@tsmyadmin/adapter/testing'
import type { ConnectRequest } from '@tsmyadmin/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { SqliteSessionStore } from './session/sqlite-store.ts'
import { capture, LOGIN, testConfig } from './test/app-harness.ts'
import { concurrently, countStatuses, fulfilled, widen } from './test/concurrency-harness.ts'

/**
 * Where a test holds an account's authority check: `reached` is called once it has started (so the request has read
 * what it checks against), and the check answers once `until` resolves.
 */
let held: { user: string; reached: () => void; until: Promise<void> } | null = null

/** Plays a server where `root` manages every account and anyone else only the accounts whose name starts like theirs. */
class Authority extends FakeAdapter {
  constructor(private readonly user: string) {
    super()
  }

  override async canManageAccount(name: string): Promise<boolean> {
    if (held?.user === this.user) {
      held.reached()
      await held.until
    }
    return this.user === 'root' || name.startsWith(this.user[0] ?? '')
  }
}

/** Holds `user`'s authority checks until `release` is called; `started` resolves once one has begun. */
function holdAuthority(user: string) {
  let release: () => void = () => undefined
  let reached: () => void = () => undefined
  const started = new Promise<void>((resolve) => {
    reached = resolve
  })
  const until = new Promise<void>((resolve) => {
    release = resolve
  })
  held = { user, reached, until }
  return {
    started,
    release: () => {
      held = null
      release()
    },
  }
}

const stores: SqliteSessionStore[] = []
afterEach(async () => {
  for (const s of stores.splice(0)) await s.closeAll()
})

/** The persistent store (the only one keeping these items on the server), and browsers to sign in with. */
function harness() {
  const store = new SqliteSessionStore({
    path: ':memory:',
    secret: 's'.repeat(32),
    adapterFactory: (config: ConnectRequest) => new Authority(config.user),
    sweepIntervalMs: 0,
  })
  stores.push(store)
  const app = createApp(testConfig(), { store, logger: capture().logger })
  const browser = async (user = LOGIN.user) => {
    const res = await app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...LOGIN, user }),
    })
    const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? ''
    return (path: string, method = 'GET', body?: unknown) =>
      app.request(path, {
        method,
        headers: { 'content-type': 'application/json', cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
  }
  return { store, browser }
}

describe('saved items written at once', () => {
  it('keeps every preference two tabs set at the same moment', async () => {
    const h = harness()
    const send = await h.browser()
    const saved = h.store.savedQueries
    // Every request reads before any of them writes: what a slow store does to a read-then-write.
    widen(saved, ['list', 'save', 'update'])
    const updates = [
      { theme: 'dark' },
      { locale: 'ja' },
      { browseLimit: 50 },
      { navWidth: 300 },
      { sqlEnterRuns: true },
      { confirmDrop: false },
      { consoleDocked: true },
      { saveOnBlur: true },
    ]
    const rs = fulfilled(await concurrently(updates.length, (i) => send('/api/preferences', 'PUT', updates[i])))
    expect(countStatuses(rs)).toEqual({ 200: updates.length })
    // Each tab sent only what it changed; none of them may take another's change away.
    expect(await (await send('/api/preferences')).json()).toEqual(Object.assign({}, ...updates))
  })

  it('keeps every workspace entry and every history entry written at once', async () => {
    const h = harness()
    const send = await h.browser()
    widen(h.store.savedQueries, ['list', 'save', 'update'])
    const n = 12
    fulfilled(
      await concurrently(n, (i) => send('/api/workspace', 'PUT', { set: { [`browse.cols.t${i}`]: [`c${i}`] } }))
    )
    fulfilled(
      await concurrently(n, (i) =>
        send('/api/sql-history', 'POST', { entry: { sql: `SELECT ${i}`, at: i, ok: true }, limit: 100 })
      )
    )
    const workspace = (await (await send('/api/workspace')).json()) as { entries: Record<string, unknown> }
    expect(Object.keys(workspace.entries)).toHaveLength(n)
    const history = (await (await send('/api/sql-history')).json()) as { entries: { sql: string }[] }
    expect(history.entries.map((e) => e.sql).sort()).toEqual(Array.from({ length: n }, (_, i) => `SELECT ${i}`).sort())
  })

  it('gives a shared query name to exactly one account when several claim it at once', async () => {
    const h = harness()
    const browsers = await Promise.all(['root', 'alice', 'bob', 'carol'].map((u) => h.browser(u)))
    widen(h.store.sharedItems, ['list', 'save', 'update'])
    const rs = fulfilled(
      await concurrently(browsers.length, (i) =>
        (browsers[i] ?? expect.fail())('/api/shared-queries', 'POST', { name: 'daily', sql: `SELECT ${i}` })
      )
    )
    // The first claim wins; the rest are told the name is taken rather than writing over it.
    expect(countStatuses(rs)).toEqual({ 200: 1, 409: browsers.length - 1 })
    const listed = (await (await (browsers[0] ?? expect.fail())('/api/shared-queries')).json()) as unknown[]
    expect(listed).toHaveLength(1)
  })

  it('does not let a user group be written over by an account that never had the right over what it replaced', async () => {
    const h = harness()
    const root = await h.browser('root')
    const alice = await h.browser('alice')
    expect((await root('/api/user-groups', 'POST', { name: 'ops', members: ['amy'], hiddenTabs: [] })).status).toBe(200)
    // Alice may manage amy and ann. She has read the group ([amy]) and is checking her right over it when root
    // replaces it with bob, whom she may not manage.
    const gate = holdAuthority('alice')
    const pending = alice('/api/user-groups', 'POST', { name: 'ops', members: ['amy', 'ann'], hiddenTabs: [] })
    await gate.started
    const theirs = await root('/api/user-groups', 'POST', { name: 'ops', members: ['bob'], hiddenTabs: [] })
    gate.release()
    const mine = await pending
    expect(theirs.status).toBe(200)
    // Alice checked her right against [amy]; the group holds [bob] by the time her write arrives, so it is refused.
    expect(mine.status).toBe(409)
    const groups = (await (await root('/api/user-groups')).json()) as { name: string; members: string[] }[]
    expect(groups).toMatchObject([{ name: 'ops', members: ['bob'] }])
  })
})
