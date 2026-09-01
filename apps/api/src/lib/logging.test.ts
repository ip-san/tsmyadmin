import { describe, expect, it } from 'vitest'
import { clientIp, createLogger } from './logging.ts'

describe('createLogger', () => {
  it('writes JSON lines with time/level/event and fields', () => {
    const lines: string[] = []
    createLogger('json', (l) => lines.push(l)).log('warn', 'login.denied', { host: 'evil' })
    const parsed = JSON.parse(lines[0] ?? '{}')
    expect(parsed).toMatchObject({ level: 'warn', event: 'login.denied', host: 'evil' })
    expect(typeof parsed.time).toBe('string')
  })

  it('writes readable lines in pretty mode', () => {
    const lines: string[] = []
    createLogger('pretty', (l) => lines.push(l)).log('info', 'http', { status: 200, path: '/x' })
    expect(lines[0]).toMatch(/INFO {2}http status=200 path=\/x$/)
  })
})

describe('clientIp', () => {
  it('uses X-Forwarded-For only when the proxy is trusted', () => {
    const h = new Headers({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1', 'x-real-ip': '10.0.0.1' })
    expect(clientIp(h, true)).toBe('203.0.113.5')
    expect(clientIp(h, false)).toBe('10.0.0.1')
    expect(clientIp(new Headers(), false)).toBe('unknown')
  })
})
