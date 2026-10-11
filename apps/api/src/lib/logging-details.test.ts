import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientIp, createLogger, type Logger, requestLogger } from './logging.ts'

/** The details of the log lines: what the access log leaves out, how a line is quoted, and which address counts. */

const pretty = (fields: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info') => {
  const lines: string[] = []
  createLogger('pretty', (l) => lines.push(l)).log(level, 'ev', fields)
  return lines[0] ?? ''
}

describe('createLogger', () => {
  afterEach(() => vi.restoreAllMocks())

  it('writes to the standard output, a line at a time, when no sink is given', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    createLogger('json').log('info', 'started', { port: 1 })
    expect(write).toHaveBeenCalledTimes(1)
    const text = String(write.mock.calls[0]?.[0])
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toMatchObject({ level: 'info', event: 'started', port: 1 })
  })

  it('pads the level to five letters, writes no field part for no fields, and puts a space before the fields', () => {
    expect(pretty({}, 'info')).toMatch(/^\S+ INFO {2}ev$/)
    expect(pretty({}, 'warn')).toMatch(/^\S+ WARN {2}ev$/)
    expect(pretty({}, 'error')).toMatch(/^\S+ ERROR ev$/)
    expect(pretty({ a: 1 })).toMatch(/ ev a=1$/)
    expect(pretty({ a: 1, b: 'x' })).toMatch(/ ev a=1 b=x$/)
  })

  it('writes the other values as JSON, and a string with a control character quoted', () => {
    expect(pretty({ n: 5, o: { k: 1 }, z: null, b: false })).toMatch(/ n=5 o=\{"k":1\} z=null b=false$/)
    expect(pretty({ s: 'with space' })).toMatch(/ s=with space$/)
    expect(pretty({ s: '' })).toMatch(/ s=$/)
    // The first character that counts as a control one is below the space, and the delete character.
    expect(pretty({ s: 'a\u001fb' })).toContain('s="a\\u001fb"')
    expect(pretty({ s: 'a\u0000b' })).toContain('s="a\\u0000b"')
    expect(pretty({ s: 'a\u007fb' })).toContain('s="a\u007fb"')
    expect(pretty({ s: 'a b~' })).toContain('s=a b~')
    expect(pretty({ s: 'tail\n' })).toContain('s="tail\\n"')
    expect(pretty({ s: '\tstart' })).toContain('s="\\tstart"')
  })
})

describe('requestLogger', () => {
  const run = async (path: string, status: number, ip = '9.9.9.9') => {
    const calls: { level: string; event: string; fields: Record<string, unknown> | undefined }[] = []
    const logger: Logger = { log: (level, event, fields) => calls.push({ level, event, fields }) }
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('requestId' as never, 'rid-1' as never)
      await next()
    })
    app.use(
      '*',
      requestLogger(logger, () => ip)
    )
    app.all('*', (c) => c.body(null, status as 200))
    await app.request(path, { method: 'POST' })
    return calls
  }

  it('writes one line per request with the id, method, path, status, time and address', async () => {
    const [call] = await run('/api/x', 200)
    expect(call).toMatchObject({ level: 'info', event: 'http' })
    expect(call?.fields).toMatchObject({
      requestId: 'rid-1',
      method: 'POST',
      path: '/api/x',
      status: 200,
      ip: '9.9.9.9',
    })
    const ms = call?.fields?.ms as number
    expect(Number.isInteger(ms)).toBe(true)
    expect(ms).toBeGreaterThanOrEqual(0)
    expect(ms).toBeLessThan(5000)
  })

  it('logs a server error as an error and anything below 500 as information', async () => {
    expect((await run('/api/x', 500))[0]?.level).toBe('error')
    expect((await run('/api/x', 503))[0]?.level).toBe('error')
    expect((await run('/api/x', 499))[0]?.level).toBe('info')
    expect((await run('/api/x', 404))[0]?.level).toBe('info')
    expect((await run('/api/x', 400))[0]?.level).toBe('info')
  })

  it('leaves out a probe that succeeded, but not one that failed', async () => {
    for (const path of ['/healthz', '/readyz']) {
      expect(await run(path, 200), path).toHaveLength(0)
      expect(await run(path, 204), path).toHaveLength(0)
      expect(await run(path, 301), path).toHaveLength(0)
      expect(await run(path, 399), path).toHaveLength(0)
      expect(await run(path, 400), path).toHaveLength(1)
      expect(await run(path, 503), path).toHaveLength(1)
    }
    expect((await run('/healthz', 503))[0]?.level).toBe('error')
    expect(await run('/healthz/more', 200)).toHaveLength(1)
    expect(await run('/other', 200)).toHaveLength(1)
  })

  it('leaves out a download of a hashed asset that succeeded, but not a failed one or a path that only contains the word', async () => {
    expect(await run('/assets/app.js', 200)).toHaveLength(0)
    expect(await run('/assets/app.js', 304)).toHaveLength(0)
    expect(await run('/assets/app.js', 399)).toHaveLength(0)
    expect(await run('/assets/app.js', 400)).toHaveLength(1)
    expect(await run('/assets/app.js', 404)).toHaveLength(1)
    expect(await run('/assets/app.js', 500)).toHaveLength(1)
    expect(await run('/x/assets/app.js', 200)).toHaveLength(1)
    expect(await run('/assets', 200)).toHaveLength(1)
  })
})

