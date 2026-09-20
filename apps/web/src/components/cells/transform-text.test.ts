import type { ColumnTransform } from '@tsmyadmin/shared'
import { describe, expect, it } from 'vitest'
import { displayText, formatDate, inputProblem, inputValue, ipv4, ipv4ToInt } from './transform-text.ts'

const t = (over: Partial<ColumnTransform>): ColumnTransform => ({
  database: 'd',
  table: 't',
  column: 'c',
  kind: 'affix',
  id: '',
  at: 0,
  ...over,
})

describe('formatDate', () => {
  it('lays out the parts of a date or date-time as written, with brackets for text kept as is', () => {
    expect(formatDate('2026-01-02 15:04:05', 'YYYY年M月D日 HH:mm:ss')).toBe('2026年1月2日 15:04:05')
    expect(formatDate('2026-01-02', 'YY/MM/DD')).toBe('26/01/02')
    expect(formatDate('2026-01-02T15:04', 'h:mm A [at] H')).toBe('3:04 PM at 15')
    expect(formatDate('2026-01-02 00:30:00', 'hh:mm A')).toBe('12:30 AM')
  })

  it('reads a Unix time (seconds, or milliseconds) as UTC', () => {
    expect(formatDate('1767225600', 'YYYY-MM-DD HH:mm')).toBe('2026-01-01 00:00')
    expect(formatDate('1767225600000', 'YYYY-MM-DD')).toBe('2026-01-01')
  })

  it('gives up on anything that is not a date', () => {
    expect(formatDate('yesterday', 'YYYY')).toBeNull()
    expect(formatDate('2026-13-45', 'YYYY')).toBeNull()
  })
})

describe('displayText', () => {
  it('shows an integer as an IPv4 address', () => {
    expect(ipv4('3232235777')).toBe('192.168.1.1')
    expect(ipv4('4294967296')).toBeNull()
    expect(ipv4('1.2.3.4')).toBeNull()
    expect(displayText(t({ kind: 'ipv4' }), 16909060)).toBe('1.2.3.4')
  })

  it('cuts a part, marking that there was more', () => {
    expect(displayText(t({ kind: 'substring', start: 1, length: 3 }), 'abcdefg')).toBe('bcd…')
    expect(displayText(t({ kind: 'substring', start: 0, length: 10 }), 'あいう')).toBe('あいう')
    expect(displayText(t({ kind: 'substring', start: 1, length: 1 }), '😀😁😂')).toBe('😁…')
  })

  it('reads yes / no words, with the words chosen or the interface language', () => {
    expect(displayText(t({ kind: 'boolean', trueText: 'ON', falseText: 'OFF' }), 1)).toBe('ON')
    expect(displayText(t({ kind: 'boolean', trueText: 'ON', falseText: 'OFF' }), '0')).toBe('OFF')
    expect(displayText(t({ kind: 'boolean' }), true)).toBe('はい')
    expect(displayText(t({ kind: 'boolean' }), 'maybe')).toBeNull()
  })

  it('shows text or bytes as hex, cut at 256 bytes, and puts text around a value', () => {
    expect(displayText(t({ kind: 'hex' }), 'AB')).toBe('4142')
    expect(displayText(t({ kind: 'hex' }), { $bin: 'AQID' })).toBe('010203')
    expect(displayText(t({ kind: 'hex' }), 'x'.repeat(300))?.endsWith('…')).toBe(true)
    expect(displayText(t({ kind: 'affix', prefix: '¥', suffix: '円' }), 100)).toBe('¥100円')
    expect(displayText(t({ kind: 'affix', prefix: '¥' }), null)).toBeNull()
  })
})

describe('inputProblem', () => {
  it('matches a pattern anywhere in the value, and leaves an empty value to NULL / default', () => {
    const pattern = t({ kind: 'pattern', pattern: '^\\d{3}-\\d{4}$' })
    expect(inputProblem(pattern, '123-4567')).toBeNull()
    expect(inputProblem(pattern, '1234567')).toBe('pattern')
    expect(inputProblem(pattern, '')).toBeNull()
    expect(inputProblem(t({ kind: 'pattern', pattern: '(' }), 'x')).toBeNull()
  })

  it('checks that JSON and XML parse', () => {
    expect(inputProblem(t({ kind: 'json-input' }), '{"a": [1]}')).toBeNull()
    expect(inputProblem(t({ kind: 'json-input' }), '{a}')).toBe('json')
    expect(inputProblem(t({ kind: 'xml-input' }), '<a><b/></a>')).toBeNull()
    expect(inputProblem(t({ kind: 'xml-input' }), '<a><b></a>')).toBe('xml')
    expect(inputProblem(t({ kind: 'sql-input' }), 'SELECT (')).toBeNull()
  })
})

describe('ipv4-to-int', () => {
  it('reads a dotted address as the number it stands for', () => {
    expect(ipv4ToInt('192.168.0.1')).toBe(3232235521)
    expect(ipv4ToInt('0.0.0.0')).toBe(0)
    expect(ipv4ToInt('255.255.255.255')).toBe(4294967295)
    expect(ipv4(String(ipv4ToInt('10.1.2.3')))).toBe('10.1.2.3')
  })
  it('keeps a whole number, and refuses the rest', () => {
    expect(ipv4ToInt('3232235521')).toBe(3232235521)
    expect(ipv4ToInt('4294967296')).toBeNull()
    expect(ipv4ToInt('256.0.0.1')).toBeNull()
    expect(ipv4ToInt('1.2.3')).toBeNull()
    expect(ipv4ToInt('a.b.c.d')).toBeNull()
  })
  it('is the value written, and a problem when it does not read', () => {
    const rule = t({ kind: 'ipv4-to-int' })
    expect(inputValue(rule, '127.0.0.1')).toBe('2130706433')
    expect(inputValue(undefined, '127.0.0.1')).toBe('127.0.0.1')
    expect(inputProblem(rule, '127.0.0.1')).toBeNull()
    expect(inputProblem(rule, 'localhost')).toBe('ipv4')
    expect(inputProblem(rule, '')).toBeNull()
  })
})
