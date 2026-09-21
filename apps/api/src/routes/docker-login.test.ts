import { FakeAdapter, fakeTable } from '@tsmyadmin/adapter/testing'
import type { ConnectRequest, DiscoveryDiagnosis, ServerPreset } from '@tsmyadmin/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { loadConfig } from '../config.ts'
import { MemorySessionStore } from '../session/store.ts'

const PRESET: ServerPreset = {
  name: 'docker: shop/mysql',
  dialect: 'mysql',
  host: '127.0.0.1',
  port: 13306,
  database: 'shop',
  autoLogin: true,
}
const LOGIN = { user: 'root', password: 'container-secret' }

function harness(withLogin: boolean, diagnose?: () => Promise<DiscoveryDiagnosis>) {
  const seen: ConnectRequest[] = []
  const adapter = new FakeAdapter({ databases: { shop: { tables: { users: fakeTable('users', ['id'], []) } } } })
  const store = new MemorySessionStore({
    adapterFactory: (config) => {
      seen.push(config)
      return adapter
    },
    sweepIntervalMs: 0,
  })
  const app = createApp(
    { ...loadConfig({}), sessionSecret: 'x'.repeat(48), allowedHosts: [] },
    {
      store,
      discover: async () => [PRESET],
      ...(diagnose ? { diagnose } : {}),
      ...(withLogin
        ? { dockerLogin: async (name: string) => (name === PRESET.name ? { preset: PRESET, login: LOGIN } : null) }
        : {}),
    }
  )
  const post = (body: Record<string, unknown>) =>
    app.request('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { app, store, seen, post }
}

const stores: MemorySessionStore[] = []
afterEach(async () => {
  for (const s of stores.splice(0)) await s.closeAll()
})

describe('signing in with a Docker container login', () => {
  it("connects with the container's own login and address, whatever the request says, and never returns the password", async () => {
    const h = harness(true)
    stores.push(h.store)
    const res = await h.post({
      dialect: 'postgres',
      host: 'attacker.example',
      port: 5432,
      user: 'ignored',
      password: 'ignored',
      dockerPreset: PRESET.name,
    })
    expect(res.status).toBe(201)
    expect(h.seen).toHaveLength(1)
    expect(h.seen[0]).toMatchObject({
      dialect: 'mysql',
      host: '127.0.0.1',
      port: 13306,
      user: 'root',
      password: 'container-secret',
      database: 'shop',
    })
    expect(await res.text()).not.toContain('container-secret')
  })

  it('refuses a preset it holds no login for, without connecting', async () => {
    const h = harness(true)
    stores.push(h.store)
    const res = await h.post({
      dialect: 'mysql',
      host: '127.0.0.1',
      port: 13306,
      user: 'u',
      password: 'p',
      dockerPreset: 'docker: other/db',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'VALIDATION' })
    expect(h.seen).toEqual([])
  })

  it('does nothing with a preset name when logins were not switched on', async () => {
    const h = harness(false)
    stores.push(h.store)
    const res = await h.post({
      dialect: 'mysql',
      host: '127.0.0.1',
      port: 13306,
      user: 'u',
      password: 'p',
      dockerPreset: PRESET.name,
    })
    expect(res.status).toBe(400)
    expect(h.seen).toEqual([])
  })

  it('lists the preset with the flag only, and an ordinary login still needs its own password', async () => {
    const h = harness(true)
    stores.push(h.store)
    const list = await (await h.app.request('/api/servers')).text()
    expect(list).toContain('"autoLogin":true')
    expect(list).not.toContain('container-secret')
    const res = await h.post({ dialect: 'mysql', host: '127.0.0.1', port: 13306, user: 'me', password: 'mine' })
    expect(res.status).toBe(201)
    expect(h.seen[0]).toMatchObject({ user: 'me', password: 'mine' })
  })
})

describe('the discovery diagnosis', () => {
  it('says discovery is off when nothing is wired', async () => {
    const h = harness(false)
    stores.push(h.store)
    const res = await h.app.request('/api/servers/diagnosis')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ enabled: false, found: 0, issues: [] })
  })

  it('returns what discovery found out, to someone who is not signed in yet', async () => {
    const diagnosis: DiscoveryDiagnosis = {
      enabled: true,
      connectHost: '127.0.0.1',
      unavailable: null,
      found: 1,
      issues: [{ name: 'docker: shop/pg', dialect: 'postgres', reason: 'notPublished', port: 5432 }],
    }
    const h = harness(false, async () => diagnosis)
    stores.push(h.store)
    const res = await h.app.request('/api/servers/diagnosis')
    expect(await res.json()).toEqual(diagnosis)
  })
})