describe('clientIp: which address counts', () => {
  it('takes the Cloudflare address trimmed, only when named, and falls back when it is blank', () => {
    const h = (init: Record<string, string>) => new Headers(init)
    expect(clientIp(h({ 'cf-connecting-ip': '  203.0.113.7  ' }), 'cloudflare', '10.0.0.1')).toBe('203.0.113.7')
    expect(clientIp(h({ 'cf-connecting-ip': '   ' }), 'cloudflare', '10.0.0.1')).toBe('10.0.0.1')
    expect(
      clientIp(h({ 'cf-connecting-ip': '   ', 'x-forwarded-for': '198.51.100.1' }), 'cloudflare', '10.0.0.1')
    ).toBe('198.51.100.1')
    expect(clientIp(h({ 'cf-connecting-ip': '203.0.113.7' }), 'forwarded', '10.0.0.1')).toBe('10.0.0.1')
    expect(clientIp(h({ 'cf-connecting-ip': '203.0.113.7' }), 'none', '10.0.0.1')).toBe('10.0.0.1')
  })

  it('takes the last element of X-Forwarded-For, trimmed, and the socket when it is empty or absent', () => {
    const forwarded = (value: string) => clientIp(new Headers({ 'x-forwarded-for': value }), 'forwarded', '10.0.0.1')
    expect(forwarded('1.1.1.1,  2.2.2.2  ')).toBe('2.2.2.2')
    expect(forwarded('   ')).toBe('10.0.0.1')
    expect(forwarded('1.1.1.1, ')).toBe('10.0.0.1')
    expect(clientIp(new Headers(), 'forwarded', '10.0.0.1')).toBe('10.0.0.1')
    expect(clientIp(new Headers(), 'none', undefined)).toBe('unknown')
    expect(clientIp(new Headers(), 'none', '')).toBe('unknown')
  })

  it('drops a port only from the whole address, in the forms proxies write it', () => {
    const remote = (value: string) => clientIp(new Headers(), 'none', value)
    expect(remote('1.2.3.4:5678')).toBe('1.2.3.4')
    expect(remote('[2001:db8::1]:443')).toBe('2001:db8::1')
    expect(remote('[::1]')).toBe('::1')
    expect(remote('2001:db8::1')).toBe('2001:db8::1')
    expect(remote('2001:db8::1:80')).toBe('2001:db8::1:80')
    expect(remote('a:b:80')).toBe('a:b:80')
    expect(remote('1.2.3.4:80x')).toBe('1.2.3.4:80x')
    expect(remote('junk[::1]:80')).toBe('junk[::1]:80')
    expect(remote('[::1]:80x')).toBe('[::1]:80x')
    expect(remote('[::1]:')).toBe('[::1]:')
    expect(remote('1.2.3.4')).toBe('1.2.3.4')
  })
})
