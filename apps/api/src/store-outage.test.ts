import { FakeAdapter } from '@tsmyadmin/adapter/testing'
import { ApiErrorSchema } from '@tsmyadmin/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { createLogger } from './lib/logging.ts'
import { MemorySessionStore } from './session/store.ts'

const SECRET = 's'.repeat(32)
const LOGIN = { dialect: 'mysql', host: 'db', port: 3306, user: 'u', password: 'p' }

// What ioredis throws for a command while Redis is down (observed, not invented).
const outage = () =>
  Object.assign(new Error('Reached the max retries per request limit (which is 3).'), {
    name: 'MaxRetriesPerRequestError',
  })

async function harness() {
  const lines: Record<string, unknown>[] = []
  const logger = createLogger('json', (l) => lines.push(JSON.parse(l)))
  const store = new MemorySessionStore({ adapterFactory: () => new FakeAdapter(), sweepIntervalMs: 0 })
  const app = createApp({ ...loadConfig({}), sessionSecret: SECRET, allowedHosts: ['db'] }, { store, logger })
  const login = await app.request('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(LOGIN),
  })
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
  const get = () => app.request('/api/databases', { headers: { cookie } })
  return { store, get, lines, unavailable: () => lines.filter((l) => l.event === 'session_store.unavailable') }
}

describe('a session store that cannot be reached', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }))
  afterEach(() => vi.useRealTimers())

  it('answers 503 STORE_UNAVAILABLE with Retry-After, not an unexplained 500', async () => {
    vi.setSystemTime(new Date('2031-01-01T00:00:00Z'))
    const h = await harness()
    vi.spyOn(h.store, 'get').mockRejectedValue(outage())
    const res = await h.get()
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('5')
    expect(ApiErrorSchema.parse(await res.json()).code).toBe('STORE_UNAVAILABLE')
    await h.store.closeAll()
  })

  it('logs the outage once a minute with how many requests it left out, and never the stack', async () => {
    vi.setSystemTime(new Date('2032-01-01T00:00:00Z'))
    const h = await harness()
    vi.spyOn(h.store, 'get').mockRejectedValue(outage())
    for (let i = 0; i < 5; i++) await h.get()
    expect(h.unavailable()).toHaveLength(1)
    expect(h.unavailable()[0]).toMatchObject({ level: 'error', suppressed: 0 })
    expect(JSON.stringify(h.lines)).not.toContain('stack')
    // A minute later the next failure is logged again and says what was left out in between.
    vi.setSystemTime(new Date('2032-01-01T00:01:01Z'))
    await h.get()
    expect(h.unavailable()).toHaveLength(2)
    expect(h.unavailable()[1]).toMatchObject({ suppressed: 4 })
    await h.store.closeAll()
  })

  it('still reports an ordinary bug as a 500', async () => {
    vi.setSystemTime(new Date('2033-01-01T00:00:00Z'))
    const h = await harness()
    vi.spyOn(h.store, 'get').mockRejectedValue(new Error('a real bug'))
    expect((await h.get()).status).toBe(500)
    expect(h.unavailable()).toHaveLength(0)
    await h.store.closeAll()
  })
})
