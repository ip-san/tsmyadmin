import type { Cell, ColumnTransform } from '@tsmyadmin/shared'
import { isBinaryCell } from '@tsmyadmin/shared'
import { locale } from '@/config/locale.ts'

/** Bytes of a value shown as hex before it is cut (a cell is a glance, not a dump). */
const HEX_MAX_BYTES = 256

const hex = (bytes: Uint8Array) =>
  Array.from(bytes.slice(0, HEX_MAX_BYTES), (b) => b.toString(16).padStart(2, '0')).join('') +
  (bytes.length > HEX_MAX_BYTES ? '…' : '')

const TRUE_WORDS = new Set(['1', 'true', 't', 'yes', 'y', 'on'])
const FALSE_WORDS = new Set(['0', 'false', 'f', 'no', 'n', 'off'])

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/
const pad = (n: number, width = 2) => String(n).padStart(width, '0')

/**
 * A date (`2026-01-02`, `2026-01-02 03:04:05`) or a Unix time (seconds, or milliseconds when it has thirteen digits) as
 * text laid out by `format`: YYYY YY MM M DD D HH H hh h mm ss A, with `[text]` kept as written and everything else
 * (年, /, :) as it is. A date-time is formatted from the parts as written, with no time zone applied; a Unix time is
 * read as UTC.
 */
export function formatDate(text: string, format: string): string | null {
  let parts: [number, number, number, number, number, number] | null = null
  const t = text.trim()
  const match = DATE_TIME.exec(t)
  if (match)
    parts = [+(match[1] ?? 0), +(match[2] ?? 0), +(match[3] ?? 0), +(match[4] ?? 0), +(match[5] ?? 0), +(match[6] ?? 0)]
  else if (/^\d{9,13}$/.test(t)) {
    const d = new Date(t.length >= 13 ? Number(t) : Number(t) * 1000)
    parts = [
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
    ]
  }
  if (!parts) return null
  const [y, mo, d, h, mi, s] = parts
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null
  const twelve = h % 12 === 0 ? 12 : h % 12
  return format.replace(/\[([^\]]*)\]|YYYY|YY|MM|M|DD|D|HH|H|hh|h|mm|ss|A/g, (token, literal: string | undefined) => {
    if (literal !== undefined) return literal
    switch (token) {
      case 'YYYY':
        return pad(y, 4)
      case 'YY':
        return pad(y % 100)
      case 'MM':
        return pad(mo)
      case 'M':
        return String(mo)
      case 'DD':
        return pad(d)
      case 'D':
        return String(d)
      case 'HH':
        return pad(h)
      case 'H':
        return String(h)
      case 'hh':
        return pad(twelve)
      case 'h':
        return String(twelve)
      case 'mm':
        return pad(mi)
      case 'ss':
        return pad(s)
      default:
        return h < 12 ? 'AM' : 'PM'
    }
  })
}

/** A whole number as the four parts of an IPv4 address, or null when it is not one. */
export function ipv4(text: string): string | null {
  if (!/^\d{1,10}$/.test(text.trim())) return null
  const n = Number(text)
  if (n > 0xffff_ffff) return null
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

/**
 * A cell as the text its column's display transformation makes of it, or null when the transformation does not apply
 * to this value (a NULL, or a value of the wrong shape): the caller then shows the plain value. Image, link and JSON
 * draw markup rather than text and are the cell component's own.
 */
export function displayText(t: ColumnTransform, cell: Cell): string | null {
  if (cell === null) return null
  if (t.kind === 'hex') {
    if (isBinaryCell(cell)) {
      try {
        return hex(Uint8Array.from(atob(cell.$bin), (c) => c.charCodeAt(0)))
      } catch {
        return null
      }
    }
    return typeof cell === 'object' ? null : hex(new TextEncoder().encode(String(cell)))
  }
  if (typeof cell === 'object') return null
  const text = String(cell)
  switch (t.kind) {
    case 'substring': {
      const chars = Array.from(text)
      const start = t.start ?? 0
      const length = t.length ?? chars.length
      const part = chars.slice(start, start + length).join('')
      return start + length < chars.length ? `${part}…` : part
    }
    case 'boolean': {
      const word = text.trim().toLowerCase()
      if (TRUE_WORDS.has(word)) return t.trueText || locale.common.yes
      if (FALSE_WORDS.has(word)) return t.falseText || locale.common.no
      return null
    }
    case 'date':
      return formatDate(text, t.format ?? 'YYYY-MM-DD')
    case 'ipv4':
      return ipv4(text)
    case 'affix':
      return `${t.prefix ?? ''}${text}${t.suffix ?? ''}`
    default:
      return null
  }
}

/** What is wrong with a value typed into a form, by the column's input transformation: null when nothing is. */
export function inputProblem(t: ColumnTransform, text: string): 'pattern' | 'json' | 'xml' | null {
  if (text === '') return null
  if (t.kind === 'pattern') {
    try {
      return new RegExp(t.pattern ?? '').test(text) ? null : 'pattern'
    } catch {
      return null
    }
  }
  if (t.kind === 'json-input') {
    try {
      JSON.parse(text)
      return null
    } catch {
      return 'json'
    }
  }
  if (t.kind === 'xml-input') {
    const doc = new DOMParser().parseFromString(text, 'application/xml')
    return doc.getElementsByTagName('parsererror').length > 0 ? 'xml' : null
  }
  return null
}
