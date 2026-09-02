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

describe('pretty format', () => {
  it('quotes strings containing control characters so a request cannot forge log lines', () => {
    const lines: string[] = []
    const logger = createLogger('pretty', (l) => lines.push(l))
    logger.log('info', 'http', { path: '/api/x\nINFO  fake', user: 'plain' })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('path="/api/x\\nINFO  fake"')
    expect(lines[0]).toContain('user=plain')
  })
})

describe('clientIp', () => {
  it('uses the socket address unless a trusted proxy supplies X-Forwarded-For', () => {
    // Appending proxies put the address they saw LAST; anything before it came from the client.
    const spoofed = new Headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.5', 'x-real-ip': '198.51.100.9' })
    expect(clientIp(spoofed, true, '10.0.0.1')).toBe('203.0.113.5')
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.5' }), true, '10.0.0.1')).toBe('203.0.113.5')
    expect(clientIp(spoofed, false, '10.0.0.1')).toBe('10.0.0.1')
    expect(clientIp(new Headers({ 'x-real-ip': '198.51.100.9' }), false, '192.0.2.7')).toBe('192.0.2.7')
    expect(clientIp(new Headers(), true, undefined)).toBe('unknown')
  })
})
