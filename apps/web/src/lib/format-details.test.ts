import { describe, expect, it } from 'vitest'
import { locale } from '@/config/locale.ts'
import { ApiError } from './api.ts'
import { cellToEditable, cellToText, describeCell, errorMessage, isOpaqueCell } from './format.ts'

/** How a cell is shown and an error is worded (found by mutation testing; see `bun run mutation`). */

describe('describeCell', () => {
  it('counts the bytes of a binary cell from its base64, minus the padding', () => {
    expect(describeCell({ $bin: 'AQID' })).toEqual({ kind: 'binary', bytes: 3 })
    expect(describeCell({ $bin: 'AQI=' })).toEqual({ kind: 'binary', bytes: 2 })
    expect(describeCell({ $bin: 'AQ==' })).toEqual({ kind: 'binary', bytes: 1 })
    expect(describeCell({ $bin: '' })).toEqual({ kind: 'binary', bytes: 0 })
    expect(describeCell({ $bin: 'AQIDBAUG' })).toEqual({ kind: 'binary', bytes: 6 })
    expect(describeCell({ $bin: 'AQIDBAU=' })).toEqual({ kind: 'binary', bytes: 5 })
  })

  it('shows a cut text with its head and full length, and any other value as text', () => {
    expect(describeCell({ $text: 'abc', length: 9 })).toEqual({ kind: 'truncated', text: 'abc', length: 9 })
    expect(describeCell('x')).toEqual({ kind: 'text', text: 'x', empty: false })
    expect(describeCell('')).toEqual({ kind: 'text', text: '', empty: true })
    expect(describeCell(0)).toEqual({ kind: 'text', text: '0', empty: false })
    expect(describeCell(1.5)).toEqual({ kind: 'text', text: '1.5', empty: false })
    expect(describeCell(false)).toEqual({ kind: 'text', text: 'false', empty: false })
    expect(describeCell(true)).toEqual({ kind: 'text', text: 'true', empty: false })
    expect(describeCell(null)).toEqual({ kind: 'null' })
  })

  it('takes a binary or cut cell for one with no complete text to edit', () => {
    expect(isOpaqueCell({ $bin: 'AQ==' })).toBe(true)
    expect(isOpaqueCell({ $text: 'a', length: 2 })).toBe(true)
    for (const plain of ['x', '', 0, false, null]) expect(isOpaqueCell(plain)).toBe(false)
  })
})

describe('cellToText and cellToEditable', () => {
  it('writes each kind of cell the way it is shown, a cut text with its note', () => {
    expect(cellToText(null)).toBe(locale.common.null)
    expect(cellToText({ $bin: 'AQID' })).toBe(locale.common.binary(3))
    expect(cellToText({ $text: 'abc', length: 9 })).toBe(`abc${locale.common.truncatedText(9)}`)
    expect(cellToText('plain')).toBe('plain')
    expect(cellToText(42)).toBe('42')
    expect(cellToText(false)).toBe('false')
    expect(cellToText('')).toBe('')
  })

  it('gives an editor the text of a value, and nothing for NULL, bytes or a cut text', () => {
    expect(cellToEditable('plain')).toBe('plain')
    expect(cellToEditable(42)).toBe('42')
    expect(cellToEditable(true)).toBe('true')
    expect(cellToEditable(0)).toBe('0')
    expect(cellToEditable('')).toBe('')
    expect(cellToEditable(null)).toBe('')
    expect(cellToEditable({ $bin: 'AQID' })).toBe('')
    expect(cellToEditable({ $text: 'abc', length: 9 })).toBe('')
  })
})

