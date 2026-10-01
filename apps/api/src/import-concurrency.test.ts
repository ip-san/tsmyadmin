import { FakeAdapter } from '@tsmyadmin/adapter/testing'
import { ApiErrorSchema, ImportEventSchema } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { createLogger } from './lib/logging.ts'
import { MemorySessionStore } from './session/store.ts'

const LOGIN = { dialect: 'mysql', host: 'db', port: 3306, user: 'u', password: 'p' }

/** An adapter whose statements wait for the test to say go: an import that is visibly still running. */
class GatedAdapter extends FakeAdapter {
  gate: Promise<void> = Promise.resolve()
  override async executeSql(...args: Parameters<FakeAdapter['executeSql']>) {
    await this.gate
    return super.executeSql(...args)
  }
}

async function harness(max: number) {
  const lines: Record<string, unknown>[] = []
  const adapter = new GatedAdapter()
  const store = new MemorySessionStore({ adapterFactory: () => adapter, sweepIntervalMs: 0 })
  const config = {
    ...loadConfig({}),
    sessionSecret: 's'.repeat(32),
    allowedHosts: ['db'],
    importMaxConcurrent: max,
  }
  const logger = createLogger('json', (l) => lines.push(JSON.parse(l)))
  const app = createApp(config, { store, logger })
  const login = await app.request('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(LOGIN),
  })
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
  const upload = (path = '/api/databases/shop/import', withFile = true) => {
    const fd = new FormData()
    fd.set('format', 'sql')
    if (withFile) fd.set('file', new File(['SELECT 1'], 'x.sql'))
    return app.request(path, { method: 'POST', body: fd, headers: { cookie, origin: 'http://localhost' } })
  }
  const hold = () => {
    let open: () => void = () => undefined
    adapter.gate = new Promise<void>((resolve) => {
      open = resolve
    })
    return open
  }
  const refused = () => lines.filter((l) => l.event === 'import.refused')
  return { store, upload, hold, refused }
}

const lastEvent = async (res: Response) => {
  const lines = (await res.text()).trim().split('\n')
  return ImportEventSchema.parse(JSON.parse(lines.at(-1) ?? ''))
}

describe('imports running at once', () => {
  it('turns the next one away with 429 while the limit is taken, and accepts one again when an import has ended', async () => {
    const h = await harness(1)
    const open = h.hold()
    const first = await h.upload()
    expect(first.status).toBe(200)
    // The first is still running: its answer is a stream nobody has read yet.
    const second = await h.upload()
    expect(second.status).toBe(429)
    expect(second.headers.get('retry-after')).toBe('5')
    expect(ApiErrorSchema.parse(await second.json()).code).toBe('RATE_LIMITED')
    expect(h.refused()).toHaveLength(1)
    expect(h.refused()[0]).toMatchObject({ level: 'warn', active: 1, max: 1 })
    // Let the first one finish; once its answer has been read, there is room again.
    open()
    expect((await lastEvent(first)).type).toBe('result')
    const third = await h.upload()
    expect(third.status).toBe(200)
    await third.text()
    await h.store.closeAll()
  })

  it('applies to the server-level import as well', async () => {
    const h = await harness(1)
    h.hold()
    const first = await h.upload('/api/server/import')
    expect(first.status).toBe(200)
    expect((await h.upload('/api/server/import')).status).toBe(429)
    // One limit for both routes: a database import is turned away while a server import runs.
    expect((await h.upload()).status).toBe(429)
    await first.body?.cancel()
    await h.store.closeAll()
  })

  it('gives the place back when the client goes away before the import finished', async () => {
    const h = await harness(1)
    h.hold()
    const first = await h.upload()
    expect((await h.upload()).status).toBe(429)
    await first.body?.cancel()
    expect((await h.upload()).status).toBe(200)
    await h.store.closeAll()
  })

  it('gives the place back when the request is refused as invalid', async () => {
    const h = await harness(1)
    const noFile = await h.upload('/api/databases/shop/import', false)
    expect(noFile.status).toBe(400)
    await noFile.text()
    const ok = await h.upload()
    expect(ok.status).toBe(200)
    await ok.text()
    await h.store.closeAll()
  })

  it('lets as many through as the limit says', async () => {
    const h = await harness(2)
    h.hold()
    const a = await h.upload()
    const b = await h.upload()
    expect([a.status, b.status]).toEqual([200, 200])
    expect((await h.upload()).status).toBe(429)
    await a.body?.cancel()
    await b.body?.cancel()
    await h.store.closeAll()
  })
})