describe('errorMessage', () => {
  const base = (code: keyof typeof locale.errors) => locale.errors[code]

  it('calls an error that is no object with a code by its own message, or its text', () => {
    expect(errorMessage(new Error('plain failure'))).toBe('plain failure')
    expect(errorMessage('a string')).toBe('a string')
    expect(errorMessage(null)).toBe('null')
    expect(errorMessage(undefined)).toBe('undefined')
    expect(errorMessage(5)).toBe('5')
    expect(errorMessage({ message: 'only a message' })).toBe('[object Object]')
    expect(errorMessage({ code: 5, message: 'numeric code' })).toBe('[object Object]')
    expect(errorMessage({ code: null })).toBe('[object Object]')
  })

  it('keeps a database message verbatim after the localized code, and its native code in brackets', () => {
    expect(errorMessage({ code: 'QUERY_FAILED', message: 'Duplicate entry' })).toBe(
      `${base('QUERY_FAILED')}: Duplicate entry`
    )
    expect(errorMessage({ code: 'QUERY_FAILED', message: 'm', nativeCode: 'ER_DUP' })).toBe(
      `${base('QUERY_FAILED')}: m [ER_DUP]`
    )
    expect(errorMessage({ code: 'QUERY_FAILED', nativeCode: 'ER_DUP' })).toBe(`${base('QUERY_FAILED')} [ER_DUP]`)
    expect(errorMessage({ code: 'QUERY_FAILED' })).toBe(base('QUERY_FAILED'))
    expect(errorMessage({ code: 'QUERY_FAILED', message: 5 })).toBe(base('QUERY_FAILED'))
    expect(errorMessage({ code: 'QUERY_FAILED', message: 'm', nativeCode: 5 })).toBe(`${base('QUERY_FAILED')}: m`)
  })

  it('prefers the detail the server gave, an empty one meaning there is nothing more to say', () => {
    expect(errorMessage({ code: 'QUERY_FAILED', message: 'short', detail: 'the long one' })).toBe(
      `${base('QUERY_FAILED')}: the long one`
    )
    expect(errorMessage({ code: 'QUERY_FAILED', message: 'short', detail: '' })).toBe(base('QUERY_FAILED'))
    expect(errorMessage({ code: 'QUERY_FAILED', message: 'short', detail: 7 })).toBe(`${base('QUERY_FAILED')}: short`)
  })

  it('leaves out the English echo of a code the localized text says everything about, except a bare upstream status', () => {
    for (const code of [
      'INTERNAL',
      'AUTH_FAILED',
      'UNAUTHENTICATED',
      'RATE_LIMITED',
      'SECOND_FACTOR_REQUIRED',
      'SECOND_FACTOR_INVALID',
      'HOST_NOT_ALLOWED',
      'PAYLOAD_TOO_LARGE',
    ] as const) {
      expect(errorMessage({ code, message: 'English echo' }), code).toBe(base(code))
      expect(errorMessage({ code, message: 'HTTP 502' }), code).toBe(`${base(code)}: HTTP 502`)
    }
    expect(errorMessage({ code: 'INTERNAL', message: 'HTTP 5021' })).toBe(base('INTERNAL'))
    expect(errorMessage({ code: 'INTERNAL', message: 'HTTP 50' })).toBe(base('INTERNAL'))
    expect(errorMessage({ code: 'INTERNAL', message: 'xHTTP 502' })).toBe(base('INTERNAL'))
    expect(errorMessage({ code: 'INTERNAL', message: 'HTTP 502 extra' })).toBe(base('INTERNAL'))
  })

  it('falls back to the internal-error text for a code it does not know, keeping the message', () => {
    expect(errorMessage({ code: 'WEIRD', message: 'something new' })).toBe(`${base('INTERNAL')}: something new`)
    expect(errorMessage({ code: 'WEIRD' })).toBe(base('INTERNAL'))
  })

  it('words why a login failed and what to fix, from the reason a development server named', () => {
    const denied = errorMessage({
      code: 'AUTH_FAILED',
      message: 'Authentication failed',
      reason: 'LOGIN_MYSQL_ACCESS_DENIED',
      params: { user: 'root', from: '172.18.0.1' },
    })
    expect(denied).toBe(locale.reasons.LOGIN_MYSQL_ACCESS_DENIED({ user: 'root', from: '172.18.0.1' }))
    expect(denied).toContain("'root'@'172.18.0.1'")
    // Inside a container, localhost is the container: said only for a loopback address.
    const refused = (loopback: number) =>
      errorMessage({
        code: 'CONNECTION_FAILED',
        reason: 'LOGIN_REFUSED',
        params: { host: loopback ? '127.0.0.1' : 'db', port: 3306, loopback },
      })
    expect(refused(1)).toContain('host.docker.internal')
    expect(refused(0)).not.toContain('host.docker.internal')
    expect(refused(0)).toContain('db:3306')
  })

  it("words a reason the server named in the user's language, with its parameters", () => {
    expect(errorMessage({ code: 'VALIDATION', message: 'm', reason: 'INVALID_ENCODING', params: { line: 7 } })).toBe(
      locale.reasons.INVALID_ENCODING({ line: 7 })
    )
    expect(errorMessage({ code: 'VALIDATION', reason: 'INVALID_ENCODING' })).toBe(locale.reasons.INVALID_ENCODING({}))
    expect(errorMessage({ code: 'VALIDATION', reason: 'INVALID_ENCODING', params: null })).toBe(
      locale.reasons.INVALID_ENCODING({})
    )
    expect(errorMessage({ code: 'VALIDATION', reason: 'INVALID_ENCODING', params: 'text' })).toBe(
      locale.reasons.INVALID_ENCODING({})
    )
    expect(errorMessage({ code: 'VALIDATION', reason: 'INVALID_ENCODING', params: { line: 7 } })).toContain('7')
    expect(errorMessage({ code: 'VALIDATION', reason: 'INVALID_ENCODING' })).toContain('?')
  })

  it('does not take a reason it has no wording for, or one inherited from Object, or one that is no text, for a reason', () => {
    expect(errorMessage({ code: 'VALIDATION', message: 'm', reason: 'NOPE' })).toBe(`${base('VALIDATION')}: m`)
    expect(errorMessage({ code: 'VALIDATION', message: 'm', reason: 'toString' })).toBe(`${base('VALIDATION')}: m`)
    expect(errorMessage({ code: 'VALIDATION', message: 'm', reason: 'constructor' })).toBe(`${base('VALIDATION')}: m`)
    expect(errorMessage({ code: 'VALIDATION', message: 'm', reason: 5 })).toBe(`${base('VALIDATION')}: m`)
    expect(errorMessage({ code: 'VALIDATION', message: 'm', reason: undefined })).toBe(`${base('VALIDATION')}: m`)
  })

  it('reports an unreachable server as a network problem, and a failure with a status as itself', () => {
    expect(errorMessage(new ApiError(0, { code: 'INTERNAL', message: 'fetch failed' }))).toBe(locale.errors.NETWORK)
    expect(errorMessage(new ApiError(502, { code: 'CONNECTION_FAILED', message: 'bad gateway' }))).toBe(
      `${base('CONNECTION_FAILED')}: bad gateway`
    )
    expect(errorMessage(new ApiError(500, { code: 'INTERNAL', message: 'HTTP 500' }))).toBe(
      `${base('INTERNAL')}: HTTP 500`
    )
  })
})
